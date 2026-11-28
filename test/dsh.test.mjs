import assert from 'node:assert/strict';
import test from 'node:test';
import { DshAdapter } from '../src/adapters/dsh.mjs';
import { createToolInvoker } from '../src/mcp/server.mjs';
import { maxWatcherTimeoutMs, validateConfig } from '../src/shared/config.mjs';
import { runDoctor } from '../src/sidecar/doctor.mjs';

const token = 'dsh-collaboration-fixture-token-not-real';
const bridgeToken = 'dsh-bridge-fixture-token-not-real';
const cookie = 'dsh_bridge_auth=' + 'f'.repeat(48);
const original = 'original-fixture';
const activeExecution = original + ':20:7';
const response = result => Response.json({ ok: true, result });

function fixture(target, { auth = false, writes, createResponse } = {}) {
  const id = target + '-host';
  const workspacePath = target === 'win-dsh' ? 'C:\\Fixture\\Team' : '/fixture/team';
  const expectedWorkspace = target === 'win-dsh' ? 'c:/fixture/team/' : '/fixture/team/';
  const config = validateConfig({ dsh: { [target]: {
    baseUrl: 'https://dsh.example.invalid', id, environmentId: 'fixture-environment', token,
    ...(auth && { bridgeToken }), requestTimeoutMs: 500
  } } });
  const tasks = [{ nativeTaskId: original, workspacePath, title: 'Existing fixture', running: false }];
  let state = 'idle';
  const calls = [];
  const fetch = async (url, options) => {
    assert.equal(url.origin, 'https://dsh.example.invalid');
    if (options.method === 'GET') {
      calls.push({ action: 'login' });
      assert.equal(url.pathname, '/');
      assert.equal(url.searchParams.get('auth'), bridgeToken);
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie + '; HttpOnly; SameSite=Strict' } });
    }
    assert.equal(url.pathname, '/api/agent-collaboration');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Collab-Token'], token);
    const { action, input } = JSON.parse(options.body);
    calls.push({ action, input });
    if (auth && options.headers.Cookie !== cookie) return new Response(null, { status: 401 });
    if (action === 'list') return response({ hostId: id, tasks });
    const row = tasks.find(task => task.nativeTaskId === input.nativeTaskId);
    assert.equal(input.workspacePath, row.workspacePath);
    const current = {
      hostId: id, nativeTaskId: row.nativeTaskId, workspacePath: row.workspacePath, title: row.title,
      state: row.nativeTaskId === original ? state : 'idle', independent: true,
      activeExecutionId: row.running ? activeExecution : null, deliveryModes: ['queue', 'steer', 'interrupt'],
      messages: [{ role: 'assistant', completed: true, turnId: '6' }]
    };
    if (action === 'inspect') return response(current);
    if (action === 'conversation') return response({
      ...current, nextCursor: input.cursor ? null : 'older',
      messages: [
        { role: 'system', text: 'hidden system' },
        { role: 'assistant', phase: 'analysis', text: 'hidden reasoning' },
        { role: 'user', text: '[AGY_BRIDGE_OP:fixture-op]\nAuthorization: Bearer mockprivate', operationId: 'native-fixture' },
        { role: 'assistant', text: 'visible answer, password=fixture-secret. ' + token }
      ]
    });
    if (writes) return writes(action, input);
    if (action === 'send') return response({ result: 'accepted', receipt: {
      nativeTaskId: input.nativeTaskId, nativeOperationId: input.operationId
    } });
    if (action === 'interrupt') return response({ result: 'accepted', receipt: { stoppedExecutionId: input.expectedExecutionId } });
    if (action === 'create') {
      const created = { ...current, nativeTaskId: input.sessionId, title: input.title, state: 'idle' };
      tasks.push({ nativeTaskId: input.sessionId, workspacePath: input.workspacePath, title: input.title, running: false });
      return response(createResponse ? createResponse(created) : created);
    }
    assert.fail('unexpected DSH action ' + action);
  };
  const adapter = new DshAdapter(target, config, { fetch });
  return {
    adapter, calls, workspacePath, expectedWorkspace, setState(value) { state = value; tasks[0].running = value !== 'idle'; }
  };
}

async function doctorFixture(timeouts = {}, errors = {}) {
  const env = {};
  const config = validateConfig({ dsh: Object.fromEntries(Object.entries(timeouts).map(([target, requestTimeoutMs]) => [target, {
    baseUrl: 'https://dsh.example.invalid', id: target + '-fixture', environmentId: 'fixture-environment',
    token, bridgeToken, requestTimeoutMs
  }])) }, env);
  const lines = [];
  const lists = [];
  const status = await runDoctor(env, {
    readConfig: actualEnv => {
      assert.equal(actualEnv, env);
      return config;
    },
    adapters: {
      WinCodex: class {
        constructor(actualConfig, options) {
          assert.equal(actualConfig, config);
          assert.equal(options.env, env);
        }
        list(limit) { lists.push(['win-codex', limit]); }
      },
      RemoteCodex: class {
        constructor(actualConfig) { assert.equal(actualConfig.remote.requestTimeoutMs, 8000); }
        list(limit) { lists.push(['101-codex', limit]); }
      },
      DshAdapter: class extends DshAdapter {
        constructor(target, actualConfig) {
          super(target, actualConfig, { fetch: async (_url, options) => {
            assert.deepEqual(JSON.parse(options.body), { action: 'list', input: {} });
            return response({ hostId: target + '-fixture', tasks: [] });
          } });
          assert.deepEqual(actualConfig.dsh, { ...config.dsh, [target]: {
            ...config.dsh[target], requestTimeoutMs: Math.min(8000, timeouts[target])
          } });
        }
        async list(limit) {
          lists.push([this.target, limit, this.endpoint.requestTimeoutMs]);
          if (errors[this.target]) throw errors[this.target];
          return super.list(limit);
        }
      }
    },
    checkMcp: actualEnv => {
      assert.equal(actualEnv, env);
      return 'stdio JSON-RPC fixture';
    },
    write: line => lines.push(line)
  });
  return { status, lines, lists };
}

test('doctor 未配置 DSH 时只执行原有四项检查', async () => {
  const { status, lines, lists } = await doctorFixture();
  assert.equal(status, 0);
  assert.deepEqual(lines, [
    `[通过] Node.js · ${process.versions.node}\n`,
    '[通过] Windows Codex 管道 · 桌面管道可读\n',
    '[通过] 101 SSH 与 Codex Socket · desktop-pipe 会话列表可读\n',
    '[通过] MCP 握手 · stdio JSON-RPC fixture\n'
  ]);
  assert.deepEqual(lists, [['win-codex', 1], ['101-codex', 1]]);
});

test('doctor 只检查已配置的 Windows DSH，并限制请求超时', async () => {
  const { status, lines, lists } = await doctorFixture({ 'win-dsh': 12_000 });
  assert.equal(status, 0);
  assert.deepEqual(lines.slice(4), ['[通过] Windows DSH Bridge · 会话列表可读\n']);
  assert.deepEqual(lists.slice(2), [['win-dsh', 1, 8000]]);
});

test('doctor 检查双端 DSH，失败时退出码为 1 并遮盖凭据', async () => {
  const upstreamCookie = 'fixture-cookie-value';
  const error = new Error(`DSH 连接失败 ${token} ${bridgeToken} ${cookie}\nCookie: session=${upstreamCookie}`);
  const { status, lines, lists } = await doctorFixture({ 'win-dsh': 12_000, '101-dsh': 3000 }, { '101-dsh': error });
  assert.equal(status, 1);
  assert.equal(lines.length, 6);
  assert.equal(lines[4], '[通过] Windows DSH Bridge · 会话列表可读\n');
  assert.match(lines[5], /^\[失败\] 101 DSH Bridge · DSH 连接失败 /);
  assert.deepEqual(lists.slice(2), [['win-dsh', 1, 8000], ['101-dsh', 1, 3000]]);
  const output = lines.join('');
  for (const value of [token, bridgeToken, cookie.split('=')[1], upstreamCookie]) assert.ok(!output.includes(value));
});

test('DSH Bridge 2.10 在明确 401 后交换 Cookie，并按配置查询与复用登录', async () => {
  const f = fixture('win-dsh', { auth: true });
  const list = await f.adapter.list(30);
  assert.equal(list[0].sessionId, original);
  assert.equal(list[0].workspacePath, f.workspacePath);
  f.setState('approval');
  const status = await f.adapter.status(original);
  assert.equal(status.state, 'waiting_approval');
  assert.equal(status.activeTurnId, activeExecution);
  assert.deepEqual(f.calls.map(item => item.action), ['list', 'login', 'list', 'list', 'inspect']);
  const heartbeat = await f.adapter.heartbeat({ sessionIds: [] });
  assert.equal(heartbeat.sessions[0].state, 'waiting_approval');
  assert.equal(heartbeat.catalog.length, 1);
});

test('DSH 通过认证的公开阅读过滤系统、思考、凭据并保留原派发编号', async () => {
  const { adapter, calls } = fixture('101-dsh');
  const page = await adapter.read(original, { maxChars: 1000, limit: 4 });
  assert.deepEqual(page.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(page.messages[0].operationId, 'fixture-op');
  assert.match(page.messages[0].text, /Authorization: \[已遮盖\]/);
  assert.match(page.messages[1].text, /password=\[已遮盖\]/);
  assert.doesNotMatch(JSON.stringify(page), /hidden|mockprivate|fixture-secret/);
  assert.equal(page.messages[1].text.includes(token), false);
  assert.equal(page.nextCursor, 'older');
  assert.equal((await adapter.read(original, { cursor: page.nextCursor, limit: 4 })).nextCursor, null);
  assert.equal(calls.at(-1).input.cursor, 'older');
});

test('DSH 派发和中断校验工作区、轮次和投递方式，心跳保持原生状态', async () => {
  const f = fixture('win-dsh');
  const args = { sessionId: original, expectedWorkspace: f.expectedWorkspace, prompt: 'mock only', operationId: 'fixture-op' };
  assert.equal((await f.adapter.send({ ...args, expectedWorkspace: 'C:\\Wrong' })).reason, 'session_identity_mismatch');
  assert.equal(f.calls.some(call => call.action === 'send'), false);
  const sent = await f.adapter.send(args);
  assert.equal(sent.result, 'accepted');
  assert.equal(sent.beforeTurnId, '6');
  const native = f.calls.at(-1).input;
  assert.match(native.operationId, /^[a-f0-9-]{36}$/);
  assert.equal(native.prompt, '[AGY_BRIDGE_OP:fixture-op]\nmock only');
  assert.equal(native.workspacePath, f.workspacePath);
  f.setState('active');
  assert.equal((await f.adapter.send(args)).reason, 'queue_waiting_for_idle');
  assert.equal((await f.adapter.send({ ...args, mode: 'steer' })).result, 'accepted');
  assert.equal(f.calls.at(-1).input.deliveryMode, 'steer');
  const stop = { sessionId: original, expectedWorkspace: f.expectedWorkspace, expectedTurnId: activeExecution };
  assert.equal((await f.adapter.interrupt({ ...stop, expectedTurnId: 'old' })).reason, 'target_execution_changed');
  assert.equal(f.calls.some(call => call.action === 'interrupt'), false);
  assert.equal((await f.adapter.interrupt(stop)).result, 'accepted');
  assert.equal(f.calls.at(-1).input.expectedExecutionId, activeExecution);
  assert.equal((await f.adapter.heartbeat({ sessionIds: [] })).sessions[0].latestTurn.id, '7');
});

test('DSH 两个端都能新建，校验同工作区锚点和返回的原生身份', async () => {
  for (const target of ['win-dsh', '101-dsh']) {
    const f = fixture(target);
    const args = { workspacePath: f.expectedWorkspace, title: 'New fixture' };
    const empty = await f.adapter.create(args);
    assert.deepEqual(empty, {
      result: 'created', target, sessionId: f.calls.at(-1).input.sessionId, workspacePath: f.workspacePath,
      title: args.title, reminder: '请在原窗口核对新会话的模型、思考强度与审批策略。'
    });
    assert.match(empty.sessionId, /^session-collab-[a-f0-9-]{36}$/);
    assert.equal(f.calls.at(-1).input.nativeTaskId, original);
    assert.deepEqual(Object.keys(f.calls.at(-1).input).sort(), ['nativeTaskId', 'sessionId', 'title', 'workspacePath']);
    const prompted = await f.adapter.create({ ...args, prompt: 'mock first message' });
    assert.equal(prompted.promptDelivery.result, 'accepted');
    assert.equal(f.calls.at(-1).input.nativeTaskId, prompted.sessionId);
    assert.equal((await f.adapter.create({ ...args, workspacePath: '/' })).reason, 'workspace_not_found');
  }
  for (const bad of [{ hostId: 'another-host' }, { nativeTaskId: 'wrong' }, { workspacePath: '/wrong' }, { independent: false }]) {
    const f = fixture('101-dsh', { createResponse: result => ({ ...result, ...bad }) });
    const result = await f.adapter.create({ workspacePath: f.expectedWorkspace, title: 'Fixture' });
    assert.equal(result.result, 'unknown');
    assert.equal(f.calls.filter(call => call.action === 'create').length, 1);
  }
});

test('DSH 写请求中途断开或超时只提交一次，MCP 在 60 秒内阻止相同正文重投', async () => {
  const f = fixture('101-dsh', { writes(action) {
    if (action === 'send') throw new DOMException(token, 'TimeoutError');
    throw new Error(bridgeToken);
  } });
  const invoke = createToolInvoker({ '101-dsh': f.adapter }, { env: {}, post: () => {}, loadState: () => null });
  const args = { target: '101-dsh', sessionId: original, expectedWorkspace: f.expectedWorkspace, prompt: 'sample' };
  const sent = await invoke('bridge_send', args);
  assert.equal(sent.result, 'unknown');
  assert.doesNotMatch(JSON.stringify(sent), new RegExp(token));
  assert.equal((await invoke('bridge_send', args)).reason, 'duplicate_send');
  assert.equal(f.calls.filter(call => call.action === 'send').length, 1);
  f.setState('active');
  const stopped = await invoke('bridge_interrupt', {
    target: args.target, sessionId: args.sessionId, expectedWorkspace: args.expectedWorkspace, expectedTurnId: activeExecution
  });
  assert.equal(stopped.result, 'unknown');
  assert.equal(f.calls.filter(call => call.action === 'interrupt').length, 1);
});

test('DSH 恶意登录重定向无法转交令牌，请求错误也不回显凭据', async () => {
  const target = 'win-dsh';
  const config = validateConfig({ dsh: { [target]: {
    baseUrl: 'https://dsh.example.invalid', id: 'mock', environmentId: 'mock', token, bridgeToken
  } } });
  const methods = [];
  const adapter = new DshAdapter(target, config, { fetch: async (_, options) => {
    methods.push(options.method);
    return options.method === 'POST' ? new Response(null, { status: 401 })
      : new Response(null, { status: 302, headers: { Location: 'https://outside.invalid/', 'Set-Cookie': cookie } });
  } });
  await assert.rejects(adapter.list(20), error => {
    assert.equal(error.code, 'DSH_BRIDGE_AUTH_FAILED');
    assert.doesNotMatch(error.message, new RegExp(bridgeToken));
    return true;
  });
  assert.deepEqual(methods, ['POST', 'GET']);
  for (const config of [{ dsh: { [target]: { token: 'short' } } }, { remote: { watcherTimeoutMs: maxWatcherTimeoutMs + 1 } }]) {
    assert.throws(() => validateConfig(config), { code: 'INVALID_CONFIG' });
  }
});

test('MCP 全部目标忽略未配置 DSH 及残留缓存，显式调用返回对应代码', async () => {
  const codex = { list: async () => [] };
  const f = fixture('101-dsh');
  const invoke = createToolInvoker({ 'win-codex': codex, '101-codex': codex, '101-dsh': f.adapter }, {
    env: {},
    loadState: () => ({ targets: { 'win-dsh': { catalog: { sessions: [{ sessionId: 'old' }] } } } }), post: () => {}
  });
  const all = await invoke('bridge_list', { target: 'all', fresh: true });
  assert.deepEqual(Object.keys(all.targets), ['win-codex', '101-codex', '101-dsh']);
  const explicit = await invoke('bridge_list', { target: 'win-dsh' });
  assert.equal(explicit.targets['win-dsh'].reachable, false);
  assert.equal(explicit.targets['win-dsh'].error.code, 'DSH_NOT_CONFIGURED');
  await assert.rejects(invoke('bridge_status', { target: 'win-dsh', sessionId: original }), { code: 'DSH_NOT_CONFIGURED' });
});
