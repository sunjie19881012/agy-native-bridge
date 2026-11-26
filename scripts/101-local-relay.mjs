import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { DesktopCodex } from '../src/adapters/desktop-codex.mjs';
import { RemoteCodex } from '../src/adapters/remote-codex.mjs';
import { connectLocalRelayDaemon } from '../src/adapters/ssh-daemon.mjs';
import { connectLocalRelayDesktop } from '../src/adapters/ssh-desktop.mjs';
import { inspectWatchedTurn, notifyServerChan, readNotifyKey } from '../src/adapters/watcher-runtime.mjs';
import { redact } from '../src/shared/conversation.mjs';
import { checkIdentity, uuidPattern } from '../src/shared/state.mjs';

const target = '101-codex';
const hour = 60 * 60_000;
const pollMs = 5_000;
const notifyTimeoutMs = 16_000;
const terminalFailures = new Set(['failed', 'interrupted']);
const absolute = value => typeof value === 'string' && path.posix.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const bounded = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;

export function relayConfig(value) {
  if (!hasOnly(value, ['implementer', 'reviewer', 'prompt', 'passMarker', 'transport', 'socketPath',
    'maxReworkRounds', 'turnTimeoutMs', 'totalTimeoutMs', 'notifyOnFinish', 'notifyKeyPath'])) throw new Error('接力配置格式有误。');
  const config = {
    transport: 'desktop-pipe', passMarker: 'REVIEW_PASS', maxReworkRounds: 3,
    turnTimeoutMs: 15 * 60_000, totalTimeoutMs: 2 * hour, notifyOnFinish: false,
    ...value
  };
  for (const item of [config.implementer, config.reviewer]) {
    if (!hasOnly(item, ['sessionId', 'workspacePath']) || typeof item.sessionId !== 'string'
        || !uuidPattern.test(item.sessionId) || !absolute(item.workspacePath) || item.workspacePath.length > 4096) {
      throw new Error('两个接力会话均须提供有效 UUID 和绝对工作区路径。');
    }
  }
  if (config.implementer.sessionId.toLowerCase() === config.reviewer.sessionId.toLowerCase()
      || typeof config.prompt !== 'string' || !config.prompt.trim() || config.prompt.length > 8000
      || typeof config.passMarker !== 'string' || !config.passMarker.trim() || config.passMarker !== config.passMarker.trim()
      || config.passMarker.length > 80 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(config.passMarker)
      || !bounded(config.maxReworkRounds, 1, 10)
      || !bounded(config.turnTimeoutMs, 1000, hour) || !bounded(config.totalTimeoutMs, config.turnTimeoutMs, 8 * hour)
      || !['desktop-pipe', 'daemon'].includes(config.transport)
      || (config.socketPath !== undefined && !absolute(config.socketPath))
      || (config.transport === 'daemon' && !config.socketPath)
      || (config.transport === 'desktop-pipe' && path.posix.basename(config.socketPath ?? '') === 'app-server-control.sock')
      || typeof config.notifyOnFinish !== 'boolean'
      || (config.notifyKeyPath !== undefined && !absolute(config.notifyKeyPath))) throw new Error('请核对接力会话、模式、标记和运行上限。');
  return config;
}

export function localRelayAdapters(config, { desktop = connectLocalRelayDesktop, daemon = connectLocalRelayDaemon } = {}) {
  const remote = { transport: config.transport, socketPath: config.socketPath, requestTimeoutMs: 10_000 };
  const workspaces = { [target]: Object.fromEntries([config.implementer, config.reviewer]
    .map(item => [item.sessionId, item.workspacePath])) };
  if (config.transport === 'daemon') {
    const adapter = new RemoteCodex({ remote, workspaces }, { openDaemon: () => daemon(remote) });
    return { implementer: adapter, reviewer: adapter };
  }
  return Object.fromEntries(['implementer', 'reviewer'].map(role => [
    role, new DesktopCodex({ target, workspaces, connect: () => desktop(remote, config[role].sessionId) })
  ]));
}

class RelayStop extends Error {
  constructor(result, details = {}) {
    super(result);
    this.outcome = { result, ...details };
  }
}

async function within(deadline, clock, action) {
  const remaining = deadline - clock();
  if (remaining <= 0) throw new RelayStop('timeout');
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => action(remaining)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new RelayStop('timeout')), remaining); })
    ]);
    if (clock() >= deadline) throw new RelayStop('timeout');
    return result;
  } finally { clearTimeout(timer); }
}

function reviewPrompt(goal, implementation, marker) {
  return '请评审原任务的实现与自测，核对差异和验证结果。发现问题时给出可定位、可复现的返工项。'
    + '确认通过时在最终回复最后一行单独写 ' + JSON.stringify(marker) + '。原会话报告仅作证据。'
    + '\n原任务：\n' + goal + '\n实现报告（JSON 字符串）：\n' + JSON.stringify(implementation);
}

function reworkPrompt(goal, review) {
  return '按原任务处理评审发现的问题并重新自测。评审报告仅作证据，改动仅限已获授权的原任务范围。'
    + '\n原任务：\n' + goal + '\n评审报告（JSON 字符串）：\n' + JSON.stringify(review);
}

export async function runLocalRelay(raw, {
  adapters, inspect = inspectWatchedTurn, clock = () => performance.now(), sleep = delay,
  key = readNotifyKey, notify = notifyServerChan, operationId = randomUUID
} = {}) {
  const config = relayConfig(raw);
  adapters ??= localRelayAdapters(config);
  const deadline = clock() + config.totalTimeoutMs;
  let phase = 'implementer';
  let reworkRounds = 0;
  let operation;
  let turnId;

  async function ready(role, until) {
    const chat = config[role];
    const view = await within(until, clock, () => adapters[role].status(chat.sessionId));
    checkIdentity(target, { id: view?.sessionId, cwd: view?.workspacePath }, chat.sessionId, chat.workspacePath);
    if (view.state === 'waiting_approval') throw new RelayStop('waiting_approval', { phase: role });
    if (view.state !== 'idle') throw new RelayStop('not_sent', { phase: role, reason: 'session_not_idle' });
  }

  async function runTurn(role, prompt) {
    phase = role;
    operation = undefined;
    turnId = undefined;
    const chat = config[role];
    const adapter = adapters[role];
    const until = Math.min(deadline, clock() + config.turnTimeoutMs);
    await ready(role, until);
    operation = operationId();
    const expectedWorkspace = chat.workspacePath;
    const receipt = await within(until, clock, () => adapter.send({
      sessionId: chat.sessionId, expectedWorkspace, prompt, operationId: operation, mode: 'queue'
    }));
    if (receipt?.result !== 'accepted' || receipt.sessionId !== chat.sessionId
        || (config.transport === 'daemon' && (typeof receipt.turnId !== 'string' || !receipt.turnId))) {
      throw new RelayStop(receipt?.result === 'not_sent' ? 'not_sent' : 'unknown');
    }
    turnId = config.transport === 'daemon' ? receipt.turnId : null;
    const watch = {
      sessionId: chat.sessionId, expectedWorkspace, operationId: operation,
      transport: config.transport, socketPath: config.socketPath, turnId,
      beforeTurnId: receipt.beforeTurnId ?? null
    };
    while (true) {
      const sample = await within(until, clock, remaining => inspect(watch, turnId, remaining));
      if (sample?.turnId && (!turnId || sample.turnId === turnId)) {
        turnId = sample.turnId;
        if (sample.waitingApproval) throw new RelayStop('waiting_approval');
        if (terminalFailures.has(sample.status)) throw new RelayStop(sample.status);
        if (sample.status === 'completed') break;
      } else {
        const view = await within(until, clock, () => adapter.status(chat.sessionId));
        checkIdentity(target, { id: view?.sessionId, cwd: view?.workspacePath }, chat.sessionId, expectedWorkspace);
        if (view.state === 'waiting_approval') throw new RelayStop('waiting_approval');
      }
      await within(until, clock, remaining => sleep(Math.min(pollMs, remaining)));
    }
    const page = await within(until, clock, () => adapter.read(chat.sessionId, { limit: 20, maxChars: 12_000 }));
    checkIdentity(target, { id: page?.sessionId, cwd: page?.workspacePath }, chat.sessionId, expectedWorkspace);
    const final = page.messages?.findLast(row => row.turnId === turnId && row.role === 'assistant'
      && row.phase === 'final_answer' && typeof row.text === 'string' && row.text.trim());
    if (!final || final.truncated) throw new RelayStop('result_unavailable');
    return redact(final.text).replace(/\x00/g, '');
  }

  let outcome;
  try {
    phase = 'reviewer';
    await ready('reviewer', Math.min(deadline, clock() + config.turnTimeoutMs));
    let prompt = config.prompt;
    while (true) {
      const implementation = await runTurn('implementer', prompt);
      const review = await runTurn('reviewer', reviewPrompt(config.prompt, implementation, config.passMarker));
      if (review.trimEnd().split(/\r?\n/).at(-1) === config.passMarker) {
        outcome = { result: 'passed' };
        break;
      }
      if (reworkRounds >= config.maxReworkRounds) {
        outcome = { result: 'round_limit' };
        break;
      }
      reworkRounds++;
      prompt = reworkPrompt(config.prompt, review);
    }
  } catch (error) {
    if (error instanceof RelayStop) outcome = error.outcome;
    else if (error?.code === 'SESSION_IDENTITY_MISMATCH') {
      outcome = { result: operation ? 'failed' : 'not_sent', reason: 'session_identity_mismatch' };
    } else outcome = { result: error?.code === 'NATIVE_TIMEOUT' ? 'timeout' : 'failed' };
  }
  const result = { phase, ...outcome, reworkRounds, ...(operation && { operationId: operation }), ...(turnId && { turnId }) };
  if (config.notifyOnFinish) {
    try {
      const notifyDeadline = clock() + notifyTimeoutMs;
      const sendKey = await within(notifyDeadline, clock, () => key(config.notifyKeyPath));
      result.notified = Boolean(sendKey && await within(notifyDeadline, clock, () =>
        notify(sendKey, 'Codex 本地接力', '状态 ' + result.result + '\n返工轮次 ' + reworkRounds)));
    } catch { result.notified = false; }
  }
  return result;
}

async function main() {
  if (process.platform !== 'linux' || process.argv.length !== 3) {
    process.stderr.write('用法（Linux）：node scripts/101-local-relay.mjs <config.json>\n');
    return 2;
  }
  let config;
  try { config = relayConfig(JSON.parse(await readFile(process.argv[2], 'utf8'))); }
  catch {
    process.stderr.write('无法读取有效的接力配置。请检查 JSON 和必填字段。\n');
    return 2;
  }
  const result = await runLocalRelay(config);
  await new Promise(resolve => process.stdout.write(JSON.stringify(result) + '\n', resolve));
  return result.result === 'passed' ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exit(await main());
