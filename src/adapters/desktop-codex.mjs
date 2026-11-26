import { readPublicPage } from '../shared/conversation.mjs';
import { createdSession, creationFailure, matchesWorkspace } from '../shared/creation.mjs';
import { BridgeError, notSent, preflightFailure, unknownOutcome, writeFailure } from '../shared/errors.mjs';
import { checkIdentity, sendBlocked, sessionView, withLatest } from '../shared/state.mjs';

const localThread = thread => [undefined, null, 'local'].includes(thread?.hostId)
  && (!thread?.kind || thread.kind === 'codex');
const maxOutputCharsPerItem = 20_000;
const itemPagePrefix = 'desktop-item-page:';

function parseItemPage(cursor) {
  if (!cursor?.startsWith(itemPagePrefix)) return null;
  try {
    const page = JSON.parse(cursor.slice(itemPagePrefix.length));
    if (typeof page.itemCursor === 'string' && page.itemCursor && typeof page.turnId === 'string' && page.turnId
        && (page.nextTurnCursor === null || typeof page.nextTurnCursor === 'string')) return page;
  } catch { /* reject an invalid continuation below */ }
  throw new BridgeError('INVALID_CURSOR', '桌面管道的轮次消息游标格式有误。');
}

function nextDesktopCursor(itemCursor, turnId, nextTurnCursor) {
  return itemCursor ? itemPagePrefix + JSON.stringify({ itemCursor, turnId, nextTurnCursor: nextTurnCursor ?? null }) : nextTurnCursor;
}

export class DesktopCodex {
  constructor({ target, connect, workspaces, rollout }) {
    this.target = target;
    this.label = target === 'win-codex' ? 'Windows Codex' : '101 Codex 桌面管道';
    this.cursorKind = target === 'win-codex' ? 'win-turns' : 'remote-desktop-turns';
    this.connect = connect;
    this.rollout = rollout;
    this.workspaces = new Map(Object.entries(workspaces[target] ?? {}));
  }

  async withPipe(action) {
    const client = await this.connect();
    try { return await action(client); } finally { client.close(); }
  }

  async snapshot(client, sessionId, options = {}) {
    const result = await client.call('read_thread', {
      threadId: sessionId, hostId: 'local', turnLimit: 1, includeOutputs: false,
      maxOutputCharsPerItem: options.metadata ? 0 : options.content ? maxOutputCharsPerItem : 256,
      ...(options.metadata && { itemLimit: 1 }),
      ...(options.cursor && { cursor: options.cursor })
    });
    const thread = result?.thread;
    checkIdentity(this.target, thread, sessionId, this.workspaces.get(sessionId), options.expectedWorkspace);
    if (!localThread(thread)) throw new BridgeError('SESSION_IDENTITY_MISMATCH', '桌面管道仅接入该桌面所在主机的 Codex 会话。');
    if (result.page?.order !== 'newest_first' || !Array.isArray(result.turns) || result.turns.length > 1) {
      throw new BridgeError('INVALID_NATIVE_RESPONSE', this.label + ' 会话分页回执格式有误。');
    }
    this.workspaces.set(sessionId, thread.cwd);
    return result;
  }

  async listViews(client, limit) {
    const listing = await client.call('list_threads', { limit: Math.min(limit, 50) });
    if (!Array.isArray(listing?.threads) || (listing.pinnedThreads !== undefined && !Array.isArray(listing.pinnedThreads))) {
      throw new BridgeError('INVALID_NATIVE_RESPONSE', this.label + ' 会话列表格式有误。');
    }
    const rows = new Map();
    for (const thread of [...listing.pinnedThreads ?? [], ...listing.threads]) {
      if (!localThread(thread) || typeof thread?.id !== 'string' || rows.has(thread.id)) continue;
      const view = sessionView(this.target, thread);
      if (thread.cwd && !this.workspaces.has(thread.id)) this.workspaces.set(thread.id, thread.cwd);
      rows.set(thread.id, view);
      if (rows.size === limit) break;
    }
    return rows;
  }

  async list(limit) {
    return this.withPipe(async client => {
      const rows = await this.listViews(client, limit);
      for (const [id, view] of rows) {
        if (!['active', 'waiting_approval', 'paused'].includes(view.state) || view.activeTurnId) continue;
        try {
          const { thread, turns } = await this.snapshot(client, id);
          rows.set(id, sessionView(this.target, thread, turns[0]));
        } catch { /* the list remains available even if the chat closed during sampling */ }
      }
      return [...rows.values()];
    });
  }

  async heartbeat({ sessionIds, includeQuota }) {
    return this.withPipe(async client => {
      let listingError;
      const catalog = await this.listViews(client, 100).catch(error => {
        listingError = error;
        return new Map();
      });
      const watched = new Set(sessionIds);
      for (const row of catalog.values()) {
        if (['active', 'waiting_approval'].includes(row.state)) watched.add(row.sessionId);
      }
      const sessions = [];
      for (const id of watched) {
        try {
          const { thread, turns } = await this.snapshot(client, id, { metadata: true });
          const status = withLatest(sessionView(this.target, thread, turns[0]), turns[0]);
          catalog.set(id, status);
          sessions.push(status);
        } catch {
          if (catalog.has(id)) sessions.push(catalog.get(id));
        }
      }
      if (listingError && sessions.length === 0) throw listingError;
      const quota = includeQuota ? await client.call('get_usage_limits', {}).catch(() => null) : null;
      return { sessions, catalog: [...catalog.values()], catalogAvailable: !listingError, quota };
    });
  }

  async status(sessionId, options) {
    return this.withPipe(async client => {
      const { thread, turns } = await this.snapshot(client, sessionId, options);
      return withLatest(sessionView(this.target, thread, turns[0]), turns[0]);
    });
  }

  async read(sessionId, options) {
    return this.withPipe(async client => {
      const identity = { target: this.target, sessionId };
      return readPublicPage(identity, options, async ({ native, kind }) => {
        if (kind && kind !== this.cursorKind) throw new BridgeError('INVALID_CURSOR', this.label + ' 的历史游标不匹配。');
        const itemPage = parseItemPage(native);
        if (itemPage) {
          if (!identity.workspacePath) identity.workspacePath = (await this.snapshot(client, sessionId)).thread.cwd;
          const page = await client.call('read_thread', {
            threadId: sessionId, hostId: 'local', includeOutputs: false,
            maxOutputCharsPerItem, itemCursor: itemPage.itemCursor, itemLimit: 32
          });
          if (page?.threadId !== sessionId || page.turnId !== itemPage.turnId || !Array.isArray(page.items)) {
            throw new BridgeError('INVALID_NATIVE_RESPONSE', this.label + ' 轮次消息回执格式有误。');
          }
          return {
            kind: this.cursorKind, anchor: page.turnId,
            nextCursor: nextDesktopCursor(page.nextItemCursor, page.turnId, itemPage.nextTurnCursor),
            entries: [...page.items].reverse().map(item => ({ turnId: page.turnId, item })),
            truncated: page.truncated === true
          };
        }
        const page = await this.snapshot(client, sessionId, { cursor: native, content: true });
        identity.workspacePath = page.thread.cwd;
        const turn = page.turns[0];
        const items = Array.isArray(turn?.items) ? [...turn.items] : [];
        if (this.rollout && turn?.status === 'completed'
            && !items.some(item => item?.type === 'agentMessage' && item.phase === 'final_answer' && item.text?.trim?.())) {
          const final = await this.rollout(sessionId, page.thread.cwd, turn.id).catch(() => null);
          if (final) items.push({ id: turn.id + ':final_answer', type: 'agentMessage', phase: 'final_answer', ...final });
        }
        return {
          kind: this.cursorKind, anchor: turn?.id,
          nextCursor: nextDesktopCursor(turn?.nextItemCursor, turn?.id, page.page.nextCursor),
          entries: items.reverse().map(item => ({ turnId: turn.id, item })),
          truncated: page.page.pageTruncated === true || page.page.truncated === true || turn?.truncated === true
        };
      });
    });
  }

  async send({ sessionId, expectedWorkspace, prompt, operationId, mode }) {
    try {
      return await this.withPipe(async client => {
        const { thread, turns } = await this.snapshot(client, sessionId, { expectedWorkspace: expectedWorkspace ?? null });
        const blocked = sendBlocked(sessionView(this.target, thread, turns[0]), mode);
        if (blocked) return blocked;
        try {
          const receipt = await client.call('send_message_to_thread', {
            threadId: sessionId, hostId: 'local', prompt: '[AGY_BRIDGE_OP:' + operationId + ']\n' + prompt
          });
          if (receipt?.threadId !== sessionId) return unknownOutcome(operationId);
          return {
            result: 'accepted', operationId, sessionId, turnId: null,
            beforeTurnId: turns[0]?.id ?? null, effectiveDelivery: 'unconfirmed'
          };
        } catch (error) {
          if (error.code === 'NATIVE_TOOL_UNAVAILABLE') return notSent('delivery_mode_unsupported');
          return writeFailure(error, operationId);
        }
      });
    } catch (error) {
      return preflightFailure(error, operationId);
    }
  }

  async interrupt({ sessionId, expectedWorkspace, expectedTurnId }) {
    try {
      const current = await this.status(sessionId, { expectedWorkspace: expectedWorkspace ?? null });
      if (current.state !== 'active' || current.activeTurnId !== expectedTurnId) return notSent('target_execution_changed');
      return notSent('delivery_mode_unsupported');
    } catch (error) {
      return preflightFailure(error);
    }
  }

  async create({ workspacePath, title, prompt }) {
    try {
      return await this.withPipe(async client => {
        const catalog = await client.call('list_projects', {});
        if (!Array.isArray(catalog?.projects)) {
          throw new BridgeError('INVALID_NATIVE_RESPONSE', this.label + ' 项目列表格式有误。');
        }
        const projects = catalog.projects.filter(project => localThread(project)
          && matchesWorkspace(this.target, project.path, workspacePath));
        if (projects.length !== 1) return notSent(projects.length ? 'workspace_ambiguous' : 'workspace_not_found');
        const project = projects[0];
        if (typeof project.projectId !== 'string' || !project.projectId) return notSent('workspace_not_found');
        if (prompt === undefined && client.requiresInput('create_thread', 'prompt')) {
          return notSent('initial_prompt_required');
        }
        try {
          const result = await client.call('create_thread', {
            title, ...(prompt !== undefined && { prompt }),
            target: { type: 'project', projectId: project.projectId, environment: { type: 'local' } }
          });
          if (!localThread(result) || typeof result?.threadId !== 'string' || !result.threadId
              || (result.cwd !== undefined && !matchesWorkspace(this.target, result.cwd, workspacePath))) {
            return { ...creationFailure(), ...(typeof result?.clientThreadId === 'string' && { clientThreadId: result.clientThreadId }) };
          }
          return createdSession(this.target, result.threadId, project.path, title);
        } catch (error) {
          return creationFailure(error);
        }
      });
    } catch (error) {
      return preflightFailure(error);
    }
  }
}
