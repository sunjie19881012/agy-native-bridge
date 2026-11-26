import { randomUUID } from 'node:crypto';
import { connectDaemon } from './ssh-daemon.mjs';
import { connectRemoteDesktop } from './ssh-desktop.mjs';
import { DesktopCodex } from './desktop-codex.mjs';
import { readPublicPage } from '../shared/conversation.mjs';
import { createdSession, creationFailure } from '../shared/creation.mjs';
import { BridgeError, notSent, preflightFailure, unknownOutcome, writeFailure } from '../shared/errors.mjs';
import { checkIdentity, sendBlocked, sessionView, withLatest, workspaceKey } from '../shared/state.mjs';

const target = '101-codex';

function responseArray(result, field) {
  if (Array.isArray(result?.[field])) return result[field];
  throw new BridgeError('INVALID_NATIVE_RESPONSE', '101 Codex Daemon 分页回执格式有误。');
}

export class RemoteCodex {
  constructor(config, { spawnProcess } = {}) {
    this.config = config.remote;
    this.spawnProcess = spawnProcess;
    if (this.config.transport === 'daemon') {
      this.workspaces = new Map(Object.entries(config.workspaces[target] ?? {}));
    } else {
      this.desktop = new DesktopCodex({
        target, workspaces: config.workspaces, connect: () => connectRemoteDesktop(this.config, this.spawnProcess)
      });
    }
  }

  async withDaemon(action) {
    const client = await connectDaemon(this.config, this.spawnProcess);
    try { return await action(client); } finally { client.close(); }
  }

  async identity(client, sessionId, expectedWorkspace) {
    const result = await client.request('thread/read', { threadId: sessionId, includeTurns: false });
    const thread = result?.thread;
    checkIdentity(target, thread, sessionId, this.workspaces.get(sessionId), expectedWorkspace);
    this.workspaces.set(sessionId, thread.cwd);
    return thread;
  }

  async turns(client, sessionId, limit = 20) {
    try {
      return responseArray(await client.request('thread/turns/list', {
        threadId: sessionId, limit, sortDirection: 'desc', itemsView: 'notLoaded'
      }), 'data');
    } catch (error) {
      if (error.code === 'NATIVE_REJECTED' && /list_turns is not supported yet|is not materialized yet/i.test(error.nativeMessage)) return [];
      throw error;
    }
  }

  async inspect(client, sessionId, expectedWorkspace) {
    const thread = await this.identity(client, sessionId, expectedWorkspace);
    const [latest] = await this.turns(client, sessionId);
    const session = sessionView(target, thread, latest, client.approvalPending(sessionId));
    return { thread, status: withLatest(session, latest) };
  }

  async list(limit) {
    if (this.desktop) return this.desktop.list(limit);
    return this.withDaemon(async client => {
      const result = await client.request('thread/list', {
        limit, sortDirection: 'desc', sortKey: 'updated_at', useStateDbOnly: true
      });
      const rows = responseArray(result, 'data').filter(thread => typeof thread?.id === 'string').slice(0, limit);
      const sessions = [];
      for (const thread of rows) {
        if (thread.cwd && !this.workspaces.has(thread.id)) this.workspaces.set(thread.id, thread.cwd);
        let view = sessionView(target, thread, null, client.approvalPending(thread.id));
        if (['active', 'waiting_approval', 'paused'].includes(view.state) && !view.activeTurnId) {
          try {
            const [latest] = await this.turns(client, thread.id);
            view = sessionView(target, thread, latest, client.approvalPending(thread.id));
          } catch {
            // The directory response is still usable if a chat closed during sampling.
          }
        }
        sessions.push(view);
      }
      return sessions;
    });
  }

  async status(sessionId) {
    if (this.desktop) return this.desktop.status(sessionId);
    return this.withDaemon(async client => (await this.inspect(client, sessionId)).status);
  }

  async usageLimits() {
    if (this.desktop) return this.desktop.withPipe(client => client.call('get_usage_limits', {}));
    return this.withDaemon(client => client.request('account/rateLimits/read', {}));
  }

  async heartbeat({ sessionIds, includeQuota }) {
    if (this.desktop) return this.desktop.heartbeat({ sessionIds, includeQuota });
    return this.withDaemon(async client => {
      const wanted = new Set(sessionIds);
      const cursors = new Set();
      let cursor;
      for (let scan = 0; scan < 10; scan++) {
        const page = await client.request('thread/loaded/list', { limit: 100, ...(cursor && { cursor }) });
        for (const id of responseArray(page, 'data')) if (typeof id === 'string') wanted.add(id);
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor)) break;
        cursors.add(cursor);
      }
      const sessions = [];
      for (const id of wanted) {
        try {
          const thread = await this.identity(client, id);
          const [latest] = await this.turns(client, id, 1);
          sessions.push(withLatest(sessionView(target, thread, latest), latest));
        } catch { /* other loaded chats may still be available */ }
      }
      const quota = includeQuota ? await client.request('account/rateLimits/read', {}).catch(() => null) : null;
      return { sessions, catalog: sessions, quota };
    });
  }

  async itemPage(client, sessionId, { native, kind }, limit) {
    const params = { threadId: sessionId, sortDirection: 'desc', ...(native && { cursor: native }) };
    if (kind && !['remote-items', 'remote-summary'].includes(kind)) throw new BridgeError('INVALID_CURSOR', '游标不属于 101 Codex。');
    if (kind !== 'remote-summary') {
      try {
        const page = await client.request('thread/items/list', { ...params, limit });
        return { kind: 'remote-items', entries: responseArray(page, 'data'), nextCursor: page.nextCursor };
      } catch (error) {
        if (kind || error.code !== 'NATIVE_REJECTED' || !/thread\/items\/list is not supported yet/i.test(error.nativeMessage)) throw error;
      }
    }
    const page = await client.request('thread/turns/list', { ...params, limit: 1, itemsView: 'summary' });
    const [turn] = responseArray(page, 'data');
    return {
      kind: 'remote-summary', anchor: turn?.id, nextCursor: page.nextCursor, truncated: turn?.truncated === true,
      entries: (turn?.items ?? []).slice().reverse().map(item => ({ turnId: turn.id, item }))
    };
  }

  async read(sessionId, options) {
    if (this.desktop) return this.desktop.read(sessionId, options);
    return this.withDaemon(async client => {
      const thread = await this.identity(client, sessionId);
      return readPublicPage({ target, sessionId, workspacePath: thread.cwd }, options,
        (position, limit) => this.itemPage(client, sessionId, position, limit));
    });
  }

  async send({ sessionId, expectedWorkspace, prompt, operationId, mode }) {
    if (this.desktop) return this.desktop.send({ sessionId, expectedWorkspace, prompt, operationId, mode });
    try {
      return await this.withDaemon(async client => {
        const workspace = expectedWorkspace ?? null;
        let observed = await this.inspect(client, sessionId, workspace);
        let blocked = sendBlocked(observed.status, mode);
        if (blocked) return blocked;
        if (observed.status.state === 'idle' && (observed.thread.status?.type === 'notLoaded' || observed.status.latestTurn)) {
          const resumed = await client.request('thread/resume', { threadId: sessionId, excludeTurns: true });
          checkIdentity(target, resumed?.thread, sessionId, observed.thread.cwd);
          observed = await this.inspect(client, sessionId, workspace);
          blocked = sendBlocked(observed.status, mode);
          if (blocked) return blocked;
          if (observed.thread.status?.type === 'notLoaded') return notSent('original_task_resume_failed');
        }

        const steer = observed.status.state === 'active';
        const expectedTurnId = observed.status.activeTurnId;
        if (steer && !expectedTurnId) return notSent('target_execution_changed');
        try {
          const ack = await client.request(steer ? 'turn/steer' : 'turn/start', {
            threadId: sessionId, clientUserMessageId: operationId,
            input: [{ type: 'text', text: '[AGY_BRIDGE_OP:' + operationId + ']\n' + prompt }],
            ...(steer && { expectedTurnId })
          });
          const turnId = steer ? ack?.turnId ?? ack?.turn?.id : ack?.turn?.id;
          if (typeof turnId !== 'string' || !turnId || (steer && turnId !== expectedTurnId)) return unknownOutcome(operationId);
          return { result: 'accepted', operationId, sessionId, turnId, effectiveDelivery: steer ? 'steer' : 'startNow' };
        } catch (error) {
          return writeFailure(error, operationId);
        }
      });
    } catch (error) {
      return preflightFailure(error, operationId);
    }
  }

  async interrupt({ sessionId, expectedWorkspace, expectedTurnId }) {
    if (this.desktop) return this.desktop.interrupt({ sessionId, expectedWorkspace, expectedTurnId });
    try {
      return await this.withDaemon(async client => {
        const { status } = await this.inspect(client, sessionId, expectedWorkspace ?? null);
        if (status.state !== 'active' || status.activeTurnId !== expectedTurnId) return notSent('target_execution_changed');
        try {
          const ack = await client.request('turn/interrupt', { threadId: sessionId, turnId: expectedTurnId });
          if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return unknownOutcome();
          return { result: 'accepted', sessionId, turnId: expectedTurnId };
        } catch (error) {
          return writeFailure(error);
        }
      });
    } catch (error) {
      return preflightFailure(error);
    }
  }

  async create({ workspacePath, title, prompt }) {
    if (this.desktop) return this.desktop.create({ workspacePath, title, prompt });
    if (!workspaceKey(target, workspacePath)) return notSent('workspace_not_found');
    try {
      return await this.withDaemon(async client => {
        let thread;
        try {
          ({ thread } = await client.request('thread/start', { cwd: workspacePath, ephemeral: false }));
          if (typeof thread?.id !== 'string' || !thread.id) return creationFailure();
          checkIdentity(target, thread, thread.id, workspacePath);
        } catch (error) {
          return creationFailure(error);
        }
        const created = createdSession(target, thread.id, thread.cwd, title);
        try { await client.request('thread/name/set', { threadId: thread.id, name: title }); }
        catch { created.titleConfirmed = false; }
        if (prompt !== undefined) {
          const operationId = randomUUID();
          try {
            const ack = await client.request('turn/start', {
              threadId: thread.id, clientUserMessageId: operationId,
              input: [{ type: 'text', text: '[AGY_BRIDGE_OP:' + operationId + ']\n' + prompt }]
            });
            created.promptDelivery = typeof ack?.turn?.id === 'string' && ack.turn.id
              ? { result: 'accepted', operationId, turnId: ack.turn.id } : unknownOutcome(operationId);
          } catch (error) {
            created.promptDelivery = writeFailure(error, operationId);
          }
        }
        return created;
      });
    } catch (error) {
      return preflightFailure(error);
    }
  }

  async reconcile(sessionId, operationId) {
    if (this.desktop) {
      throw new BridgeError('NATIVE_TOOL_UNAVAILABLE', '101 桌面管道请用 bridge_read 在原会话历史核对 operationId。');
    }
    return this.withDaemon(async client => {
      await this.identity(client, sessionId);
      let position = { native: null, kind: null };
      const seen = new Set();
      for (let scan = 0; scan < 20; scan++) {
        const page = await this.itemPage(client, sessionId, position, 50);
        for (const { turnId, item } of page.entries) {
          if (item?.type === 'userMessage' && item.clientId === operationId && typeof turnId === 'string' && turnId) {
            return { result: 'accepted', operationId, sessionId, turnId, userMessageId: item.id ?? null };
          }
        }
        if (!page.nextCursor || seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor);
        position = { native: page.nextCursor, kind: page.kind };
      }
      return unknownOutcome(operationId);
    });
  }
}
