import assert from 'node:assert/strict';
import test from 'node:test';
import { localRelayAdapters, relayConfig, runLocalRelay } from '../scripts/101-local-relay.mjs';

const implementer = { sessionId: '00000000-0000-4000-8000-000000000001', workspacePath: '/home/user/work/task' };
const reviewer = { sessionId: '00000000-0000-4000-8000-000000000002', workspacePath: '/home/user/work/task' };
const input = { implementer, reviewer, prompt: 'Implement the fixture change.' };

function fixture({ reviews = ['REVIEW_PASS'], observations = {}, delivery, status, transport = 'desktop-pipe' } = {}) {
  const calls = [];
  const notices = [];
  const watched = [];
  const results = new Map();
  let now = 0;
  const make = (role, chat) => ({
    async status() { return { sessionId: chat.sessionId, workspacePath: chat.workspacePath, state: status?.[role] ?? 'idle' }; },
    async send(args) {
      const turnId = 'turn-' + (calls.length + 1);
      calls.push({ role, turnId, ...args });
      const text = role === 'reviewer' ? reviews.shift() : 'Implementation report.\npassword=synthetic-fixture';
      results.set(turnId, { role: 'assistant', phase: 'final_answer', turnId, text });
      return { result: delivery ?? 'accepted', sessionId: chat.sessionId,
        ...(transport === 'daemon' ? { turnId } : { beforeTurnId: 'old-turn' }) };
    },
    async read() {
      return { sessionId: chat.sessionId, workspacePath: chat.workspacePath, messages: [
        { role: 'assistant', phase: 'final_answer', turnId: 'irrelevant', text: 'REVIEW_PASS' },
        ...results.values()
      ] };
    }
  });
  return { calls, notices, watched, deps: {
    adapters: { implementer: make('implementer', implementer), reviewer: make('reviewer', reviewer) },
    clock: () => now, sleep: async ms => { now += ms; }, operationId: () => 'mock-operation-' + (calls.length + 1),
    inspect: async (watch, known, remaining) => {
      const turn = calls.at(-1);
      assert.ok(remaining > 0);
      watched.push({ watch, known });
      const state = observations[turn.role] ?? 'completed';
      if (state === 'missing') return null;
      return { turnId: turn.turnId, status: state, waitingApproval: state === 'waiting_approval' };
    },
    key: async () => 'mock-key',
    notify: async (...args) => { notices.push(args); return true; }
  } };
}

test('本地接力在 A 路串行交接精确轮次，评审最后一行明确通过后通知一次', async () => {
  const f = fixture({ reviews: ['Verified.\nFIXTURE_PASS'] });
  const result = await runLocalRelay({ ...input, notifyOnFinish: true, passMarker: 'FIXTURE_PASS' }, f.deps);
  assert.equal(result.result, 'passed');
  assert.equal(result.reworkRounds, 0);
  assert.equal(result.notified, true);
  assert.deepEqual(f.calls.map(call => call.role), ['implementer', 'reviewer']);
  assert.equal(f.calls[0].prompt, input.prompt);
  assert.match(f.calls[1].prompt, /Implementation report/);
  assert.doesNotMatch(f.calls[1].prompt, /synthetic-fixture/);
  assert.ok(f.calls.every(call => call.mode === 'queue' && call.expectedWorkspace === implementer.workspacePath));
  assert.ok(f.watched.every(({ watch, known }) => watch.transport === 'desktop-pipe' && watch.beforeTurnId === 'old-turn' && known === null));
  assert.equal(f.notices.length, 1);
  assert.doesNotMatch(f.notices[0][2], /synthetic|fixture|mock-key|Implementation/i);
});

test('接力按评审返工，早先轮次或最终回复中间出现通过标记不结案', async () => {
  const f = fixture({ reviews: ['REVIEW_PASS\n仍需修正边界判断。', 'REVIEW_PASS'] });
  const result = await runLocalRelay(input, f.deps);
  assert.equal(result.result, 'passed');
  assert.equal(result.reworkRounds, 1);
  assert.deepEqual(f.calls.map(call => call.role), ['implementer', 'reviewer', 'implementer', 'reviewer']);
  assert.match(f.calls[2].prompt, /仍需修正边界判断/);
  assert.equal(f.notices.length, 0);
});

test('默认最多三轮返工，自定义上限和通知失败保留接力结果', async () => {
  for (const max of [undefined, 1]) {
    const reworks = max ?? 3;
    const f = fixture({ reviews: Array(reworks + 1).fill('修正测试边界。') });
    const result = await runLocalRelay({ ...input, notifyOnFinish: true, ...(max && { maxReworkRounds: max }) }, {
      ...f.deps, notify: async () => false
    });
    assert.deepEqual([result.result, result.reworkRounds, result.notified], ['round_limit', reworks, false]);
    assert.equal(f.calls.length, (reworks + 1) * 2);
  }
});

test('审批、失败、中断、未知派发回执和超时均立即停止，没有下一次派发', async () => {
  for (const [state, expected] of [
    ['waiting_approval', 'waiting_approval'], ['failed', 'failed'],
    ['interrupted', 'interrupted'], ['missing', 'timeout']
  ]) {
    const f = fixture({ observations: { implementer: state } });
    const result = await runLocalRelay({ ...input, turnTimeoutMs: 1000 }, f.deps);
    assert.equal(result.result, expected);
    assert.equal(f.calls.length, 1);
  }
  const unknown = fixture({ delivery: 'unknown' });
  assert.equal((await runLocalRelay(input, unknown.deps)).result, 'unknown');
  assert.equal(unknown.calls.length, 1);
  const approval = fixture({ status: { reviewer: 'waiting_approval' } });
  const stopped = await runLocalRelay(input, approval.deps);
  assert.deepEqual([stopped.result, stopped.phase, approval.calls.length], ['waiting_approval', 'reviewer', 0]);
});

test('本地接力校验真实工作区、拒绝无关最终回复，单独执行总时限', async () => {
  const wrong = fixture();
  wrong.deps.adapters.reviewer.status = async () => ({ ...reviewer, workspacePath: '/home/user/other', state: 'idle' });
  const rejected = await runLocalRelay(input, wrong.deps);
  assert.deepEqual([rejected.result, rejected.phase, rejected.reason], ['not_sent', 'reviewer', 'session_identity_mismatch']);
  assert.equal(wrong.calls.length, 0);

  const missing = fixture();
  missing.deps.adapters.implementer.read = async () => ({ ...implementer, messages: [
    { role: 'assistant', phase: 'final_answer', turnId: 'wrong-turn', text: 'Unrelated.' }
  ] });
  assert.equal((await runLocalRelay(input, missing.deps)).result, 'result_unavailable');
  assert.equal(missing.calls.length, 1);

  const f = fixture({ reviews: ['修正边界。', 'REVIEW_PASS'] });
  let now = 0;
  const result = await runLocalRelay({ ...input, turnTimeoutMs: 1000, totalTimeoutMs: 2100 }, {
    ...f.deps, clock: () => now, inspect: (...args) => { now += 800; return f.deps.inspect(...args); }
  });
  assert.equal(result.result, 'timeout');
  assert.equal(f.calls.length, 3);
});

test('本地接力显式 B 路只用本机连接，核对原生 turnId，桌面连接错误时不跨路', async () => {
  const conf = relayConfig({ ...input, transport: 'daemon', socketPath: '/tmp/relay-fixture.sock' });
  const f = fixture({ transport: 'daemon' });
  assert.equal((await runLocalRelay(conf, f.deps)).result, 'passed');
  assert.ok(f.watched.every(({ watch, known }) => watch.transport === 'daemon' && known === watch.turnId));
  const blocked = () => assert.fail('unexpected fallback');
  const methods = [];
  const adapters = localRelayAdapters(conf, {
    desktop: blocked,
    daemon: async config => {
      assert.equal(config.socketPath, conf.socketPath);
      return {
        async request(method, args) {
          methods.push([method, args]);
          if (method === 'thread/read') return { thread: { id: args.threadId, cwd: implementer.workspacePath, status: { type: 'idle' } } };
          if (method === 'thread/turns/list') return { data: [] };
          if (method === 'turn/start') return { turn: { id: 'native-known' } };
          assert.fail(method);
        },
        approvalPending: () => false, close() {}
      };
    }
  });
  await adapters.implementer.send({ sessionId: implementer.sessionId, expectedWorkspace: implementer.workspacePath,
    prompt: 'Fixture.', operationId: 'mock-operation', mode: 'queue' });
  assert.deepEqual(methods.map(([method]) => method), ['thread/read', 'thread/turns/list', 'turn/start']);
  assert.deepEqual(Object.keys(methods.at(-1)[1]).sort(), ['clientUserMessageId', 'input', 'threadId']);

  const offline = localRelayAdapters(relayConfig(input), {
    desktop: async () => { throw new Error('fixture offline'); }, daemon: blocked
  });
  assert.equal((await runLocalRelay(input, { adapters: offline })).result, 'failed');
});

test('本地接力拒绝不合法参数、模型或沙盒覆盖，以及桌面模式连接 daemon 路径', () => {
  for (const bad of [
    { reviewer: implementer }, { reviewer: { ...reviewer, workspacePath: 'relative' } }, { implementer: { ...implementer, model: 'fixture' } },
    { sandbox: 'fixture' }, { maxReworkRounds: 0 }, { maxReworkRounds: 11 }, { turnTimeoutMs: 999 },
    { totalTimeoutMs: 28_800_001 }, { totalTimeoutMs: 1000 }, { passMarker: 'A\nB' },
    { transport: 'daemon' }, { socketPath: '/tmp/app-server-control.sock' }, { notifyKeyPath: './fixture' }
  ]) assert.throws(() => relayConfig({ ...input, ...bad }));
});
