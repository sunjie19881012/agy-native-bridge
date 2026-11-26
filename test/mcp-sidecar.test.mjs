import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';
import { createToolInvoker } from '../src/mcp/server.mjs';
import { postSidecar } from '../src/shared/bridge-cache.mjs';
import { validateConfig } from '../src/shared/config.mjs';
import { BridgeError } from '../src/shared/errors.mjs';

const at = Date.parse('2026-11-25T00:05:00Z');
const target = '101-codex';
const args = { target, sessionId: 'fixture', prompt: 'offline fixture', expectedWorkspace: '/mock' };
const date = age => new Date(at - age).toISOString();
const session = id => ({ target, sessionId: id, state: 'idle' });

test('bridge_list 使用新缓存，超过两个周期或强制刷新时实探，离线回显标为 stale', async () => {
  let age = 59_999;
  let intervalMs = 30_000;
  let reachable = true;
  let probes = 0;
  const updates = [];
  const invoke = createToolInvoker({ [target]: {
    list: async () => {
      probes++;
      if (!reachable) throw new BridgeError('SSH_UNREACHABLE', 'fixture offline');
      return [session('live')];
    }
  } }, {
    clock: () => at,
    loadState: () => ({
      intervalMs, sampledAt: date(age), targets: { [target]: {
        reachable: true, catalog: { reachable: true, sampledAt: date(age), sessions: [session('cached'), session('cached-2')] }
      } }
    }),
    post: async (...call) => { updates.push(call); }
  });
  const cached = await invoke('bridge_list', { target, limit: 1 });
  assert.equal(cached.cacheAgeMs, 59_999);
  assert.equal(cached.stale, false);
  assert.deepEqual(cached.targets[target].sessions.map(row => row.sessionId), ['cached']);
  assert.equal(probes, 0);

  age = 60_000;
  const fresh = await invoke('bridge_list', { target });
  assert.equal(fresh.cacheAgeMs, 0);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.targets[target].sessions[0].sessionId, 'live');
  age = 1;
  await invoke('bridge_list', { target, fresh: true });
  assert.equal(probes, 2);
  await flush();
  assert.equal(updates.length, 2);
  assert.equal(updates[0][0], '/api/catalog');

  reachable = false;
  intervalMs = 600_000;
  age = 600_001;
  const fallback = await invoke('bridge_list', { target });
  assert.equal(probes, 3);
  assert.equal(fallback.cacheAgeMs, age);
  assert.equal(fallback.stale, true);
  assert.equal(fallback.targets[target].reachable, false);
  assert.equal(fallback.targets[target].error.code, 'SSH_UNREACHABLE');
  assert.equal(fallback.targets[target].sessions[0].sessionId, 'cached');
});

test('bridge_status 保持实探，附上新鲜额度，并忽略过期额度', async () => {
  let age = 299_000;
  let probes = 0;
  const invoke = createToolInvoker({ [target]: {
    status: async () => { probes++; return session('fixture'); }
  } }, { clock: () => at, loadState: () => ({ targets: {
    [target]: { rateLimits: { sampledAt: date(age), windows: { '7d': { remainingPercent: 61 } } } }
  } }) });
  assert.equal((await invoke('bridge_status', args)).rateLimits.windows['7d'].remainingPercent, 61);
  age = 600_001;
  assert.equal((await invoke('bridge_status', args)).rateLimits, undefined);
  assert.equal(probes, 2);
});

test('60 秒同内容保护覆盖并发和未知回执，独立任务或明确未发送可照常提交', async () => {
  let now = at;
  let calls = 0;
  let release;
  let result = 'accepted';
  const adapter = { send: input => {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = resolve; });
    return Promise.resolve({ result, operationId: input.operationId });
  } };
  const invoke = createToolInvoker({ [target]: adapter, 'win-codex': adapter }, {
    clock: () => now, post: async () => {}
  });
  const first = invoke('bridge_send', { ...args, operationId: 'first' });
  const duplicate = await invoke('bridge_send', { ...args, operationId: 'second', mode: 'steer' });
  assert.deepEqual(duplicate, { result: 'not_sent', reason: 'duplicate_send', operationId: 'first' });
  release({ result: 'accepted', operationId: 'first' });
  await first;
  now += 59_999;
  assert.equal((await invoke('bridge_send', args)).reason, 'duplicate_send');
  assert.equal((await invoke('bridge_send', { ...args, sessionId: 'other' })).result, 'accepted');
  assert.equal((await invoke('bridge_send', { ...args, target: 'win-codex' })).result, 'accepted');
  result = 'not_sent';
  assert.equal((await invoke('bridge_send', { ...args, prompt: 'other' })).result, 'not_sent');
  result = 'accepted';
  assert.equal((await invoke('bridge_send', { ...args, prompt: 'other' })).result, 'accepted');
  now += 1;
  result = 'unknown';
  assert.equal((await invoke('bridge_send', args)).result, 'unknown');
  assert.equal((await invoke('bridge_send', args)).reason, 'duplicate_send');
  assert.equal(calls, 6);
});

test('派发或中断成功时异步补探，Sidecar 请求异常不改变回执', async () => {
  const notifications = [];
  const invoke = createToolInvoker({ [target]: {
    send: async () => ({ result: 'accepted', turnId: null, beforeTurnId: 'older' }),
    interrupt: async () => ({ result: 'accepted', turnId: 'active' })
  } }, { env: {}, post: (...call) => {
    notifications.push(call);
    if (notifications.length === 1) return new Promise(() => {});
    throw new Error('fixture disconnect');
  } });
  assert.equal((await invoke('bridge_send', args)).result, 'accepted');
  assert.equal((await invoke('bridge_interrupt', args)).result, 'accepted');
  await flush();
  assert.deepEqual(notifications, [
    ['/api/nudge', { action: 'send', target, sessionId: 'fixture', workspacePath: '/mock', mode: 'queue', turnId: null, beforeTurnId: 'older' }],
    ['/api/nudge', { action: 'interrupt', target, sessionId: 'fixture', turnId: 'active' }]
  ]);
});

test('MCP 只在已确认派发时附带宿主对话和可选自动读取，原生请求无宿主元数据', async () => {
  const notifications = [];
  const native = [];
  const invoke = createToolInvoker({ [target]: {
    send: async value => {
      native.push(value);
      return { result: value.prompt === 'unknown fixture' ? 'unknown' : 'accepted', turnId: 'new-turn' };
    }
  } }, {
    env: { ANTIGRAVITY_CONVERSATION_ID: 'fixture_chat', ANTIGRAVITY_PROJECT_ID: 'fixture_project' },
    post: (route, body) => { notifications.push([route, body]); }
  });
  await invoke('bridge_send', { ...args, autoReadOnFinish: true });
  await invoke('bridge_send', { ...args, prompt: 'explicit off', autoReadOnFinish: false });
  await invoke('bridge_send', { ...args, prompt: 'omitted' });
  await invoke('bridge_send', { ...args, prompt: 'unknown fixture', autoReadOnFinish: true });
  await flush();
  assert.equal(notifications.length, 3);
  assert.deepEqual(notifications.map(([route, body]) => [route, body.conversationId, body.projectId, body.autoReadOnFinish]), [
    ['/api/nudge', 'fixture_chat', 'fixture_project', true],
    ['/api/nudge', 'fixture_chat', 'fixture_project', false],
    ['/api/nudge', 'fixture_chat', 'fixture_project', undefined]
  ]);
  assert.ok(native.every(value => !('conversationId' in value) && !('autoReadOnFinish' in value)));
});

test('自动读取默认上限为五，可在 sidecar 配置中限为 1 到 20', () => {
  assert.equal(validateConfig({}).sidecar.maxAutoReads, 5);
  for (const maxAutoReads of [1, 20]) assert.equal(validateConfig({ sidecar: { maxAutoReads } }).sidecar.maxAutoReads, maxAutoReads);
  for (const maxAutoReads of [0, 21, '5', 2.5, null]) {
    assert.throws(() => validateConfig({ sidecar: { maxAutoReads } }), { code: 'INVALID_CONFIG' });
  }
});

test('本地 nudge 只读取运行时端口并访问 127.0.0.1，失败返回 false', async () => {
  const token = '1'.repeat(64);
  const read = async name => { assert.equal(name, 'sidecar-runtime.json'); return { port: 40960, nudgeToken: token }; };
  assert.equal(await postSidecar('/api/nudge', { action: 'send' }, {
    read, fetch: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:40960/api/nudge');
      assert.equal(options.headers['X-Bridge-Token'], token);
      assert.equal(options.redirect, 'error');
      return { ok: true };
    }
  }), true);
  assert.equal(await postSidecar('/api/nudge', {}, { read, fetch: async () => { throw new Error('offline'); } }), false);
  assert.equal(await postSidecar('/api/nudge', {}, { read: async () => null, fetch: () => assert.fail('missing runtime') }), false);
});
