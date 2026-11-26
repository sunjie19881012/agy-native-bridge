import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { startRemoteWatcher } from '../src/adapters/remote-watcher.mjs';
import { inspectWatchedTurn, notifyServerChan, readNotifyKey, watcherOptions, watchTurn } from '../src/adapters/watcher-runtime.mjs';
import { createToolInvoker } from '../src/mcp/server.mjs';

const receipt = {
  sessionId: 'fixture-session', expectedWorkspace: '/test/fixture', operationId: 'fixture-op', beforeTurnId: 'previous'
};
const options = watcherOptions({ ...receipt, transport: 'desktop-pipe', watcherTimeoutMs: 60_000 });
const mockKey = 'SCTtest_fixture_12345';

test('101 守望每 15 秒只观察同一轮，待审批只提醒一次，结束立即返回', async () => {
  let now = 500;
  const notices = [];
  const calls = [];
  const pauses = [];
  const approval = { turnId: 'new', status: 'inProgress', waitingApproval: true };
  const observations = [approval, approval, { turnId: 'unrelated', status: 'completed' }, { turnId: 'new', status: 'completed' }];
  const result = await watchTurn(options, {
    clock: () => now,
    async sleep(ms) { pauses.push(ms); now += ms; },
    async inspect(_, known) { calls.push(known); return observations.shift(); },
    async notify(title, body) { notices.push([title, body]); return true; }
  });
  assert.deepEqual(calls, [null, 'new', 'new', 'new']);
  assert.deepEqual(pauses, [15_000, 15_000, 15_000]);
  assert.deepEqual(result, { result: 'completed', notified: true, turnId: 'new' });
  assert.deepEqual(notices.map(entry => entry[0]), ['101 Codex · 等待原窗口审批', '101 Codex · 任务已完成']);
  assert.equal(notices[0][1], '会话 fixture-session\n派发编号 fixture-op\n轮次 new');
});

test('守望终态包括失败、中断，连续无法读取时到截止时间发送超时并退出', async () => {
  for (const status of ['failed', 'interrupted']) {
    const result = await watchTurn(options, {
      inspect: async () => ({ turnId: 'new', status }), sleep: () => assert.fail('unexpected extra poll'),
      notify: async () => { throw new Error(mockKey); }
    });
    assert.deepEqual(result, { result: status, notified: false, turnId: 'new' });
  }
  let now = 0;
  let polls = 0;
  const notices = [];
  const result = await watchTurn({ ...options, watcherTimeoutMs: 15_003 }, {
    clock: () => now,
    async sleep(ms) { now += ms; },
    async inspect() { polls++; throw new Error('transient fixture'); },
    async notify(title) { notices.push(title); return true; }
  });
  assert.deepEqual([now, polls], [15_003, 2]);
  assert.deepEqual(notices, ['101 Codex · 轮次守望超时']);
  assert.deepEqual(result, { result: 'timeout', notified: true, turnId: null });
  assert.throws(() => watcherOptions({ ...options, watcherTimeoutMs: 28_800_001 }), /Invalid watcher options/);
});

test('守望 A 路匹配原生用户消息派发标识，B 路只查明确的 turn.id，拒绝跨路', async () => {
  const calls = [];
  const thread = { id: receipt.sessionId, cwd: receipt.expectedWorkspace, status: { type: 'active', activeFlags: ['waitingOnApproval'] } };
  const forbidden = () => assert.fail('unexpected transport');
  const desktop = async (config, id) => {
    assert.equal(config.transport, 'desktop-pipe');
    assert.equal(id, receipt.sessionId);
    return {
      async call(method, params) {
        calls.push([method, params]);
        return { thread, page: { order: 'newest_first' }, turns: [{ id: 'previous', status: 'inProgress',
          items: [{ type: 'userMessage', content: [{ type: 'text', text: '[AGY_BRIDGE_OP:fixture-op]\nfixture prompt' }] }]
        }] };
      },
      close() { calls.push(['close']); }
    };
  };
  assert.deepEqual(await inspectWatchedTurn(options, null, 5000, { desktop, daemon: forbidden }),
    { turnId: 'previous', status: 'inProgress', waitingApproval: true });
  assert.equal(calls[0][0], 'read_thread');
  assert.equal(calls[0][1].turnLimit, 1);
  assert.equal(calls[0][1].includeOutputs, false);
  assert.deepEqual(calls[1], ['close']);
  await assert.rejects(inspectWatchedTurn(options, null, 5000, {
    desktop: async () => { throw new Error('offline fixture'); }, daemon: forbidden
  }), /offline fixture/);

  const methods = [];
  const daemon = async config => {
    assert.equal(config.transport, 'daemon');
    return {
      async request(method, params) {
        methods.push(method);
        return method === 'thread/read' ? { thread } : {
          data: [{ id: params.cursor ? 'exact' : 'newer', status: 'completed' }], nextCursor: params.cursor ? null : 'older'
        };
      },
      close() { methods.push('close'); }
    };
  };
  const fallback = watcherOptions({ ...options, transport: 'daemon', socketPath: '/tmp/daemon.sock', turnId: 'exact' });
  assert.deepEqual(await inspectWatchedTurn(fallback, 'exact', 5000, { desktop: forbidden, daemon }),
    { turnId: 'exact', status: 'completed', waitingApproval: false });
  assert.deepEqual(methods, ['thread/read', 'thread/turns/list', 'thread/turns/list', 'close']);
});

test('守望的截止时间能结束不返回的原生读取，CLI 无有效密钥时直接退出', async () => {
  const result = await watchTurn({ ...options, watcherTimeoutMs: 20 }, {
    inspect: () => new Promise(() => {}), notify: async () => true
  });
  assert.equal(result.result, 'timeout');

  const missingHome = path.resolve('test', 'missing-key-' + randomUUID());
  const child = spawnSync(process.execPath, [path.resolve('scripts', '101-turn-watcher.mjs'), JSON.stringify(options)], {
    encoding: 'utf8', timeout: 3000,
    env: { ...process.env, USERPROFILE: missingHome, HOME: missingHome, SCT_KEY: 'SCTxxxPLACEHOLDER' }
  });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { result: 'skipped', reason: 'notify_key_unavailable' });
});

test('Server酱只从允许来源读取 SendKey，拒绝占位，提交固定表单并隐藏错误中的 key', async () => {
  const files = [];
  const read = async file => { files.push(file); return file.endsWith('.sct-key') ? 'SCTxxx_PLACEHOLDER' : "SCT_KEY='" + mockKey + "'\n"; };
  assert.equal(await readNotifyKey('/fixture/key', { env: { SCT_KEY: mockKey }, home: '/mock', read }), mockKey);
  assert.deepEqual(files, []);
  assert.equal(await readNotifyKey('/fixture/key', { env: { SCT_KEY: 'SCTxxxINVALID' }, home: '/mock', read }), mockKey);
  assert.equal(files.length, 2);
  assert.equal(await readNotifyKey(undefined, { env: {}, home: '/mock', read }), null);
  const fetch = async (url, request) => {
    assert.equal(url, 'https://sctapi.ftqq.com/' + mockKey + '.send');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.deepEqual(Object.fromEntries(request.body), { title: 'mock title', desp: 'mock status', noip: '1' });
    return Response.json({ code: 0 });
  };
  assert.equal(await notifyServerChan(mockKey, 'mock title', 'mock status', { fetch }), true);
  assert.equal(await notifyServerChan(mockKey, 'mock title', 'mock status', { fetch: async () => Response.json({ code: '0' }) }), false);
  assert.equal(await notifyServerChan(mockKey, '', '', { fetch: async () => { throw new Error(mockKey); } }), false);
  assert.equal(await notifyServerChan('SCTxxxPLACEHOLDER', '', '', { fetch: () => assert.fail('invalid key must not be sent') }), false);
});

test('启动守望只用一条短 SSH，经 stdin 提供代码和身份，nohup 回执不包含 key 或正文', async () => {
  const config = { sshTarget: '101-fixture', transport: 'desktop-pipe', requestTimeoutMs: 1000, notifyKeyPath: '/fixture/path' };
  let count = 0;
  let bundle;
  const spawnProcess = (program, args, options) => {
    count++;
    assert.equal(program, 'ssh');
    assert.equal(args[0], '-T');
    assert.equal(args.at(-2), config.sshTarget);
    assert.match(args.at(-1), /nohup/);
    assert.equal(args.join(' ').includes(mockKey), false);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
    const child = new EventEmitter();
    child.kill = () => assert.fail('mock SSH returns normally');
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _, cb) {
        bundle = JSON.parse(chunk);
        child.stdout.end('AGY_WATCHER_STARTED\n');
        cb();
        queueMicrotask(() => child.emit('close', 0));
      }
    });
    return child;
  };
  const result = await startRemoteWatcher(config, { ...receipt, prompt: 'private prompt', SCT_KEY: mockKey }, { spawnProcess });
  assert.deepEqual(result, { started: true });
  assert.equal(count, 1);
  assert.equal(bundle.options.notifyKeyPath, '/fixture/path');
  assert.ok(bundle.files.some(([name]) => name === 'scripts/101-turn-watcher.mjs'));
  assert.ok(bundle.files.some(([name]) => name === 'node_modules/ws/package.json'));
  assert.equal(JSON.stringify(bundle).includes('private prompt'), false);
  assert.equal(JSON.stringify(bundle).includes(mockKey), false);
  assert.deepEqual(await startRemoteWatcher(config, receipt, {
    loadFiles: async () => [], spawnProcess: () => { throw new Error(mockKey); }
  }), { started: false, reason: 'watcher_launch_failed' });
});

test('MCP 只在 101 原生 accepted 后启动 opted-in 守望，启动失败不改变回执或重投', async () => {
  const sent = [];
  const launches = [];
  const adapter = { async send(args) {
    sent.push(args);
    return { result: args.prompt === 'ambiguous' ? 'unknown' : 'accepted', turnId: null, beforeTurnId: 'previous' };
  } };
  const invoke = createToolInvoker({ '101-codex': adapter, 'win-codex': adapter }, {
    loadState: () => null, post: () => {},
    async launchWatcher(args) { launches.push(args); throw new Error(mockKey); }
  });
  const args = { ...receipt, target: '101-codex', prompt: 'private prompt', notifyOnFinish: true };
  const result = await invoke('bridge_send', args);
  assert.deepEqual(result, { result: 'accepted', turnId: null, beforeTurnId: 'previous',
    notifyWatcher: { started: false, reason: 'watcher_launch_failed' } });
  assert.deepEqual(launches, [{ ...receipt, turnId: null }]);
  assert.equal((await invoke('bridge_send', args)).reason, 'duplicate_send');
  assert.equal((await invoke('bridge_send', { ...args, prompt: 'ambiguous' })).result, 'unknown');
  assert.equal((await invoke('bridge_send', { ...args, target: 'win-codex' })).notifyWatcher, undefined);
  assert.equal(sent.length, 3);
  assert.equal(launches.length, 1);
});
