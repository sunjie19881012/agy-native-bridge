import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeartbeat, heartbeatMs, intervalFor, recentUnreadMs } from '../src/sidecar/heartbeat.mjs';
import { applySamples, initialSnapshot, recordDispatch, watchIds } from '../src/sidecar/snapshot.mjs';

function timeline() {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    now: () => now,
    timers: {
      setTimeout(fn, after) { const id = ++sequence; pending.set(id, { at: now + after, fn }); return id; },
      clearTimeout(id) { pending.delete(id); }
    },
    async advance(delta) {
      const end = now + delta;
      await flush();
      for (;;) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at).find(([, job]) => job.at <= end);
        if (!next) break;
        const [id, job] = next;
        now = job.at;
        pending.delete(id);
        job.fn();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

test('心跳启动 2s，运行或审批时 30s，空闲 5m，连续离线时 10m', async () => {
  const time = timeline();
  const calls = [];
  const online = state => ({ reachable: true, sessions: [{ state }], failures: 0 });
  let targets = { remote: online('waiting_approval'), local: online('idle') };
  const heartbeat = createHeartbeat({
    clock: time.now, timers: time.timers,
    probe: async ({ reason }) => { calls.push([time.now(), reason]); return { intervalMs: intervalFor(targets) }; }
  });
  heartbeat.start();
  await time.advance(1999);
  assert.deepEqual(calls, []);
  await time.advance(1);
  assert.deepEqual(calls, [[2000, 'startup']]);
  targets.remote = online('idle');
  await time.advance(29_999);
  assert.equal(calls.length, 1);
  await time.advance(1);
  assert.deepEqual(calls.at(-1), [32_000, 'periodic']);
  const offline = failures => ({ reachable: false, sessions: [], failures });
  targets = { remote: offline(1), local: offline(1) };
  await time.advance(300_000);
  targets = { remote: offline(2), local: offline(2) };
  await time.advance(300_000);
  await time.advance(599_999);
  assert.equal(calls.length, 4);
  await time.advance(1);
  assert.deepEqual(calls.at(-1), [1_232_000, 'periodic']);
  assert.equal(intervalFor({ remote: offline(2), local: online('active') }), 30_000);
  await heartbeat.stop();
});

test('侧栏激活 15s 防抖，动作补探即时加 5s 和 15s，暂停时手动刷新可用', async () => {
  const time = timeline();
  const calls = [];
  const heartbeat = createHeartbeat({
    clock: time.now, timers: time.timers,
    probe: async (trigger) => { calls.push([time.now(), trigger]); return { intervalMs: heartbeatMs.idle }; }
  });
  await heartbeat.refresh('focus');
  await time.advance(14_999);
  assert.deepEqual(await heartbeat.refresh('focus'), { skipped: true });
  await time.advance(1);
  await heartbeat.refresh('focus');
  heartbeat.nudge('101-codex');
  await time.advance(15_000);
  assert.deepEqual(calls.map(([at, trigger]) => [at, trigger.reason]), [
    [0, 'focus'], [15_000, 'focus'], [15_000, 'action'], [20_000, 'action'], [30_000, 'action']
  ]);
  assert.ok(calls.slice(-3).every(([, trigger]) => trigger.target === '101-codex'));
  heartbeat.setPaused(true);
  heartbeat.nudge('win-codex');
  assert.deepEqual(await heartbeat.refresh('focus'), { skipped: true });
  await time.advance(300_000);
  assert.equal(calls.length, 5);
  await heartbeat.refresh();
  assert.equal(calls.at(-1)[1].reason, 'manual');
  heartbeat.setPaused(false);
  await time.advance(0);
  assert.equal(calls.at(-1)[1].reason, 'periodic');
  await heartbeat.stop();
});

test('重叠心跳复用进行中的探测，动作补探仍会执行', async () => {
  const time = timeline();
  let release;
  let probes = 0;
  const heartbeat = createHeartbeat({
    clock: time.now, timers: time.timers,
    probe: () => probes++ === 0 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({})
  });
  const first = heartbeat.refresh();
  heartbeat.nudge('101-codex');
  assert.equal(heartbeat.refresh('focus'), first);
  await time.advance(0);
  assert.equal(probes, 1);
  release({});
  await first;
  await time.advance(15_000);
  assert.equal(probes, 3);
  await heartbeat.stop();
});

test('心跳合并固定、当前跟踪和同目标未隐藏的星标会话', () => {
  const row = { sessions: [
    { sessionId: 'idle', state: 'idle' },
    { sessionId: 'busy', state: 'active' },
    { sessionId: 'dispatch', state: 'idle', tracking: {} }
  ] };
  const preferences = {
    '101-codex:idle': { starred: true },
    '101-codex:busy': { starred: true },
    '101-codex:starred:catalog': { starred: true, hidden: false },
    '101-codex:hidden': { starred: true, hidden: true },
    '101-codex:unstarred': { starred: false },
    'win-codex:other-host': { starred: true }
  };
  assert.deepEqual(watchIds(row, { fixed: '/fixed' }, { target: '101-codex', preferences }),
    ['fixed', 'busy', 'dispatch', 'idle', 'starred:catalog']);
});

test('快照跟踪派发前后轮次、审批和完成未读，额度只保存 Codex 窗口', () => {
  const target = '101-codex';
  let now = Date.parse('2026-11-25T00:00:00Z');
  let snapshot = recordDispatch(initialSnapshot(), {
    action: 'send', target, sessionId: 'fixture', workspacePath: '/mock', beforeTurnId: 'old', mode: 'queue'
  }, now);
  const update = (state, id, status, quota = null) => {
    now += 1000;
    const session = { target, sessionId: 'fixture', state, activeTurnId: state === 'idle' ? null : id, latestTurn: { id, status } };
    const result = applySamples(snapshot, [[target, { sessions: [session], catalog: [session], quota, quotaChecked: Boolean(quota) }]], now);
    snapshot = result.state;
    return { row: snapshot.targets[target].sessions[0], transitions: result.transitions };
  };
  assert.deepEqual(watchIds(snapshot.targets[target], { fixed: '/fixed' }), ['fixed', 'fixture']);
  const old = update('idle', 'old', 'completed');
  assert.equal(old.transitions.length, 0);
  assert.ok(old.row.tracking);
  update('active', 'new', 'inProgress');
  assert.equal(update('waiting_approval', 'new', 'inProgress').row.unread.kind, 'waiting_approval');
  const resumed = update('active', 'new', 'inProgress');
  assert.equal(resumed.row.unread, null);
  assert.deepEqual(resumed.transitions, []);
  const finished = update('idle', 'new', 'completed', { rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 60, windowDurationMins: 10080 }
  } } });
  assert.equal(finished.row.outcome, 'completed');
  assert.equal(finished.row.unread.kind, 'completed');
  assert.equal(finished.row.tracking, null);
  assert.deepEqual(snapshot.targets[target].rateLimits.windows, {
    '5h': { remainingPercent: 75, resetsAt: 100 }, '7d': { remainingPercent: 40, resetsAt: null }
  });
  const next = update('active', 'next', 'inProgress');
  assert.equal(next.row.unread, null);
  assert.equal(next.row.outcome, null);
  assert.deepEqual(next.transitions, []);
  assert.equal(update('idle', 'next', 'failed').row.unread.kind, 'failed');
  update('active', 'last', 'inProgress');
  assert.equal(update('idle', 'last', 'interrupted').row.unread.kind, 'interrupted');
});

test('过期终态未读会从快照清掉，仍被探测的会话清除未读，待审批保持未读', () => {
  const target = '101-codex';
  const at = 10_000;
  const terminal = (sessionId, kind, extra) => ({
    target, sessionId, state: 'idle', outcome: kind, outcomeAt: at, unread: { kind, at }, ...extra
  });
  const ongoingApproval = { target, sessionId: 'approval', state: 'waiting_approval',
    unread: { kind: 'waiting_approval', at, turnId: 'turn' } };
  const tracked = terminal('tracked', 'interrupted', { tracking: { turnId: 'next' } });
  const sampled = terminal('sampled', 'failed');
  const sessions = [terminal('completed', 'completed'), terminal('failed', 'failed'), terminal('interrupted', 'interrupted'),
    terminal('missing-time', 'completed', { unread: { kind: 'completed' } }), tracked, sampled, ongoingApproval];
  const state = initialSnapshot({ targets: { [target]: { sessions } } });
  const snapshotAt = now => applySamples(state, [[target, { sessions: [
    { target, sessionId: sampled.sessionId, state: 'idle' }, { target, sessionId: ongoingApproval.sessionId, state: 'waiting_approval' }
  ], catalog: sessions }]], now);
  const boundary = snapshotAt(at + recentUnreadMs).state.targets[target].sessions;
  assert.equal(boundary.find(row => row.sessionId === 'completed').unread.kind, 'completed');
  assert.equal(boundary.find(row => row.sessionId === 'missing-time').unread, null);
  const expired = snapshotAt(at + recentUnreadMs + 1);
  assert.deepEqual(expired.transitions, []);
  assert.deepEqual(expired.state.targets[target].sessions.map(row => [row.sessionId, row.unread]), [
    ['sampled', null], ['approval', ongoingApproval.unread], ['tracked', null]
  ]);
  const missingApproval = applySamples(expired.state, [[target, { sessions: [], catalog: [] }]], at + 2 * recentUnreadMs);
  assert.deepEqual(missingApproval.state.targets[target].sessions.find(row => row.sessionId === 'approval').unread,
    ongoingApproval.unread);
});

test('记录新派发或跟踪新建首轮时清除旧回复，空会话新建保持快照', () => {
  const target = '101-codex';
  const sessionId = 'fixture';
  const state = initialSnapshot({ targets: { [target]: { sessions: [{
    sessionId, state: 'idle', outcome: 'completed', unread: { kind: 'completed', turnId: 'old-turn' }
  }] } } });
  const notice = { target, sessionId, turnId: 'new-turn', workspacePath: '/mock' };
  for (const fields of [{ action: 'send' }, { action: 'create', tracking: true }]) {
    const row = recordDispatch(state, { ...notice, ...fields }, 1000).targets[target].sessions[0];
    assert.equal(row.unread, null);
    assert.equal(row.tracking.turnId, 'new-turn');
  }
  assert.equal(recordDispatch(state, { ...notice, action: 'create' }, 1000), state);
});
