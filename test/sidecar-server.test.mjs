import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';
import { sendHostMessage } from '../src/sidecar/auto-read.mjs';
import { readConversationTitle } from '../src/sidecar/conversation-title.mjs';
import { startSidecar } from '../src/sidecar/server.mjs';

const target = '101-codex';
const id = 'fixture-session';
const lastTurn = 'fixture-turn';
const uiToken = 'host-ui-token';
const runtimeName = 'sidecar-runtime.json';

function endpointRequest(app, method, route, value, headers = {}) {
  const address = app.server.address();
  const options = typeof address === 'string' ? { socketPath: address } : { hostname: '127.0.0.1', port: address.port };
  return new Promise((resolve, reject) => {
    const request = http.request({
      ...options, method, path: route,
      headers: { Host: '127.0.0.1:' + app.port, 'X-Sidecar-Token': uiToken,
        ...(value !== undefined && { 'Content-Type': 'application/json' }), ...headers }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, body: response.headers['content-type']?.includes('json') ? JSON.parse(text) : text });
      });
    });
    request.on('error', reject);
    request.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

async function fixture(t, saved = {}, configuredDsh, { env = {}, sendMessage, readPage, sidecar, lookupTitle } = {}) {
  const initialAt = 1_761_000_000_000;
  let now = initialAt;
  let latest = { id: lastTurn, status: 'inProgress' };
  let state = 'active';
  const files = new Map(Object.entries(saved));
  const probes = [];
  const extraSessions = [];
  const offline = new Set();
  const notices = [];
  const reads = [];
  const wakes = [];
  const tasks = new Map();
  let sequence = 0;
  const heartbeat = host => async args => {
    probes.push({ host, ...args });
    if (offline.has(host)) throw new Error('offline fixture');
    const catalog = host === target ? [{
      target: host, sessionId: id, workspacePath: '/mock', title: 'Mock', state,
      activeTurnId: state === 'idle' ? null : latest.id, latestTurn: latest
    }] : [];
    const extra = extraSessions.filter(row => row.target === host);
    return {
      sessions: [...catalog, ...extra.filter(row => args.sessionIds.includes(row.sessionId))],
      catalog: [...catalog, ...extra], quota: { rateLimits: { secondary: { usedPercent: 22, windowDurationMins: 10080 } } }
    };
  };
  const app = await startSidecar({
    port: process.platform === 'win32' ? 41112 : 0, uiToken, clock: () => now, env,
    config: { workspaces: { [target]: { fixed: '/fixture' } }, sidecar },
    lookupTitle,
    async sendMessage(...args) { wakes.push(args); await sendMessage?.(...args); },
    adapters: { [target]: { heartbeat: heartbeat(target), read: async (...args) => {
      reads.push(args);
      return readPage ? readPage(latest.id) : {
        messages: [{ text: 'safe answer', role: 'assistant', turnId: latest.id }], pageTruncated: false
      };
    } }, 'win-codex': { heartbeat: heartbeat('win-codex') },
    ...(configuredDsh && { [configuredDsh]: { heartbeat: heartbeat(configuredDsh) } }) },
    timers: {
      setTimeout(fn, delay) { const key = ++sequence; tasks.set(key, { fn, delay }); return key; },
      clearTimeout(key) { tasks.delete(key); }
    },
    notify: events => notices.push(...events),
    read: async key => files.get(key),
    write: async (file, data) => { files.set(path.basename(file), structuredClone(data)); },
    remove: async file => { files.delete(path.basename(file)); },
    listen: server => process.platform === 'win32'
      ? server.listen('\\\\.\\pipe\\agy-sidecar-fixture-' + randomUUID())
      : server.listen({ host: '127.0.0.1', port: 0 })
  });
  t.after(() => app.close());
  return {
    app, probes, notices, reads, wakes, files, tasks, offline, extraSessions,
    tick: delta => { now += delta; },
    observe(value, turnId, status = 'inProgress') { state = value; latest = { id: turnId, status }; },
    conclude: () => { state = 'idle'; latest = { id: lastTurn, status: 'completed' }; },
    request: (...args) => endpointRequest(app, ...args)
  };
}

test('生产默认绑定 127.0.0.1 的系统分配端口，关闭后清理运行时记录', { timeout: 10_000 }, async t => {
  const files = new Map();
  const app = await startSidecar({
    config: {}, adapters: {}, env: {},
    read: async key => key === 'prefs.json' ? { paused: true } : files.get(key),
    write: async (file, data) => { files.set(path.basename(file), data); },
    remove: async file => { files.delete(path.basename(file)); }
  });
  t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.ok(app.port > 0 && app.port <= 65_535);
  assert.equal(files.get(runtimeName).port, app.port);
  await app.close();
  assert.equal(files.has(runtimeName), false);
});

test('星标空闲会话超过 15 分钟仍由心跳读取，隐藏后取消仅由星标触发的读取', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const favorite = { target, sessionId: 'favorite', title: 'Idle favorite', workspacePath: '/mock', state: 'idle' };
  const refresh = () => f.request('POST', '/api/refresh?reason=manual', {});
  f.conclude();
  f.extraSessions.push(favorite);
  const before = await refresh();
  assert.equal(before.body.targets[target].catalog.sessions.some(row => row.sessionId === favorite.sessionId), true);
  assert.equal(before.body.targets[target].sessions.some(row => row.sessionId === favorite.sessionId), false);
  await f.request('POST', '/api/prefs', { target, sessionId: favorite.sessionId, starred: true });
  await refresh();
  f.tick(15 * 60_000 + 1);
  const after = await refresh();
  assert.ok(f.probes.findLast(call => call.host === target).sessionIds.includes(favorite.sessionId));
  assert.equal(after.body.targets[target].sessions.find(row => row.sessionId === favorite.sessionId).state, 'idle');
  await f.request('POST', '/api/prefs', { target, sessionId: favorite.sessionId, hidden: true });
  await refresh();
  assert.ok(!f.probes.findLast(call => call.host === target).sessionIds.includes(favorite.sessionId));
});

test('从 catalog 读取空闲会话的最近一轮，未知会话不会触发原生读取', { timeout: 10_000 }, async t => {
  const f = await fixture(t, {
    'state.json': { targets: { [target]: {
      reachable: true,
      sessions: [],
      catalog: { sessions: [{ target, sessionId: 'catalog-only', state: 'idle' }] }
    } } }
  });
  const reply = await f.request('GET', '/api/summary?target=101-codex&sessionId=catalog-only');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.messages, [{ text: 'safe answer', role: 'assistant', turnId: lastTurn }]);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0][0], 'catalog-only');
  assert.equal((await f.request('GET', '/api/summary?target=101-codex&sessionId=missing')).status, 404);
  assert.equal(f.reads.length, 1);
});

test('侧栏优先用监控状态去重，目录空闲会话进入抽屉并限制显示 20 条', () => {
  const html = readFileSync(new URL('../src/sidecar/ui.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  const start = script.indexOf('  function groupSessions(');
  const end = script.indexOf('  function sessionDrawer(', start);
  const groups = new Function(script.slice(start, end) + '\nreturn groupSessions;')();
  const idle = Array.from({ length: 22 }, (_, i) => ({ sessionId: 'idle-' + i, state: 'idle' }));
  const info = {
    sessions: [{ sessionId: 'duplicate', state: 'active' }, { sessionId: 'unread', state: 'idle',
      outcome: 'completed', unread: { kind: 'completed' } }],
    catalog: { sessions: [
      ...idle, { sessionId: 'duplicate', state: 'idle' }, { sessionId: 'approval', state: 'waiting_approval' },
      { sessionId: 'star', state: 'idle' }, { sessionId: 'hidden', state: 'idle' }
    ] }
  };
  const grouped = groups(info, row => ({ starred: row.sessionId === 'star', hidden: row.sessionId === 'hidden' }));
  assert.deepEqual(grouped.visible.map(row => [row.sessionId, row.state]), [
    ['approval', 'waiting_approval'], ['duplicate', 'active'], ['unread', 'idle'], ['star', 'idle']
  ]);
  assert.deepEqual(grouped.hidden.map(row => row.sessionId), ['hidden']);
  assert.equal(grouped.recentCount, 22);
  assert.equal(grouped.recent.length, 20);
  assert.equal(grouped.total, 27);
  assert.equal(groups({ sessions: [], catalog: { sessions: idle } }, () => ({})).recent.length, 20);
});

test('侧栏模糊搜索支持多词子串与顺序模糊匹配，并能搜出 20 条上限之后的会话', () => {
  const html = readFileSync(new URL('../src/sidecar/ui.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  const start = script.indexOf('  function groupSessions(');
  const end = script.indexOf('  function sessionDrawer(', start);
  const { groupSessions, matchesQuery } = new Function(script.slice(start, end) + '\nreturn { groupSessions, matchesQuery };')();
  const tail = { sessionId: 'tail-recipe-id', title: '推进 Sample Recipe 分析任务', workspacePath: '/home/user/work/task', state: 'unknown' };
  const hidden = { sessionId: 'hidden-recipe-id', title: '已隐藏 Sample 任务', workspacePath: '/home/user/work/task', state: 'unknown' };
  const padding = Array.from({ length: 24 }, (_, i) => ({ sessionId: 'pad-' + i, title: '无关会话 ' + i, workspacePath: '/tmp', state: 'unknown' }));
  const info = { sessions: [], catalog: { sessions: [...padding, tail, hidden] } };
  const pref = row => ({ hidden: row.sessionId === 'hidden-recipe-id' });

  assert.equal(matchesQuery(tail, 'sample task'), true);
  assert.equal(matchesQuery(tail, 'srp'), true);
  assert.equal(matchesQuery(tail, 'not-present'), false);

  const searched = groupSessions(info, pref, 'sample');
  assert.equal(searched.matched, 2);
  assert.deepEqual(searched.visible.map(row => row.sessionId), ['tail-recipe-id']);
  assert.deepEqual(searched.hidden.map(row => row.sessionId), ['hidden-recipe-id']);
  assert.equal(searched.recent.length, 0);
});

test('Sidecar 入口忽略 stdout 和 stderr 的 EPIPE，保留其他错误', async () => {
  const entry = readFileSync(new URL('../sidecars/native_bridge/entry.mjs', import.meta.url), 'utf8');
  const source = entry.slice(entry.indexOf('\n') + 1);
  const processFixture = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const run = new Function('process', 'runSidecar', 'return (async () => {\n' + source + '\n})();');
  await run(processFixture, async () => {});
  for (const stream of [processFixture.stdout, processFixture.stderr]) {
    assert.doesNotThrow(() => stream.emit('error', { code: 'EPIPE' }));
    assert.throws(() => stream.emit('error', { code: 'EIO' }), { code: 'EIO' });
  }
});

test('Sidecar 声明是 AUX_PANE，HTTP 服务保护运行时、状态和偏好', { timeout: 10_000 }, async t => {
  const manifest = JSON.parse(readFileSync(new URL('../sidecars/native_bridge/sidecar.json', import.meta.url)));
  assert.equal(manifest.command, 'node');
  assert.deepEqual(manifest.args, ['entry.mjs']);
  assert.equal(manifest.has_web_ui, true);
  assert.equal(manifest.restart_policy, 'always');
  assert.equal(manifest.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');

  const f = await fixture(t);
  const runtime = f.files.get(runtimeName);
  assert.equal(runtime.port, f.app.port);
  assert.equal(runtime.pid, process.pid);
  assert.match(runtime.nudgeToken, /^[a-f0-9]{64}$/);
  assert.ok(runtime.updatedAt);
  const page = await f.request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /prefers-color-scheme: dark/);
  assert.doesNotThrow(() => new Function(page.body.split('<script>')[1].split('</script>')[0]));
  assert.equal((await f.request('GET', '/api/state', undefined, { 'X-Sidecar-Token': 'wrong' })).status, 401);
  assert.equal((await f.request('GET', '/api/state', undefined, { Host: 'attacker.invalid' })).status, 403);
  assert.equal((await f.request('GET', '/api/state', undefined, { Host: 'localhost.attacker.invalid' })).status, 403);
  for (const proxyHost of ['127.0.0.1:59999', 'localhost:59999', '[::1]:59999', 'localhost']) {
    assert.equal((await f.request('GET', '/', undefined, { Host: proxyHost })).status, 200);
  }
  assert.equal((await f.request('POST', '/api/nudge', { action: 'send', target, sessionId: id })).status, 401);

  const first = await f.request('POST', '/api/refresh?reason=focus', {});
  assert.equal(first.body.skipped, false);
  assert.equal(first.body.targets[target].sessions[0].state, 'active');
  assert.equal(first.body.targets[target].rateLimits.windows['7d'].remainingPercent, 78);
  assert.equal(f.probes[0].includeQuota, true);
  assert.deepEqual(f.probes[0].sessionIds, ['fixed']);
  assert.equal((await f.request('POST', '/api/refresh?reason=focus', {})).body.skipped, true);
  assert.equal(f.reads.length, 0);
  await f.request('POST', '/api/prefs', { target, sessionId: id, starred: true, hidden: true });
  await f.request('POST', '/api/prefs', { paused: true, notifications: true });
  assert.deepEqual(f.files.get('prefs.json'), { paused: true, notifications: true, sessions: { [target + ':' + id]: { starred: true, hidden: true } } });
  f.conclude();
  f.tick(300_000);
  const manual = await f.request('POST', '/api/refresh?reason=manual', {});
  assert.equal(manual.body.targets[target].sessions[0].unread.kind, 'completed');
  assert.equal(f.notices[0].kind, 'completed');
  assert.equal(f.probes.at(-2).includeQuota, true);
  const summary = await f.request('GET', '/api/summary?target=101-codex&sessionId=fixture-session');
  assert.equal(summary.body.messages[0].text, 'safe answer');
  assert.equal(f.reads.length, 1);
  assert.equal(f.files.get('state.json').targets[target].sessions[0].unread, null);
  await f.app.close();
  assert.equal(f.files.has(runtimeName), false);
});

test('授权的 nudge 记录未完成派发，触发即时与两次补探并继续使用同一份快照', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const headers = { 'X-Bridge-Token': f.files.get(runtimeName).nudgeToken };
  assert.equal((await f.request('POST', '/api/nudge', { action: 'send' }, headers)).status, 400);
  const sent = await f.request('POST', '/api/nudge', {
    action: 'send', target, sessionId: id, workspacePath: '/mock', mode: 'queue', beforeTurnId: 'older'
  }, headers);
  assert.equal(sent.status, 202);
  await flush();
  assert.deepEqual(f.probes.find(call => call.host === target).sessionIds, ['fixed', id]);
  assert.ok(f.files.get('state.json').targets[target].sessions[0].tracking);
  const delays = [...f.tasks.values()].map(task => task.delay);
  assert.ok(delays.includes(5000) && delays.includes(15_000));
  for (const delay of [5000, 15_000]) {
    f.tick(delay);
    const [key, task] = [...f.tasks].find(([, job]) => job.delay === delay);
    f.tasks.delete(key);
    task.fn();
    await flush();
  }
  assert.equal(f.probes.filter(call => call.host === target).length, 3);
  assert.equal(f.probes.filter(call => call.includeQuota).length, 2);
  const sampledAt = f.files.get('state.json').sampledAt;
  assert.equal((await f.request('POST', '/api/catalog', {
    sampledAt, targets: { [target]: { reachable: true, sessions: [{ sessionId: 'from fresh list' }] } }
  }, headers)).status, 202);
  assert.equal(f.files.get('state.json').targets[target].catalog.sessions[0].sessionId, 'from fresh list');
  f.files.set(runtimeName, { nudgeToken: 'new instance' });
  await f.app.close();
  assert.equal(f.files.get(runtimeName).nudgeToken, 'new instance');
});

test('单端连续离线单独退避，另一端活动会话仍按 30 秒探测', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  f.offline.add('win-codex');
  await f.request('POST', '/api/refresh?reason=manual', {});
  await f.request('POST', '/api/refresh?reason=manual', {});
  const previous = f.files.get('state.json');
  assert.equal(previous.intervalMs, 30_000);
  assert.equal(previous.targets['win-codex'].failures, 2);
  f.tick(30_000);
  const next = await f.request('POST', '/api/refresh?reason=focus', {});
  assert.equal(next.body.intervalMs, 30_000);
  assert.equal(f.probes.filter(call => call.host === 'win-codex').length, 2);
  assert.equal(f.probes.filter(call => call.host === target).length, 3);
  f.tick(570_000);
  f.offline.delete('win-codex');
  const retry = await f.request('POST', '/api/refresh?reason=focus', {});
  assert.equal(retry.body.targets['win-codex'].failures, 0);
  assert.equal(retry.body.targets['win-codex'].reachable, true);
});

test('Sidecar 只探测配置的 DSH 端，丢弃未配置目标的残留快照并接收新建补探', async t => {
  const configuredDsh = '101-dsh';
  const f = await fixture(t, { 'state.json': { targets: { 'win-dsh': {
    reachable: false, sessions: [{ sessionId: 'old', state: 'offline' }]
  } } } }, configuredDsh);
  const dshRow = { target: configuredDsh, sessionId: 'dsh-fixture', workspacePath: '/mock', state: 'idle' };
  f.extraSessions.push(dshRow);
  const state = (await f.request('POST', '/api/refresh?reason=manual', {})).body;
  assert.deepEqual(Object.keys(state.targets).sort(), ['101-codex', '101-dsh', 'win-codex']);
  assert.deepEqual(state.targets[configuredDsh].catalog.sessions, [dshRow]);
  assert.equal(f.probes.some(call => call.host === 'win-dsh'), false);

  const headers = { 'X-Bridge-Token': f.files.get(runtimeName).nudgeToken };
  const result = await f.request('POST', '/api/nudge', {
    target: configuredDsh, action: 'create', sessionId: dshRow.sessionId, workspacePath: dshRow.workspacePath, tracking: true
  }, headers);
  assert.equal(result.status, 202);
  await flush();
  assert.ok(f.files.get('state.json').targets[configuredDsh].sessions[0].tracking);
});


const autoReadKey = target + ':' + id;
const autoReadSetting = (f, values) => f.request('POST', '/api/prefs', { target, sessionId: id, ...values });
const autoReadPref = f => f.files.get('prefs.json')?.sessions[autoReadKey];
async function probe(f) {
  const result = await f.request('POST', '/api/refresh?reason=manual', {});
  assert.equal(result.status, 200);
  assert.ok(!result.body.error);
  await flush();
  return result.body;
}

test('自动读取默认关闭，只监控已开启且未隐藏的会话', async t => {
  const f = await fixture(t);
  await probe(f);
  f.conclude();
  await probe(f);
  assert.equal(f.reads.length, 0);
  assert.equal(f.wakes.length, 0);
  assert.equal(autoReadPref(f), undefined);

  const catalog = { target, sessionId: 'auto-read-only', workspacePath: '/mock', state: 'idle' };
  f.extraSessions.push(catalog);
  await f.request('POST', '/api/prefs', { target, sessionId: catalog.sessionId, autoRead: true, conversationId: 'sandbox_chat' });
  await probe(f);
  assert.ok(f.probes.filter(call => call.host === target).at(-1).sessionIds.includes(catalog.sessionId));
  await f.request('POST', '/api/prefs', { target, sessionId: catalog.sessionId, hidden: true });
  await probe(f);
  assert.ok(!f.probes.filter(call => call.host === target).at(-1).sessionIds.includes(catalog.sessionId));
});

test('手动、MCP 与自动读取建立会话配对，自定义标签跨窗口保留', async t => {
  const requests = [];
  const f = await fixture(t, {}, undefined, { lookupTitle: async conversationId => {
    requests.push(conversationId);
    if (conversationId === 'unavailable_chat') throw new Error('offline fixture');
    return 'Title\u0000 ' + conversationId + ' password=synthetic-value ' + 'z'.repeat(100);
  } });
  const missing = await autoReadSetting(f, { pairCurrent: true });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /请先打开/);
  for (const fields of [{ pairedConversationId: '--help' }, { pairedConversationId: 'not/a/chat' },
    { pairCurrent: 'false' }, { pairLabel: 99 }]) {
    assert.equal((await autoReadSetting(f, fields)).status, 400);
  }
  const saved = await autoReadSetting(f, { pairCurrent: true, conversationId: 'first_chat',
    pairLabel: '我的标签\u001b token=example-value ' + '界'.repeat(80) });
  await flush();
  assert.equal(saved.status, 200);
  assert.equal(autoReadPref(f).pairedConversationId, 'first_chat');
  assert.ok(Date.parse(autoReadPref(f).pairedAt));
  assert.match(autoReadPref(f).pairedConversationTitle, /Title first_chat password=\[已遮盖\]/);
  assert.equal(Array.from(autoReadPref(f).pairedConversationTitle).length, 80);
  assert.equal(Array.from(autoReadPref(f).pairLabel).length, 32);
  const label = autoReadPref(f).pairLabel;
  assert.doesNotMatch(label, /example-value|\u001b/);

  const headers = { 'X-Bridge-Token': f.files.get(runtimeName).nudgeToken };
  f.tick(1000);
  const send = { target, sessionId: id, workspacePath: '/mock', action: 'send', conversationId: 'unavailable_chat' };
  assert.equal((await f.request('POST', '/api/nudge', send, headers)).status, 202);
  await flush();
  assert.equal(autoReadPref(f).pairedConversationId, 'unavailable_chat');
  assert.equal(autoReadPref(f).pairedConversationTitle, null);
  assert.equal(autoReadPref(f).pairLabel, label);
  assert.notEqual(autoReadPref(f).pairedAt, saved.body.prefs.sessions[autoReadKey].pairedAt);

  const otherKey = target + ':created';
  await f.request('POST', '/api/nudge', { ...send, action: 'create', sessionId: 'created', conversationId: 'create_chat' }, headers);
  await flush();
  assert.equal(f.files.get('prefs.json').sessions[otherKey].pairedConversationId, 'create_chat');
  await autoReadSetting(f, { autoRead: true, conversationId: 'wake_chat' });
  assert.equal(autoReadPref(f).pairedConversationId, 'wake_chat');
  assert.equal(autoReadPref(f).autoReadConversationId, 'wake_chat');
  await autoReadSetting(f, { pairedConversationId: 'explicit_chat' });
  assert.equal(autoReadPref(f).pairedConversationId, 'explicit_chat');
  assert.equal(autoReadPref(f).autoReadConversationId, 'wake_chat');
  await autoReadSetting(f, { pairCurrent: false });
  await flush();
  assert.equal(autoReadPref(f).pairedConversationId, null);
  assert.equal(autoReadPref(f).pairedConversationTitle, null);
  assert.equal(autoReadPref(f).pairLabel, label);
  assert.ok(requests.includes('create_chat'));
  assert.ok(requests.includes('unavailable_chat'));
});

test('ConversationService 标题只读查询限制为本机，优先 annotations 后回退 summary', async () => {
  const env = { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:4555', ANTIGRAVITY_CSRF_TOKEN: 'mock-csrf' };
  const query = async payload => readConversationTitle('fixture_chat', { env, fetch: async (url, options) => {
    assert.equal(url.href, 'http://127.0.0.1:4555/product.v1.ConversationService/GetConversation');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Connect-Protocol-Version'], '1');
    assert.equal(options.headers['x-antigravity-csrf-token'], env.ANTIGRAVITY_CSRF_TOKEN);
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(JSON.parse(options.body), { conversationId: 'fixture_chat' });
    return Response.json(payload);
  } });
  assert.equal(await query({ conversation: { annotations: { title: 'Example \u202e title' }, state: { summary: 'Fallback' } } }), 'Example title');
  assert.equal(await query({ state: { summary: 'Summary' } }), 'Summary');
  assert.equal(await query({ annotations: { title: 'Title mock-csrf' } }), 'Title [已遮盖]');
  assert.equal(await readConversationTitle('fixture_chat', {
    env, fetch: async () => { throw new Error('mock-csrf'); }
  }), null);
  const forbidden = () => assert.fail('read-only title request must not run');
  assert.equal(await readConversationTitle('fixture_chat', { env: {}, fetch: forbidden }), null);
  assert.equal(await readConversationTitle('fixture_chat', { env: { ...env, ANTIGRAVITY_LS_ADDRESS: 'example.invalid:4555' },
    fetch: forbidden }), null);
});

function cardFixture() {
  const html = readFileSync(new URL('../src/sidecar/ui.html', import.meta.url), 'utf8');
  const code = html.slice(html.indexOf('  function card('), html.indexOf('  function sessionDrawer('));
  const labelsCode = html.slice(html.indexOf('  const labels ='), html.indexOf('  const byId ='));
  const el = (tag, className, text) => ({
    tag, className, text, children: [], append(...nodes) { this.children.push(...nodes); }, setAttribute() {}, addEventListener() {}
  });
  let current = 'chat_a';
  const { card, groupSessions } = new Function('el', 'currentConversation', 'button', 'autoReadControls', 'summaries',
    'drawers', labelsCode + code + '\nreturn { card, groupSessions };')(
    el, () => current, () => el('button'), () => el('span'), new Map(), new Set()
  );
  return { html, card, groupSessions, current: () => current, switchConversation: id => { current = id; } };
}

test('切换当前窗口时卡片高亮与置顶随之切换，仅看当前对话仍可配合搜索', () => {
  const { html, card, groupSessions, current, switchConversation } = cardFixture();
  const first = { target, sessionId: 'a', title: 'Alpha', state: 'idle' };
  const second = { target, sessionId: 'b', title: 'Beta', state: 'waiting_approval' };
  const prefs = {
    [target + ':a']: { pairedConversationId: 'chat_a', pairLabel: 'Alpha label' },
    [target + ':b']: { pairedConversationId: 'chat_b', pairedConversationTitle: 'Beta title' }
  };
  const info = { sessions: [second], catalog: { sessions: [first] } };
  const group = (query, onlyCurrent) => groupSessions(info, row => prefs[target + ':' + row.sessionId], query, current(), onlyCurrent);
  assert.deepEqual(group().visible.map(row => row.sessionId), ['a', 'b']);
  const currentCard = card(first, true, prefs);
  assert.match(currentCard.className, /current-pair/);
  assert.equal(currentCard.children[1].text, '当前对话 · Alpha label');
  assert.equal(card(second, true, prefs).children[1].text, '其他对话 · Beta title');
  assert.deepEqual(group('', true).visible.map(row => row.sessionId), ['a']);
  assert.equal(group('beta', true).matched, 0);
  switchConversation('chat_b');
  assert.deepEqual(group('', true).visible.map(row => row.sessionId), ['b']);
  assert.match(card(second, true, prefs).className, /current-pair/);
  assert.match(html, /id="current-only"[^>]*>仅看当前对话/);
});

test('卡片只在完成、失败或中断且有新回复时追加提示，审批和运行状态保持原标签', () => {
  const { card } = cardFixture();
  const badge = (row, reachable = true, monitored = true) => card({ target, sessionId: id, ...row },
    reachable, {}, monitored).children[0].children[1].text;
  const old = { kind: 'completed', turnId: 'old-turn' };
  assert.equal(badge({ state: 'active', outcome: 'completed', unread: old }), '运行中');
  assert.equal(badge({ state: 'waiting_approval', unread: { kind: 'waiting_approval' } }), '等待原窗口审批');
  assert.equal(badge({ state: 'idle', outcome: 'completed', unread: old }, false), '离线');
  assert.equal(badge({ state: 'unknown', unread: old }, true, false), '未加载');
  assert.equal(badge({ state: 'unknown', unread: old }), '待确认');
  assert.equal(badge({ state: 'paused', unread: old }), '暂停');
  assert.equal(badge({ state: 'idle', unread: old }), '空闲');
  for (const [outcome, label] of [['completed', '已完成'], ['failed', '失败'], ['interrupted', '已中断']]) {
    assert.equal(badge({ state: 'idle', outcome, unread: { kind: outcome } }), label + ' · 新回复');
    assert.equal(badge({ state: 'idle', outcome, unread: { kind: 'waiting_approval' } }), label);
    assert.equal(badge({ state: 'idle', outcome, unread: null }), label);
  }
});

test('已读 nudge 只清理匹配的终态轮次，无轮次 ID 时兼容旧记录，审批保留', async t => {
  const legacy = { target, sessionId: 'legacy-read', workspacePath: '/mock', state: 'idle', unread: { kind: 'completed' } };
  const f = await fixture(t, { 'state.json': { targets: { [target]: { reachable: true, sessions: [legacy] } } } });
  await probe(f);
  f.conclude();
  await probe(f);
  const headers = { 'X-Bridge-Token': f.files.get(runtimeName).nudgeToken };
  const payload = { action: 'read', target, sessionId: id };
  const unread = sessionId => f.files.get('state.json').targets[target].sessions.find(row => row.sessionId === sessionId)?.unread;
  assert.equal((await f.request('POST', '/api/nudge', payload)).status, 401);
  assert.equal((await f.request('POST', '/api/nudge', { ...payload, turnId: 'older' }, headers)).status, 202);
  assert.equal(unread(id).turnId, lastTurn);
  assert.equal((await f.request('POST', '/api/nudge', { ...payload, turnId: lastTurn }, headers)).status, 202);
  assert.equal(unread(id), null);
  await probe(f);
  assert.equal(unread(id), null);
  await f.request('POST', '/api/nudge', { ...payload, sessionId: legacy.sessionId, turnId: 'available' }, headers);
  assert.equal(unread(legacy.sessionId), null);

  f.observe('waiting_approval', 'approval-turn');
  await probe(f);
  await f.request('POST', '/api/nudge', payload, headers);
  const summary = await f.request('GET', '/api/summary?target=101-codex&sessionId=' + id);
  assert.equal(summary.body.messages[0].turnId, 'approval-turn');
  assert.equal(unread(id).kind, 'waiting_approval');
  f.observe('idle', 'approval-turn', 'completed');
  await probe(f);
  assert.equal(unread(id).kind, 'completed');
  await f.request('POST', '/api/nudge', payload, headers);
  assert.equal(unread(id), null);
});

test('终态读取精确轮次，脱敏并过滤私有输出，含完整引用且不超过 4000 字符', async t => {
  const f = await fixture(t, {}, undefined, { readPage: turnId => ({ workspacePath: '/mock', messages: [
    { role: 'user', turnId: 'prior', text: 'old turn private fixture' },
    { role: 'system', turnId, text: 'private instructions fixture' },
    { role: 'assistant', phase: 'analysis', turnId, text: 'private reasoning fixture' },
    { role: 'tool', turnId, text: 'private output fixture' },
    { role: 'user', turnId, text: '样例问题 password=mock_secret' },
    { role: 'assistant', phase: 'final_answer', turnId, text: '样例答复 api_key=mock_api\n' + '好'.repeat(4000) }
  ] }) });
  assert.equal((await autoReadSetting(f, { autoRead: true, conversationId: 'bound_chat', projectId: 'bound_project' })).status, 200);
  await probe(f);
  f.conclude();
  await probe(f);
  assert.equal(f.wakes.length, 1);
  assert.deepEqual(f.reads, [[id, { limit: 20, maxChars: 4000 }]]);
  const [conversationId, message, options] = f.wakes[0];
  assert.equal(conversationId, 'bound_chat');
  assert.deepEqual(options, { projectId: 'bound_project' });
  for (const value of ['第 1/5 轮', 'target: 101-codex', 'sessionId: ' + id, 'title: Mock',
    'expectedWorkspace: /mock', 'turnId: ' + lastTurn, '样例问题', '样例答复', '[已遮盖]']) {
    assert.ok(message.includes(value), value);
  }
  assert.doesNotMatch(message, /private|mock_secret|mock_api/);
  assert.match(message, /默认通过 bridge_send 派发给协作窗口自测.*仅用户明确要求/);
  assert.equal(message.length, 4000);
  assert.equal(autoReadPref(f).lastAutoReadTurnId, lastTurn);
  assert.equal(autoReadPref(f).autoReadCount, 1);
  assert.equal(f.files.get('state.json').targets[target].sessions[0].unread, null);

  f.observe('active', lastTurn);
  await probe(f);
  f.conclude();
  await probe(f);
  assert.equal(f.reads.length, 1);
  assert.equal(f.wakes.length, 1);
});

test('等待审批每轮只提醒一次，既不读正文也不计数，中断后读取结果', async t => {
  const f = await fixture(t);
  await autoReadSetting(f, { autoRead: true, conversationId: 'approval_chat' });
  await probe(f);
  for (let attempt = 0; attempt < 2; attempt++) {
    f.observe('waiting_approval', lastTurn);
    await probe(f);
    assert.equal(f.files.get('state.json').targets[target].sessions[0].unread.kind, 'waiting_approval');
    f.observe('active', lastTurn);
    await probe(f);
  }
  assert.equal(f.wakes.length, 1);
  assert.equal(f.reads.length, 0);
  assert.equal(autoReadPref(f).autoReadCount, 0);
  assert.equal(autoReadPref(f).lastAutoReadApprovalTurnId, lastTurn);
  assert.match(f.wakes[0][1], /等待审批.*到原窗口确认/s);
  assert.doesNotMatch(f.wakes[0][1], /可继续推进|第 \d/);

  f.observe('idle', lastTurn, 'interrupted');
  const result = await probe(f);
  assert.equal(result.targets[target].sessions[0].outcome, 'interrupted');
  assert.equal(f.wakes.length, 2);
  assert.match(f.wakes[1][1], /已中断 · 第 1\/5 轮/);
  assert.equal(f.files.get('state.json').targets[target].sessions[0].unread, null);
});

test('旧轮次自动转发返回后保留更新轮次的未读回复', async t => {
  let finishWake;
  const host = new Promise(resolve => { finishWake = resolve; });
  const f = await fixture(t, {}, undefined, { sendMessage: () => host });
  await autoReadSetting(f, { autoRead: true, conversationId: 'fixture_chat' });
  await probe(f);
  f.conclude();
  await probe(f);
  assert.equal(f.wakes.length, 1);
  assert.equal(f.files.get('state.json').targets[target].sessions[0].unread.turnId, lastTurn);
  f.observe('active', 'later-turn');
  await probe(f);
  f.observe('idle', 'later-turn', 'failed');
  await probe(f);
  finishWake();
  await flush();
  assert.equal(f.wakes.length, 1);
  assert.equal(f.files.get('state.json').targets[target].sessions[0].unread.turnId, 'later-turn');
});

test('连续跟进默认五轮，30 秒冷却期间不丢轮，熔断后派发参数无法重开', async t => {
  const f = await fixture(t);
  await autoReadSetting(f, { autoRead: true, conversationId: 'fuse_chat' });
  for (let number = 1; number <= 5; number++) {
    const round = 'round-' + number;
    f.observe('active', round);
    await probe(f);
    f.observe('idle', round, number === 3 ? 'failed' : 'completed');
    await probe(f);
    if (number > 1) {
      assert.equal(f.wakes.length, number - 1);
      f.tick(30_000);
      const scheduled = [...f.tasks].find(([, job]) => job.delay === 30_000);
      assert.ok(scheduled);
      f.tasks.delete(scheduled[0]);
      scheduled[1].fn();
      await flush();
    }
    assert.equal(f.wakes.length, number);
    assert.match(f.wakes.at(-1)[1], new RegExp('第 ' + number + '/5 轮'));
  }
  const final = f.wakes.at(-1)[1];
  assert.match(final, /已达连续自动跟进上限（5 轮）.*停止派发/);
  assert.doesNotMatch(final, /可继续推进/);
  assert.equal(autoReadPref(f).autoRead, false);
  assert.equal(autoReadPref(f).autoReadCount, 5);
  const headers = { 'X-Bridge-Token': f.files.get(runtimeName).nudgeToken };
  const sent = await f.request('POST', '/api/nudge', { target, sessionId: id, action: 'send', workspacePath: '/mock',
    autoReadOnFinish: true, conversationId: 'other_chat' }, headers);
  assert.equal(sent.status, 202);
  assert.equal(autoReadPref(f).autoRead, false);
  await autoReadSetting(f, { autoRead: true, conversationId: 'fuse_chat' });
  assert.equal(autoReadPref(f).autoReadCount, 0);
  f.observe('active', 'round-1');
  await probe(f);
  f.observe('idle', 'round-1', 'completed');
  await probe(f);
  assert.equal(f.wakes.length, 5);
});

test('会话自定义跟进上限优先于全局配置，达到上限关闭，拒绝非法值', async t => {
  const f = await fixture(t, {}, undefined, { sidecar: { maxAutoReads: 3 } });
  const initial = await autoReadSetting(f, { autoRead: true, conversationId: 'limit_chat' });
  assert.equal(initial.body.maxAutoReads, 3);
  for (const limit of [0, -1, 21, 1.5, '3', null]) {
    const invalid = await autoReadSetting(f, { autoReadLimit: limit });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'invalid_auto_read_limit');
  }
  assert.equal(autoReadPref(f).autoReadLimit, undefined);
  const changed = await autoReadSetting(f, { autoReadLimit: 1 });
  assert.equal(changed.status, 200);
  assert.equal(autoReadPref(f).autoReadLimit, 1);
  await probe(f);
  f.conclude();
  await probe(f);
  assert.match(f.wakes[0][1], /第 1\/1 轮.*跟进上限（1 轮）/s);
  assert.equal(autoReadPref(f).autoRead, false);
});

test('自动读取绑定按前端、最近派发、Sidecar 环境依次回退，并拒绝缺失或非法 ID', async t => {
  const empty = await fixture(t);
  const missing = await autoReadSetting(empty, { autoRead: true });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.message, '请先打开要唤醒的 Antigravity 对话后再开启自动读取');
  for (const conversationId of ['" ; echo x', '--help', 'x'.repeat(129)]) {
    const invalid = await autoReadSetting(empty, { autoRead: true, conversationId });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'invalid_host_id');
  }
  const f = await fixture(t, {}, undefined, { env: { ANTIGRAVITY_CONVERSATION_ID: 'env_chat', ANTIGRAVITY_PROJECT_ID: 'env_project' } });
  assert.equal((await autoReadSetting(f, { autoRead: true })).status, 200);
  assert.equal(autoReadPref(f).autoReadConversationId, 'env_chat');
  await autoReadSetting(f, { autoRead: false });

  const headers = { 'X-Bridge-Token': f.files.get(runtimeName).nudgeToken };
  const payload = { action: 'send', target, sessionId: id, workspacePath: '/mock', beforeTurnId: 'older' };
  assert.equal((await f.request('POST', '/api/nudge', { ...payload, conversationId: 'x/bad' }, headers)).status, 400);
  assert.equal((await f.request('POST', '/api/nudge', { ...payload, conversationId: 'dispatch_chat', projectId: 'dispatch_project' }, headers)).status, 202);
  assert.equal(autoReadPref(f).autoRead, false);
  assert.equal(autoReadPref(f).lastDispatchConversationId, 'dispatch_chat');
  await autoReadSetting(f, { autoRead: true, conversationId: '' });
  assert.equal(autoReadPref(f).autoReadConversationId, 'dispatch_chat');
  assert.equal(autoReadPref(f).autoReadProjectId, 'dispatch_project');
  await autoReadSetting(f, { autoRead: false });
  await autoReadSetting(f, { autoRead: true, conversationId: 'panel_chat', projectId: 'panel_project' });
  assert.equal(autoReadPref(f).autoReadConversationId, 'panel_chat');

  const opted = await f.request('POST', '/api/nudge', { ...payload, sessionId: 'other-fixture',
    autoReadOnFinish: true, conversationId: 'mcp_opted' }, headers);
  assert.equal(opted.status, 202);
  assert.equal(f.files.get('prefs.json').sessions[target + ':other-fixture'].autoReadConversationId, 'mcp_opted');
});

test('原生读取失败和 agentapi 失败不阻塞心跳，错误留在卡片状态且不重复唤醒', async t => {
  let failRead = true;
  let rejectHost;
  const host = new Promise((_, reject) => { rejectHost = reject; });
  const f = await fixture(t, {}, undefined, {
    readPage: turnId => {
      if (failRead) throw new Error('private read error');
      return { messages: [{ role: 'assistant', turnId, text: 'safe fixture' }] };
    },
    sendMessage: () => host
  });
  await autoReadSetting(f, { autoRead: true, conversationId: 'error_chat' });
  await probe(f);
  f.conclude();
  await probe(f);
  assert.equal(autoReadPref(f).autoReadError, '自动读取公开问答失败');
  assert.equal(f.wakes.length, 0);
  assert.equal(f.files.get('state.json').targets[target].sessions[0].unread.turnId, lastTurn);

  failRead = false;
  f.observe('active', 'newer');
  await probe(f);
  f.observe('idle', 'newer', 'completed');
  await probe(f);
  assert.equal(f.wakes.length, 1);
  f.observe('active', 'newer');
  await probe(f);
  f.observe('idle', 'newer', 'completed');
  await probe(f);
  assert.equal(f.wakes.length, 1);
  rejectHost(new Error('private agentapi error'));
  await flush();
  assert.equal(autoReadPref(f).autoReadError, '唤醒 Antigravity 失败，请在原对话核对');
  assert.equal(autoReadPref(f).lastAutoReadTurnId, 'newer');
  assert.equal(f.files.get('state.json').targets[target].sessions[0].unread.turnId, 'newer');
  const response = await probe(f);
  assert.doesNotMatch(JSON.stringify(response), /private/);
});

test('宿主唤醒仅用 execFile 固定参数、可选项目环境和 30 秒超时', async () => {
  for (const exe of [undefined, 'C:\\Program Files\\Fixture\\host.exe']) {
    const calls = [];
    await sendHostMessage('fixture_chat', '安全的模拟文本', {
      projectId: 'fixture_project', env: exe ? { ANTIGRAVITY_AGENTAPI_EXE: exe } : {},
      exec(...args) { calls.push(args.slice(0, -1)); args.at(-1)(null); }
    });
    const [[file, args, options]] = calls;
    assert.equal(file, exe || 'agentapi');
    assert.deepEqual(args, [...(exe ? ['agentapi'] : []), 'send-message', 'fixture_chat', '安全的模拟文本']);
    assert.equal(options.env.ANTIGRAVITY_PROJECT_ID, 'fixture_project');
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 30_000);
  }
  await assert.rejects(sendHostMessage('--version', 'fixture', { exec: () => assert.fail('invalid ID') }));
});

test('自动读取控件只在开启后显示轮数，直接提交编辑值和当前绑定', async () => {
  const html = readFileSync(new URL('../src/sidecar/ui.html', import.meta.url), 'utf8');
  const code = html.slice(html.indexOf('function button('), html.indexOf('function card('));
  const el = (tag, className, text) => ({
    tag, className, text, children: [], events: {}, attributes: {},
    append(...nodes) { this.children.push(...nodes); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.events[name] = callback; }
  });
  const controls = new Function('el', 'state', 'window', 'location', code + '\nreturn autoReadControls;')(
    el, { maxAutoReads: 5 }, { sidecar: { projectId: 'local_project' } }, { search: '?conversationId=local_chat' }
  );
  const edits = [];
  const change = async edit => { edits.push(edit); return edit.autoReadLimit !== 21; };
  const off = controls({}, change);
  assert.deepEqual(off.children.map(child => child.tag), ['button']);
  assert.equal(off.children[0].attributes['aria-pressed'], 'false');
  off.children[0].events.click();
  assert.deepEqual(edits[0], { autoRead: true, conversationId: 'local_chat', projectId: 'local_project' });

  const on = controls({ autoRead: true, autoReadCount: 1, autoReadLimit: 4, autoReadConversationId: 'local_chat' }, change);
  const [toggle, input] = on.children;
  assert.equal(toggle.text, '自动读取 1/4');
  assert.equal(toggle.attributes['aria-pressed'], 'true');
  assert.equal(toggle.title, '绑定对话 local_ch');
  assert.deepEqual([input.type, input.min, input.max, input.value], ['number', '1', '20', '4']);
  input.value = '2';
  await input.events.change();
  assert.deepEqual(edits.at(-1), { autoReadLimit: 2 });
  input.value = '21';
  await input.events.change();
  assert.equal(input.value, '4');
});

function markdownFixture() {
  const html = readFileSync(new URL('../src/sidecar/ui.html', import.meta.url), 'utf8');
  const code = html.slice(html.indexOf('function el('), html.indexOf('async function request('));
  function createElement(tag) {
    return {
      tag, children: [], value: '',
      append(...nodes) { this.children.push(...nodes); },
      set textContent(text) { this.value = text; this.children.length = 0; },
      get textContent() { return this.value + this.children.map(node => node.textContent).join(''); },
      set innerHTML(_) { assert.fail('Markdown must never assign HTML'); }
    };
  }
  const render = new Function('document', code + '\nreturn renderMarkdown;')({ createElement });
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  return { render, flatten };
}

test('侧栏最近一轮将常用 Markdown 转为适配窄栏的 DOM 节点', () => {
  const { render, flatten } = markdownFixture();
  const element = render([
    '# 一级', '## 二级', '### 三级', '#### 四级', '',
    '正文 **重点** 和 *强调*，以及 `x < y` 和 [文档](https://example.test/help)。', '',
    '> 引用一', '> 引用二', '', '---', '', '- 一', '* 二', '', '3. 三', '4. 四', '',
    '```js', '  const x = "<div>";', '  x;', '```', '',
    '| 项目 | 值 |', '| :--- | ---: |', '| Codex | **在线** |'
  ].join('\n'));
  assert.deepEqual(element.children.map(node => node.tag),
    ['h1', 'h2', 'h3', 'h4', 'p', 'blockquote', 'hr', 'ul', 'ol', 'pre', 'div']);
  const nodes = flatten(element);
  const find = tag => nodes.find(node => node.tag === tag);
  assert.equal(find('strong').textContent, '重点');
  assert.equal(find('em').textContent, '强调');
  assert.equal(find('code').textContent, 'x < y');
  assert.equal(find('blockquote').textContent, '引用一 引用二');
  assert.deepEqual(find('ul').children.map(node => node.textContent), ['一', '二']);
  assert.equal(find('ol').start, 3);
  assert.equal(find('pre').textContent, '  const x = "<div>";\n  x;');
  assert.equal(element.children.at(-1).className, 'md-table');
  assert.equal(find('table').textContent, '项目值Codex在线');
  assert.deepEqual([find('a').href, find('a').target, find('a').rel],
    ['https://example.test/help', '_blank', 'noopener noreferrer']);
});

test('侧栏 Markdown 保留原始标签与危险链接的字面内容且不创建可执行节点', () => {
  const { render, flatten } = markdownFixture();
  const unsafe = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
    '&lt;script&gt;encoded&lt;/script&gt;', '[运行](javascript:alert(1))',
    '[数据](data:text/html,boom)', '[凭据](file:///etc/passwd)'
  ];
  const element = render(unsafe.join('\n\n') + '\n\n[安全](http://example.test/)');
  for (const line of unsafe) assert.ok(element.textContent.includes(line));
  const nodes = flatten(element);
  assert.equal(nodes.filter(node => node.tag === 'a').length, 1);
  assert.equal(nodes.find(node => node.tag === 'a').href, 'http://example.test/');
  assert.ok(nodes.every(node => !['script', 'img', 'iframe'].includes(node.tag)));
});
