import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createAdapters } from '../adapters/targets.mjs';
import { startRemoteWatcher } from '../adapters/remote-watcher.mjs';
import { readConfig } from '../shared/config.mjs';
import { BridgeError, errorDetails } from '../shared/errors.mjs';
import { cachedCatalog, postSidecar, readLocalJson } from '../shared/bridge-cache.mjs';
import { latestQuota } from '../sidecar/snapshot.mjs';
import { dshTargets, toolTargets } from '../shared/targets.mjs';
import { validHostId } from '../shared/pairing.mjs';

const versions = ['2025-11-25', '2025-03-26', '2024-11-05'];
const targetNames = toolTargets;
const unconfiguredDsh = () => new BridgeError('DSH_NOT_CONFIGURED', '该 DSH 目标未配置。');
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const number = (maximum, defaultValue) => ({ type: 'integer', minimum: 1, maximum, default: defaultValue });
const target = { type: 'string', enum: targetNames };
const sessionId = text(200);
const session = { target, sessionId };
const sessionKeys = ['target', 'sessionId'];
const writeSession = { ...session, expectedWorkspace: { ...text(4096), description: '目标会话预期的绝对工作区路径。' } };
const writeSessionKeys = [...sessionKeys, 'expectedWorkspace'];
const toolDefinition = (name, description, properties, required, readOnlyHint) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint }
});

const toolDefinitions = [
  toolDefinition('bridge_list', '列出已配置目标的原生会话，fresh=true 时实时探测。', {
    target: { type: 'string', enum: ['all', ...targetNames], default: 'all' },
    fresh: { type: 'boolean' }, limit: number(100, 30)
  }, [], true),
  toolDefinition('bridge_status', '实时查看指定会话状态、当前轮次和待审批标记。', session, sessionKeys, true),
  toolDefinition('bridge_read', '分页读取原会话的公开问答。派发回执未知时，用 operationId 核对历史。', {
    ...session, cursor: text(16_384), limit: number(20, 3), maxChars: number(24_000, 12_000)
  }, sessionKeys, true),
  toolDefinition('bridge_send', '向现有原生会话提交一次消息。收到 unknown 时先核对原会话。', {
    ...writeSession, prompt: text(128_000),
    mode: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
    operationId: { ...text(128), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' },
    notifyOnFinish: { type: 'boolean' },
    autoReadOnFinish: { type: 'boolean', description: '用户明确授权时，为本会话开启完成后自动读取。' }
  }, [...writeSessionKeys, 'prompt'], false),
  toolDefinition('bridge_interrupt', '在显式 101 daemon 或已配置 DSH 中中断与 expectedTurnId 匹配的当前轮次。', {
    ...writeSession, expectedTurnId: text(200)
  }, [...writeSessionKeys, 'expectedTurnId'], false),
  toolDefinition('bridge_create', '在指定工作区新建原生会话，可提供首条消息。', {
    target, workspacePath: text(4096), title: text(512), prompt: text(128_000)
  }, ['target', 'workspacePath', 'title'], false)
];
const toolsByName = new Map(toolDefinitions.map(tool => [tool.name, tool]));
const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function validValue(value, schema) {
  if (!schema) return false;
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'string') {
    return typeof value === 'string' && Boolean(value.trim()) && value.length <= schema.maxLength
      && (!schema.pattern || new RegExp(schema.pattern).test(value));
  }
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  return typeof value === schema.type;
}

function validateArgs(tool, args) {
  const { properties, required } = tool.inputSchema;
  if (!isObject(args) || required.some(key => !Object.hasOwn(args, key))
      || Object.entries(args).some(([key, value]) => !Object.hasOwn(properties, key) || !validValue(value, properties[key]))) {
    throw new BridgeError('INVALID_ARGUMENTS', '请按工具定义提供参数。');
  }
}

export function createToolInvoker(adapters, {
  clock = Date.now, loadState = () => readLocalJson('state.json'), post = postSidecar, launchWatcher, env = process.env
} = {}) {
  const recentSends = new Map();
  const load = () => Promise.resolve().then(loadState).catch(() => null);
  const notify = (route, body) => { void Promise.resolve().then(() => post(route, body)).catch(() => {}); };
  const host = {
    ...(validHostId(env.ANTIGRAVITY_CONVERSATION_ID) && { conversationId: env.ANTIGRAVITY_CONVERSATION_ID }),
    ...(validHostId(env.ANTIGRAVITY_PROJECT_ID) && { projectId: env.ANTIGRAVITY_PROJECT_ID })
  };

  async function list(args) {
    const selected = !args.target || args.target === 'all'
      ? targetNames.filter(id => !dshTargets.includes(id) || adapters[id]) : [args.target];
    const snapshot = await load();
    const now = clock();
    const live = {};
    const entries = await Promise.all(selected.map(async id => {
      if (dshTargets.includes(id) && !adapters[id]) {
        return [id, { reachable: false, error: errorDetails(unconfiguredDsh()), sessions: [] }, 0, false];
      }
      const cached = cachedCatalog(snapshot, id, now);
      const limit = args.limit ?? 30;
      const fromCache = value => ({ ...value, sessions: value.sessions.slice(0, limit) });
      if (!args.fresh && cached && !cached.stale) return [id, fromCache(cached.value), cached.age, false];
      try {
        const value = { reachable: true, sessions: await adapters[id].list(limit) };
        live[id] = value;
        return [id, value, 0, false];
      } catch (error) {
        const failure = { reachable: false, error: errorDetails(error), sessions: [] };
        if (cached) return [id, { ...fromCache(cached.value), reachable: false, error: failure.error }, cached.age, true];
        return [id, failure, 0, false];
      }
    }));
    if (Object.keys(live).length) {
      const update = { sampledAt: new Date(clock()).toISOString(), targets: live };
      await Promise.resolve().then(() => post('/api/catalog', update)).catch(() => {});
    }
    const cacheAgeMs = Math.max(...entries.map(entry => entry[2]));
    return {
      sampledAt: new Date(now - cacheAgeMs).toISOString(), cacheAgeMs, stale: entries.some(entry => entry[3]),
      targets: Object.fromEntries(entries.map(([id, value]) => [id, value]))
    };
  }

  async function send(adapter, args) {
    const now = clock();
    for (const [key, value] of recentSends) if (value.expiresAt <= now) recentSends.delete(key);
    const key = createHash('sha256').update(JSON.stringify([args.target, args.sessionId, args.prompt])).digest('hex');
    const prior = recentSends.get(key);
    if (prior) return { result: 'not_sent', reason: 'duplicate_send', operationId: prior.operationId };
    const operationId = args.operationId ?? randomUUID();
    const mode = args.mode ?? 'queue';
    const guard = { operationId, expiresAt: Infinity };
    recentSends.set(key, guard);
    try {
      const result = await adapter.send({
        sessionId: args.sessionId, expectedWorkspace: args.expectedWorkspace, prompt: args.prompt, mode, operationId
      });
      if (result.result === 'not_sent') recentSends.delete(key);
      if (result.result === 'accepted') notify('/api/nudge', {
        action: 'send', target: args.target, sessionId: args.sessionId, workspacePath: args.expectedWorkspace,
        mode, turnId: result.turnId, beforeTurnId: result.beforeTurnId,
        ...host,
        ...(args.autoReadOnFinish !== undefined && { autoReadOnFinish: args.autoReadOnFinish })
      });
      if (result.result === 'accepted' && args.target === '101-codex' && args.notifyOnFinish === true) {
        let watcher = { started: false, reason: 'watcher_launch_failed' };
        try {
          if (launchWatcher) watcher = await launchWatcher({
            sessionId: args.sessionId, expectedWorkspace: args.expectedWorkspace, operationId,
            turnId: result.turnId, beforeTurnId: result.beforeTurnId
          });
        } catch { /* the accepted native receipt remains valid */ }
        return { ...result, notifyWatcher: watcher };
      }
      return result;
    } finally {
      guard.expiresAt = clock() + 60_000;
    }
  }

  return async function invokeTool(name, args) {
    if (name === 'bridge_list') return list(args);
    const adapter = adapters[args.target];
    if (!adapter && dshTargets.includes(args.target)) throw unconfiguredDsh();
    if (name === 'bridge_create') {
      const result = await adapter.create({ workspacePath: args.workspacePath, title: args.title, prompt: args.prompt });
      if (result.result === 'created') {
        const started = args.prompt !== undefined && (result.promptDelivery === undefined || result.promptDelivery.result === 'accepted');
        notify('/api/nudge', {
          action: 'create', target: args.target, sessionId: result.sessionId, workspacePath: result.workspacePath,
          ...host,
          ...(started && { tracking: true, turnId: result.promptDelivery?.turnId, beforeTurnId: result.promptDelivery?.beforeTurnId })
        });
      }
      return result;
    }
    if (name === 'bridge_status') {
      let status;
      try {
        status = await adapter.status(args.sessionId);
      } catch (error) {
        if (!['PIPE_UNAVAILABLE', 'SSH_UNREACHABLE', 'NATIVE_DISCONNECTED', 'NATIVE_TIMEOUT',
          'DSH_UNAUTHORIZED', 'DSH_BRIDGE_AUTH_FAILED', 'DSH_PLUGIN_NOT_LOADED'].includes(error.code)) throw error;
        status = {
          target: args.target, sessionId: args.sessionId, state: 'offline', latestTurn: null,
          activeTurnId: null, activeFlags: [], title: null, workspacePath: null, updatedAt: null, error: errorDetails(error)
        };
      }
      const rateLimits = latestQuota(await load(), args.target, clock());
      return rateLimits ? { ...status, rateLimits } : status;
    }
    if (name === 'bridge_read') {
      const result = await adapter.read(args.sessionId, args);
      if (Array.isArray(result?.messages) && result.messages.length) {
        const turnId = result.messages.findLast(message => typeof message?.turnId === 'string' && message.turnId)?.turnId;
        notify('/api/nudge', { action: 'read', target: args.target, sessionId: args.sessionId, ...(turnId && { turnId }) });
      }
      return result;
    }
    if (name === 'bridge_interrupt') {
      const result = await adapter.interrupt(args);
      if (result.result === 'accepted') notify('/api/nudge', {
        action: 'interrupt', target: args.target, sessionId: args.sessionId, turnId: result.turnId
      });
      return result;
    }
    return send(adapter, args);
  };
}

export async function serve(adapters, { input = process.stdin, output = process.stdout, ...options } = {}) {
  const invokeTool = createToolInvoker(adapters, options);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const tasks = new Set();
  let version;
  let ready = false;
  const respond = (id, body) => ({ jsonrpc: '2.0', id, ...body });
  const error = (id, code, message) => respond(id, { error: { code, message } });

  async function handle(request) {
    if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
        || (Object.hasOwn(request, 'id') && typeof request.id !== 'string' && !Number.isSafeInteger(request.id))) {
      return error(null, -32600, 'Invalid Request');
    }
    const { id, method, params } = request;
    // A notification with a write method never runs a tool.
    if (id === undefined) {
      if (method === 'notifications/initialized' && version) ready = true;
      return;
    }
    if (method === 'initialize') {
      if (version || typeof params?.protocolVersion !== 'string') {
        return error(id, -32602, 'Invalid initialization parameters');
      }
      version = versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0];
      return respond(id, { result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'agy-native-bridge', version: '0.1.0' } } });
    }
    if (method === 'ping') return respond(id, { result: {} });
    if (!ready) return error(id, -32002, 'Server not initialized');
    if (method === 'tools/list') return respond(id, { result: { tools: toolDefinitions } });
    if (method !== 'tools/call') return error(id, -32601, 'Method not found');
    const tool = toolsByName.get(params?.name);
    if (!tool) return error(id, -32602, 'Unknown tool');
    let value;
    let isError = false;
    try {
      const args = params.arguments === undefined ? {} : params.arguments;
      validateArgs(tool, args);
      value = await invokeTool(tool.name, args);
    } catch (cause) {
      value = { error: errorDetails(cause) };
      isError = true;
    }
    return respond(id, {
      result: {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        ...(version === '2025-11-25' && { structuredContent: value }),
        ...(isError && { isError })
      }
    });
  }

  async function handleLine(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return error(null, -32700, 'Parse error');
    }
    if (!Array.isArray(request)) return handle(request);
    if (version !== '2025-03-26' || request.length === 0) return error(null, -32600, 'Invalid Request');
    const replies = (await Promise.all(request.map(handle))).filter(Boolean);
    return replies.length ? replies : undefined;
  }

  for await (const line of lines) {
    if (!line.trim()) continue;
    const task = handleLine(line).then(response => {
      if (response) output.write(JSON.stringify(response) + '\n');
    });
    tasks.add(task);
    task.then(() => tasks.delete(task), () => tasks.delete(task));
  }
  await Promise.all(tasks);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const config = await readConfig();
    await serve(createAdapters(config), { launchWatcher: input => startRemoteWatcher(config.remote, input) });
  } catch (error) {
    process.stderr.write(errorDetails(error).message + '\n');
    process.exitCode = 1;
  }
}
