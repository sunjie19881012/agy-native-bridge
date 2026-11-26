import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkIdentity, normalizeState, workspaceKey } from '../shared/state.mjs';
import { defaultWatcherTimeoutMs, maxWatcherTimeoutMs } from '../shared/config.mjs';
import { connectLocalDaemon } from './ssh-daemon.mjs';
import { connectLocalDesktopReader } from './ssh-desktop.mjs';

const target = '101-codex';
const terminal = new Set(['completed', 'failed', 'interrupted']);
const safeId = value => typeof value === 'string' && /^[a-z0-9_.:-]{1,200}$/i.test(value);
const safePath = value => typeof value === 'string' && path.posix.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

export function watcherOptions(input) {
  const { sessionId, expectedWorkspace, operationId, socketPath, notifyKeyPath, transport } = input;
  const turnId = input.turnId ?? null;
  const beforeTurnId = input.beforeTurnId ?? null;
  const watcherTimeoutMs = input.watcherTimeoutMs ?? defaultWatcherTimeoutMs;
  if (!safeId(sessionId) || !workspaceKey(target, expectedWorkspace)
      || typeof operationId !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(operationId)
      || (turnId !== null && !safeId(turnId)) || (beforeTurnId !== null && !safeId(beforeTurnId))
      || !['desktop-pipe', 'daemon'].includes(transport) || (transport === 'daemon' && (!turnId || !safePath(socketPath)))
      || (socketPath !== undefined && !safePath(socketPath))
      || (transport === 'desktop-pipe' && socketPath && path.posix.basename(socketPath) === 'app-server-control.sock')
      || (notifyKeyPath !== undefined && !safePath(notifyKeyPath))
      || !Number.isSafeInteger(watcherTimeoutMs) || watcherTimeoutMs < 1 || watcherTimeoutMs > maxWatcherTimeoutMs) {
    throw new Error('Invalid watcher options');
  }
  return { sessionId, expectedWorkspace, operationId, transport, socketPath, notifyKeyPath, turnId, beforeTurnId, watcherTimeoutMs };
}

function parseKey(content) {
  if (typeof content !== 'string') return null;
  const assigned = /^(?:export[ \t]+)?SCT_KEY[ \t]*=[ \t]*(.+)$/m.exec(content)?.[1];
  const key = (assigned ?? content).trim().replace(/^(['"])(.*)\1$/, '$2');
  return /^SCT[a-z0-9_-]+$/i.test(key) && !/^SCTxxx/i.test(key) ? key : null;
}

export async function readNotifyKey(notifyKeyPath, { env = process.env, home = homedir(), read = readFile } = {}) {
  const supplied = parseKey(env.SCT_KEY);
  if (supplied) return supplied;
  for (const file of [path.join(home, '.sct-key'), notifyKeyPath]) {
    if (!file) continue;
    try {
      const found = parseKey(await read(file, 'utf8'));
      if (found) return found;
    } catch { /* the next configured source may contain the key */ }
  }
  return null;
}

export async function notifyServerChan(key, title, desp, { fetch = globalThis.fetch } = {}) {
  const validKey = parseKey(key);
  if (!validKey) return false;
  try {
    const response = await fetch('https://sctapi.ftqq.com/' + validKey + '.send', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ title, desp, noip: '1' })
    });
    return response.ok && (await response.json())?.code === 0;
  } catch { return false; }
}

function hasOperation(items, operationId) {
  const marker = '[AGY_BRIDGE_OP:' + operationId + ']';
  return Array.isArray(items) && items.some(item => item?.type === 'userMessage'
    && Array.isArray(item.content) && item.content.some(part => part?.type === 'text'
      && typeof part.text === 'string' && (part.text === marker || part.text.startsWith(marker + '\n'))));
}

async function desktopTurn(client, options, knownTurnId) {
  const { sessionId, expectedWorkspace, beforeTurnId, operationId } = options;
  const params = { threadId: sessionId, hostId: 'local', includeOutputs: false, maxOutputCharsPerItem: 256 };
  let cursor;
  for (let index = 0; index < 6; index++) {
    const page = await client.call('read_thread', { ...params, turnLimit: 1, ...(cursor && { cursor }) });
    checkIdentity(target, page?.thread, sessionId, expectedWorkspace);
    if (![undefined, null, 'local'].includes(page.thread.hostId) || page.page?.order !== 'newest_first') return null;
    const turn = page.turns?.[0];
    if (!turn?.id) return null;
    let matched = knownTurnId ? turn.id === knownTurnId : hasOperation(turn.items, operationId);
    let itemCursor = turn.nextItemCursor;
    for (let scan = 0; !knownTurnId && !matched && itemCursor && scan < 4; scan++) {
      const items = await client.call('read_thread', { ...params, itemCursor, itemLimit: 32 });
      if (items?.threadId !== sessionId || items.turnId !== turn.id) return null;
      matched = hasOperation(items.items, operationId);
      itemCursor = items.nextItemCursor;
    }
    if (matched) return {
      turnId: turn.id, status: turn.status,
      waitingApproval: index === 0 && !terminal.has(turn.status)
        && normalizeState(page.thread.status).state === 'waiting_approval'
    };
    if ((!knownTurnId && turn.id === beforeTurnId) || !page.page.nextCursor || page.page.nextCursor === cursor) return null;
    cursor = page.page.nextCursor;
  }
  return null;
}

async function daemonTurn(client, options) {
  const { sessionId, expectedWorkspace, turnId } = options;
  const { thread } = await client.request('thread/read', { threadId: sessionId, includeTurns: false });
  checkIdentity(target, thread, sessionId, expectedWorkspace);
  let cursor;
  for (let index = 0; index < 6; index++) {
    const page = await client.request('thread/turns/list', {
      threadId: sessionId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded', ...(cursor && { cursor })
    });
    const turn = page?.data?.[0];
    if (turn?.id === turnId) return {
      turnId, status: turn.status,
      waitingApproval: index === 0 && !terminal.has(turn.status)
        && normalizeState(thread.status, null, client.approvalPending?.(sessionId)).state === 'waiting_approval'
    };
    if (!page?.nextCursor || page.nextCursor === cursor) return null;
    cursor = page.nextCursor;
  }
  return null;
}

export async function inspectWatchedTurn(options, knownTurnId, timeoutMs, {
  desktop = connectLocalDesktopReader, daemon = connectLocalDaemon
} = {}) {
  const config = { transport: options.transport, socketPath: options.socketPath, requestTimeoutMs: Math.max(1, Math.min(5000, timeoutMs)) };
  const useDesktop = options.transport === 'desktop-pipe';
  const client = useDesktop ? await desktop(config, options.sessionId) : await daemon(config);
  try { return await (useDesktop ? desktopTurn(client, options, knownTurnId) : daemonTurn(client, options)); }
  finally { client.close(); }
}

const notices = {
  waiting_approval: '等待原窗口审批', completed: '任务已完成', failed: '任务执行失败',
  interrupted: '任务已中断', timeout: '轮次守望超时'
};

export async function watchTurn(options, {
  inspect = inspectWatchedTurn, notify, clock = Date.now, sleep = delay, pollMs = 15_000
} = {}) {
  let knownTurnId = options.turnId;
  let approvalSent = false;
  const deadline = clock() + options.watcherTimeoutMs;
  const publish = async outcome => {
    try {
      return await notify('101 Codex · ' + notices[outcome], [
        '会话 ' + options.sessionId, '派发编号 ' + options.operationId,
        ...(knownTurnId ? ['轮次 ' + knownTurnId] : [])
      ].join('\n'));
    } catch { return false; }
  };
  while (clock() < deadline) {
    const startedAt = clock();
    const remaining = deadline - startedAt;
    let timer;
    let observation;
    try {
      observation = await Promise.race([
        Promise.resolve().then(() => inspect(options, knownTurnId, remaining)),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining); })
      ]);
    } catch { /* a transient read failure leaves the turn unconfirmed */ }
    finally { clearTimeout(timer); }
    if (clock() >= deadline) break;
    if (observation?.turnId && (!knownTurnId || observation.turnId === knownTurnId)) {
      knownTurnId = observation.turnId;
      if (terminal.has(observation.status)) {
        return { result: observation.status, notified: await publish(observation.status), turnId: knownTurnId };
      }
      if (observation.waitingApproval && !approvalSent) {
        approvalSent = true;
        await publish('waiting_approval');
      }
    }
    const wait = Math.min(pollMs - (clock() - startedAt), deadline - clock());
    if (wait > 0) await sleep(wait);
  }
  return { result: 'timeout', notified: await publish('timeout'), turnId: knownTurnId ?? null };
}
