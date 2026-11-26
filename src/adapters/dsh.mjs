import { createHash, randomUUID } from 'node:crypto';
import { formatConversation, publicMessage } from '../shared/conversation.mjs';
import { createdSession, creationFailure, matchesWorkspace } from '../shared/creation.mjs';
import { BridgeError, notSent, preflightFailure, unknownOutcome } from '../shared/errors.mjs';
import { checkIdentity, sendBlocked, sessionView, uuidPattern, withLatest, workspaceKey } from '../shared/state.mjs';

const actions = new Set(['list', 'inspect', 'conversation', 'create', 'send', 'interrupt']);
const mismatch = () => new BridgeError('SESSION_IDENTITY_MISMATCH', 'DSH 会话、主机或工作区与目标不符。');
const invalid = () => new BridgeError('DSH_INVALID_RESPONSE', 'DSH Bridge 回执格式有误。');

function nativeRequestId(target, sessionId, operationId) {
  if (uuidPattern.test(operationId)) return operationId;
  const bytes = createHash('sha256').update(JSON.stringify([target, sessionId, operationId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function latestTurn(view) {
  if (typeof view.latestTurn?.id === 'string' && typeof view.latestTurn.status === 'string') {
    return { id: view.latestTurn.id, status: view.latestTurn.status };
  }
  if (typeof view.activeExecutionId === 'string' && view.activeExecutionId) {
    const ordinal = /:\d+:(\d+)$/.exec(view.activeExecutionId)?.[1];
    return { id: ordinal ?? view.activeExecutionId, status: 'inProgress' };
  }
  const final = Array.isArray(view.messages) && view.messages.findLast(message => message?.role === 'assistant'
    && message.completed === true && typeof message.turnId === 'string');
  return final ? { id: final.turnId, status: 'completed' } : null;
}

function toPublicMessage(row, conceal) {
  if (!['user', 'assistant'].includes(row?.role) || typeof row.text !== 'string') return null;
  const user = row.role === 'user';
  return publicMessage({
    turnId: row.turnId,
    item: {
      id: row.id, type: user ? 'userMessage' : 'agentMessage', truncated: row.truncated === true,
      ...(user ? {
        clientId: row.text.startsWith('[AGY_BRIDGE_OP:') ? undefined : row.operationId,
        content: [{ type: 'text', text: conceal(row.text) }]
      }
        : { text: conceal(row.text), phase: row.phase ?? (row.completed ? 'final_answer' : 'commentary') })
    }
  });
}

export class DshAdapter {
  constructor(target, config, { fetch = globalThis.fetch } = {}) {
    this.target = target;
    this.endpoint = config.dsh[target];
    this.workspaces = config.workspaces[target] ?? {};
    this.fetch = fetch;
    this.cookie = undefined;
    this.login = undefined;
  }

  async exchangeCookie() {
    this.login ??= (async () => {
      const { baseUrl, bridgeToken, requestTimeoutMs } = this.endpoint;
      const url = new URL('/', baseUrl);
      url.searchParams.set('auth', bridgeToken);
      try {
        const response = await this.fetch(url, {
          method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(requestTimeoutMs)
        });
        const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)(dsh_bridge_auth=[a-f0-9]{48})(?:;|$)/i)?.[1];
        if (response.status !== 302 || response.headers.get('location') !== '/' || !cookie) throw invalid();
        this.cookie = cookie;
        return cookie;
      } catch {
        throw new BridgeError('DSH_BRIDGE_AUTH_FAILED', 'DSH Bridge 访问令牌无法建立会话。');
      }
    })().finally(() => { this.login = undefined; });
    return this.login;
  }

  async call(action, input = {}) {
    if (!actions.has(action)) throw new BridgeError('NATIVE_TOOL_UNAVAILABLE', 'DSH 不支持此桥接操作。');
    const { baseUrl, token, bridgeToken, requestTimeoutMs } = this.endpoint;
    const body = JSON.stringify({ action, input });
    if (Buffer.byteLength(body) > 128 * 1024) throw new BridgeError('DSH_REQUEST_TOO_LARGE', 'DSH 请求超过 128 KiB。');
    const post = async cookie => {
      try {
        return await this.fetch(new URL('/api/agent-collaboration', baseUrl), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
          headers: { 'Content-Type': 'application/json', 'X-Collab-Token': token, ...(cookie && { Cookie: cookie }) }, body
        });
      } catch (error) {
        if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new BridgeError('NATIVE_TIMEOUT', 'DSH Bridge 请求超时。');
        throw new BridgeError('NATIVE_DISCONNECTED', 'DSH Bridge 连接中断。');
      }
    };
    const used = this.cookie;
    let response = await post(used);
    // A definite authentication rejection happens before the collaboration action.
    if (response.status === 401 && bridgeToken) {
      const cookie = this.cookie && this.cookie !== used ? this.cookie : await this.exchangeCookie();
      response = await post(cookie);
    }
    if (response.status === 401) throw new BridgeError('DSH_UNAUTHORIZED', 'DSH 协作插件连接未授权。');
    if (response.status === 404) throw new BridgeError('DSH_PLUGIN_NOT_LOADED', 'DSH 协作插件路由未加载。');
    let envelope;
    try { envelope = await response.json(); } catch { throw invalid(); }
    if (!response.ok || envelope?.ok !== true) {
      const rejected = new BridgeError('DSH_REJECTED', 'DSH Bridge 拒绝了请求。');
      if (envelope?.error?.code === 'BINDING_MISMATCH') throw mismatch();
      throw rejected;
    }
    if (!envelope.result || typeof envelope.result !== 'object') throw invalid();
    return envelope.result;
  }

  checkHost(value) {
    if (value?.hostId !== this.endpoint.id
        || (value.environmentId !== undefined && value.environmentId !== this.endpoint.environmentId)) throw mismatch();
  }

  conceal(text) {
    if (typeof text !== 'string') return text;
    const credentials = [this.endpoint.token, this.endpoint.bridgeToken, this.cookie?.split('=')[1]];
    for (const value of credentials) {
      if (value) text = text.replaceAll(value, '[已遮盖]');
    }
    return text;
  }

  async directory() {
    const result = await this.call('list');
    this.checkHost(result);
    if (!Array.isArray(result.tasks)) throw invalid();
    return result.tasks.filter(task => typeof task?.nativeTaskId === 'string' && task.nativeTaskId
      && workspaceKey(this.target, task.workspacePath));
  }

  identity(sessionId, tasks, expectedWorkspace) {
    const candidates = tasks.filter(task => task.nativeTaskId === sessionId);
    if (candidates.length !== 1) throw mismatch();
    const task = candidates[0];
    const identity = { id: task.nativeTaskId, cwd: task.workspacePath };
    const pinned = Object.hasOwn(this.workspaces, sessionId) ? this.workspaces[sessionId] : undefined;
    checkIdentity(this.target, identity, sessionId, pinned, expectedWorkspace);
    return { nativeTaskId: sessionId, workspacePath: task.workspacePath };
  }

  checkSession(view, identity, independent = true) {
    this.checkHost(view);
    checkIdentity(this.target, { id: view.nativeTaskId, cwd: view.workspacePath }, identity.nativeTaskId, identity.workspacePath);
    if (independent && view.independent !== true) throw mismatch();
  }

  view(row, identity) {
    const approval = row.state === 'approval' || row.state === 'waiting_approval' || row.approvalCount > 0;
    const latest = latestTurn(row);
    const thread = {
      id: identity.nativeTaskId, cwd: identity.workspacePath, title: this.conceal(row.title),
      status: { type: row.state, activeFlags: approval ? ['waitingOnApproval'] : [] },
      activeTurnId: row.activeExecutionId, updatedAt: row.updatedAt ?? row.createdAt
    };
    return { ...withLatest(sessionView(this.target, thread, null, approval), latest), activeTurnId: row.activeExecutionId ?? null };
  }

  async inspect(sessionId, expectedWorkspace, tasks) {
    const identity = this.identity(sessionId, tasks ?? await this.directory(), expectedWorkspace);
    const result = await this.call('inspect', identity);
    this.checkSession(result, identity);
    return { identity, status: this.view(result, identity), deliveryModes: result.deliveryModes };
  }

  listed(task) {
    return sessionView(this.target, {
      id: task.nativeTaskId, cwd: task.workspacePath, title: this.conceal(task.title),
      status: task.running ? 'active' : 'idle', updatedAt: task.updatedAt ?? task.createdAt
    });
  }

  async list(limit) {
    const tasks = (await this.directory()).slice(0, limit);
    return Promise.all(tasks.map(async task => {
      if (!task.running) return this.listed(task);
      try { return (await this.inspect(task.nativeTaskId, undefined, tasks)).status; }
      catch { return this.listed(task); }
    }));
  }

  async heartbeat({ sessionIds }) {
    const tasks = await this.directory();
    const ids = new Set([...sessionIds, ...tasks.filter(task => task.running).map(task => task.nativeTaskId)]);
    const sessions = [];
    for (const id of ids) {
      try { sessions.push((await this.inspect(id, undefined, tasks)).status); }
      catch { /* another listed session may still be readable */ }
    }
    const exact = new Map(sessions.map(row => [row.sessionId, row]));
    return { sessions, catalog: tasks.slice(0, 100).map(task => exact.get(task.nativeTaskId) ?? this.listed(task)) };
  }

  async status(sessionId) {
    return (await this.inspect(sessionId)).status;
  }

  async read(sessionId, { limit = 3, cursor, maxChars = 12_000 } = {}) {
    const identity = this.identity(sessionId, await this.directory());
    const response = await this.call('conversation', { ...identity, limit, ...(cursor && { cursor }) });
    this.checkSession(response, identity, false);
    if (!Array.isArray(response.messages)) throw invalid();
    return formatConversation({
      target: this.target, sessionId, workspacePath: identity.workspacePath,
      messages: response.messages.slice(-limit).reverse().map(row => toPublicMessage(row, text => this.conceal(text))).filter(Boolean),
      nextCursor: typeof response.nextCursor === 'string' ? response.nextCursor : null,
      pageTruncated: response.pageTruncated === true || response.messages.length > limit
    }, maxChars);
  }

  async send({ sessionId, expectedWorkspace, prompt, operationId = randomUUID(), mode = 'queue' }) {
    let observed;
    try { observed = await this.inspect(sessionId, expectedWorkspace ?? null); }
    catch (error) { return preflightFailure(error, operationId); }
    const blocked = sendBlocked(observed.status, mode);
    if (blocked) return blocked;
    if (Array.isArray(observed.deliveryModes) && !observed.deliveryModes.includes(mode)) return notSent('delivery_mode_unsupported');
    const nativeId = nativeRequestId(this.target, sessionId, operationId);
    try {
      const result = await this.call('send', {
        ...observed.identity, operationId: nativeId, deliveryMode: mode, prompt: '[AGY_BRIDGE_OP:' + operationId + ']\n' + prompt
      });
      if (result.result === 'not_sent') return notSent(['approval_pending', 'native_resume_required'].includes(result.reason) ? result.reason : 'native_rejected');
      if (result.result !== 'accepted' || result.receipt?.nativeTaskId !== sessionId
          || result.receipt.nativeOperationId !== nativeId) return unknownOutcome(operationId);
      return { result: 'accepted', operationId, sessionId, turnId: null, beforeTurnId: observed.status.latestTurn?.id ?? null };
    } catch (error) {
      if (['DSH_REQUEST_TOO_LARGE', 'DSH_UNAUTHORIZED', 'DSH_BRIDGE_AUTH_FAILED', 'SESSION_IDENTITY_MISMATCH'].includes(error.code)) {
        return preflightFailure(error, operationId);
      }
      return unknownOutcome(operationId);
    }
  }

  async interrupt({ sessionId, expectedWorkspace, expectedTurnId }) {
    let observed;
    try { observed = await this.inspect(sessionId, expectedWorkspace ?? null); }
    catch (error) { return preflightFailure(error); }
    if (observed.status.state !== 'active' || observed.status.activeTurnId !== expectedTurnId) return notSent('target_execution_changed');
    if (Array.isArray(observed.deliveryModes) && !observed.deliveryModes.includes('interrupt')) return notSent('delivery_mode_unsupported');
    try {
      const result = await this.call('interrupt', { ...observed.identity, expectedExecutionId: expectedTurnId, operationId: randomUUID() });
      if (result.result === 'not_sent') return notSent(result.reason === 'approval_pending' ? 'approval_pending' : 'target_execution_changed');
      return result.result === 'accepted' && result.receipt?.stoppedExecutionId === expectedTurnId
        ? { result: 'accepted', sessionId, turnId: expectedTurnId } : unknownOutcome();
    } catch { return unknownOutcome(); }
  }

  async create({ workspacePath, title, prompt }) {
    let anchor;
    try {
      const tasks = await this.directory();
      const task = tasks.find(entry => matchesWorkspace(this.target, entry.workspacePath, workspacePath));
      if (!task) return notSent('workspace_not_found');
      anchor = (await this.inspect(task.nativeTaskId, workspacePath, tasks)).identity;
    } catch (error) {
      return preflightFailure(error);
    }
    const sessionId = 'session-collab-' + randomUUID();
    let view;
    try {
      view = await this.call('create', { ...anchor, sessionId, title });
      this.checkSession(view, { nativeTaskId: sessionId, workspacePath: anchor.workspacePath });
    } catch (error) {
      return { ...creationFailure(error), sessionId };
    }
    const created = createdSession(this.target, sessionId, view.workspacePath, title);
    if (prompt !== undefined) created.promptDelivery = await this.send({ sessionId, expectedWorkspace: view.workspacePath, prompt });
    return created;
  }
}
