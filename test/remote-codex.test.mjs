import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { RemoteCodex } from '../src/adapters/remote-codex.mjs';
import { daemonSshArgs } from '../src/adapters/ssh-daemon.mjs';
import { validateConfig } from '../src/shared/config.mjs';

const sessionId = 'daee6210-5279-4e43-a0d6-12ba86afbfeb';
const turnId = 'new-native-turn';
const workspace = '/test/fixture';
const input = { sessionId, expectedWorkspace: workspace, prompt: 'isolated test input', operationId: 'fixture-001', mode: 'queue' };

async function fixture(t, options = {}) {
  const listener = http.createServer();
  const server = new WebSocketServer({ server: listener });
  const endpoint = '\\\\.\\pipe\\agy-daemon-fixture-' + randomUUID();
  if (process.platform === 'win32') listener.listen(endpoint);
  else listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const calls = [];
  const windows = [];
  const children = new Set();
  const transports = [];
  const views = { thread: { id: sessionId, cwd: workspace, status: { type: 'idle' } }, turns: [], items: [] };
  const config = validateConfig({
    remote: { transport: 'daemon', sshTarget: 'mock-101', socketPath: '/tmp/mock app.sock', requestTimeoutMs: options.timeout ?? 1500 },
    workspaces: { '101-codex': options.unpinned ? {} : { [sessionId]: workspace } }
  });
  server.on('connection', ws => {
    const index = windows.length;
    const connection = { closed: once(ws, 'close'), methods: [] };
    windows.push(connection);
    ws.on('message', raw => {
      const request = JSON.parse(raw);
      const { method, id, params } = request;
      assert.equal(request.jsonrpc, '2.0');
      calls.push({ ...request, connection: index });
      connection.methods.push(method);
      assert.ok(method, 'server-initiated approval must never be answered');
      if (method === 'initialized') {
        connection.initialized = true;
        return;
      }
      assert.ok(method === 'initialize' || connection.initialized, 'initialize then initialized before any native call');
      let result;
      if (method === 'initialize') {
        assert.equal(params.capabilities.experimentalApi, true);
        result = { userAgent: 'fixture' };
      } else if (method === 'thread/read' || method === 'thread/resume') {
        assert.deepEqual(params, method === 'thread/read' ? { threadId: sessionId, includeTurns: false } : { threadId: sessionId, excludeTurns: true });
        if (views.approval && method === 'thread/read') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 812, method: 'item/commandExecution/requestApproval', params: { threadId: sessionId, turnId } }));
          if (views.resolved) ws.send(JSON.stringify({
            jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: sessionId, requestId: 812 }
          }));
        }
        if (method === 'thread/resume' && views.thread.status.type === 'notLoaded') views.thread.status = { type: 'idle' };
        result = { thread: views.thread };
        if (method === 'thread/resume' && views.cwdAfterResume) {
          result = { thread: { ...views.thread } };
          views.thread.cwd = views.cwdAfterResume;
        }
      } else if (method === 'thread/list') {
        result = { data: [views.thread] };
      } else if (method === 'thread/loaded/list') {
        result = { data: [sessionId] };
      } else if (method === 'account/rateLimits/read') {
        result = { rateLimits: { primary: { usedPercent: 25 } } };
      } else if (method === 'thread/turns/list') {
        assert.equal(params.threadId, sessionId);
        assert.equal(params.sortDirection, 'desc');
        assert.equal(params.limit, params.itemsView === 'summary' || options.heartbeat ? 1 : 20);
        assert.ok(['notLoaded', 'summary'].includes(params.itemsView));
        result = params.itemsView === 'summary'
          ? { data: views.turns.slice(0, 1).map(turn => ({ ...turn, items: views.items.map(entry => entry.item).reverse() })) }
          : { data: views.turns };
      } else if (method === 'thread/items/list') {
        if (options.legacy) {
          ws.send(JSON.stringify({ id, error: { code: -32601, message: 'thread/items/list is not supported yet' } }));
          return;
        }
        const start = Number(params.cursor ?? 0);
        const end = start + params.limit;
        result = { data: views.items.slice(start, end), nextCursor: end < views.items.length ? String(end) : null };
      } else if (['turn/start', 'turn/steer'].includes(method)) {
        const steer = method === 'turn/steer';
        assert.deepEqual(Object.keys(params).sort(), [
          'clientUserMessageId', 'input', 'threadId', ...(steer ? ['expectedTurnId'] : [])
        ].sort());
        if (steer) assert.equal(params.expectedTurnId, turnId);
        views.turns = [{ id: turnId, status: 'inProgress' }];
        views.thread.status = { type: 'active' };
        views.items.unshift({ turnId, item: {
          type: 'userMessage', id: 'user-msg', clientId: params.clientUserMessageId, content: params.input
        } });
        if (options.writeBehavior === 'drop') return;
        if (options.writeBehavior === 'disconnect') { ws.terminate(); return; }
        result = options.writeBehavior === 'missing-id' ? {} : steer ? { turnId } : { turn: views.turns[0] };
      } else if (method === 'turn/interrupt') {
        assert.deepEqual(params, { threadId: sessionId, turnId });
        result = {};
      } else {
        assert.fail('unexpected native method ' + method);
      }
      ws.send(JSON.stringify({ id, result }));
    });
  });
  t.after(async () => {
    for (const child of children) child.kill();
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => listener.close(resolve));
  });
  const adapter = new RemoteCodex(config, {
    spawnProcess(executable, args, spawnOptions) {
      assert.equal(executable, 'ssh');
      assert.ok(args.includes('BatchMode=yes'));
      assert.ok(args.includes('StrictHostKeyChecking=yes'));
      assert.ok(args.includes('ClearAllForwardings=yes'));
      assert.deepEqual(args.slice(-3, -1), ['--', 'mock-101']);
      const command = args.at(-1);
      const relayPrefix = "exec \"$node_bin\" '-e' '";
      const suffix = "' '--' '/tmp/mock app.sock'";
      const relayStart = command.indexOf(relayPrefix);
      assert.ok(relayStart >= 0 && command.endsWith(suffix));
      assert.equal(spawnOptions.windowsHide, true);
      const address = listener.address();
      const relay = command.slice(relayStart + relayPrefix.length, -suffix.length).replaceAll("'\\''", "'");
      const childArgs = typeof address === 'string' ? [relay, '--', address] : [
        relay.replace('process.argv[1]', 'JSON.parse(process.argv[1])'),
        '--', JSON.stringify({ port: address.port, host: '127.0.0.1' })
      ];
      const child = spawn(process.execPath, ['-e', ...childArgs], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      children.add(child);
      transports.push(once(child, 'exit'));
      child.on('exit', () => children.delete(child));
      return child;
    }
  });
  return { adapter, views, windows, calls, transports, writes: () => calls.filter(x => /^turn\/(?:start|steer|interrupt)$/.test(x.method)) };
}

test('101 SSH 支持显式 nodeBin，同时安全引用带空格或单引号的绝对路径', () => {
  const nodeBin = "/opt/fixture tools/part's node";
  const { remote } = validateConfig({ remote: { transport: 'daemon', nodeBin } });
  assert.equal(remote.nodeBin, nodeBin);
  const command = daemonSshArgs(remote).at(-1);
  assert.ok(command.startsWith("exec '/opt/fixture tools/part'\\''s node' '-e' '"));
  assert.doesNotMatch(command, /command -v node|\.nvm\/versions/);
  for (const invalid of ['node', 'C:\\fixture\\node', '/bad\nnode', null, 123]) {
    assert.throws(() => validateConfig({ remote: { nodeBin: invalid } }), { code: 'INVALID_CONFIG' });
  }
});

test('101 SSH 默认先查 PATH，再按版本降序查找可运行的 nvm Node', () => {
  const { remote } = validateConfig({ remote: { transport: 'daemon' } });
  assert.equal(remote.nodeBin, undefined);
  const command = daemonSshArgs(remote).at(-1);
  const pathCheck = command.indexOf('command -v node >/dev/null 2>&1 && node --version >/dev/null 2>&1');
  const nvmCheck = command.indexOf('"$HOME"/.nvm/versions/node/*/bin/node | LC_ALL=C sort -Vr');
  assert.ok(pathCheck >= 0 && nvmCheck > pathCheck);
  assert.match(command, /\[ -f "\$candidate" \] && \[ -x "\$candidate" \] && "\$candidate" --version/);
  assert.match(command, /if \[ -z "\$node_bin" \].*exit 127/);
  assert.match(command, /exec "\$node_bin" '-e'/);
});

test('101 原生白名单放行加载列表和额度读取，仍拒绝其它方法', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.adapter.withDaemon(async client => {
    assert.deepEqual(await client.request('thread/loaded/list', { limit: 1 }), { data: [sessionId] });
    assert.deepEqual(await client.request('account/rateLimits/read', {}), { rateLimits: { primary: { usedPercent: 25 } } });
    assert.throws(() => client.request('account/login/start', {}), { code: 'NATIVE_TOOL_UNAVAILABLE' });
  });
  assert.deepEqual(f.windows[0].methods, ['initialize', 'initialized', 'thread/loaded/list', 'account/rateLimits/read']);
});

test('101 显式 B 路心跳在单条 SSH 中只读加载会话与一轮摘要，并顺带读取额度', { timeout: 8000 }, async t => {
  const f = await fixture(t, { heartbeat: true });
  f.views.thread.status.type = 'active';
  f.views.turns = [{ id: turnId, status: 'inProgress' }];
  const result = await f.adapter.heartbeat({ sessionIds: [], includeQuota: true });
  assert.equal(f.windows.length, 1);
  assert.deepEqual(f.windows[0].methods, [
    'initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/turns/list', 'account/rateLimits/read'
  ]);
  assert.equal(result.sessions[0].latestTurn.id, turnId);
  assert.deepEqual(f.writes(), []);
});

test('101 turn/start 收到原生 turn.id 后关闭短连接，另开连接读回公开历史', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const result = await f.adapter.send(input);
  assert.deepEqual(result, { result: 'accepted', sessionId, turnId, operationId: input.operationId, effectiveDelivery: 'startNow' });
  await f.windows[0].closed;
  await f.transports[0];
  assert.deepEqual(f.windows[0].methods, ['initialize', 'initialized', 'thread/read', 'thread/turns/list', 'turn/start']);
  f.views.turns[0].status = 'completed';
  f.views.thread.status.type = 'idle';
  f.views.items.unshift({ turnId, item: { type: 'agentMessage', phase: 'final_answer', text: 'verified final' } });
  const read = await f.adapter.read(sessionId, { limit: 1 });
  assert.deepEqual(read.messages.map(x => x.text), ['verified final']);
  assert.ok(read.nextCursor);
  const older = await f.adapter.read(sessionId, { cursor: read.nextCursor });
  assert.equal(older.messages[0].operationId, input.operationId);
  assert.equal(older.messages[0].text, '[AGY_BRIDGE_OP:' + input.operationId + ']\n' + input.prompt);
  assert.equal(older.nextCursor, null);
  assert.equal(f.writes().length, 1);
  assert.equal(f.windows.length, 3);
});

test('101 超时只提交一次，reconcile 用原生用户消息 ID 确认，未命中保持 unknown', { timeout: 8000 }, async t => {
  const f = await fixture(t, { writeBehavior: 'drop', timeout: 800 });
  const result = await f.adapter.send(input);
  assert.equal(result.result, 'unknown');
  assert.equal(result.code, 'UNKNOWN_OUTCOME');
  assert.equal(result.operationId, input.operationId);
  assert.match(result.message, /bridge_read.*reconcile/);
  await f.windows[0].closed;
  assert.equal(f.writes().length, 1);
  assert.deepEqual(await f.adapter.reconcile(sessionId, input.operationId), {
    result: 'accepted', sessionId, turnId, operationId: input.operationId, userMessageId: 'user-msg'
  });
  f.views.items.unshift({ turnId, item: { type: 'agentMessage', phase: 'final_answer', clientId: 'unseen-id', text: 'unseen-id' } });
  assert.equal((await f.adapter.reconcile(sessionId, 'unseen-id')).result, 'unknown');
  assert.equal(f.writes().length, 1);
});

for (const behavior of ['disconnect', 'missing-id']) {
  test('101 写入遇到 ' + behavior + ' 返回 unknown 并关闭连接', { timeout: 8000 }, async t => {
    const f = await fixture(t, { writeBehavior: behavior });
    assert.equal((await f.adapter.send(input)).result, 'unknown');
    await f.windows[0].closed;
    assert.equal(f.writes().length, 1);
  });
}

test('101 排队等待空闲，steer 绑定原生轮次，中断仅接受匹配的 expectedTurnId', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  f.views.thread.status.type = 'active';
  f.views.turns = [{ id: turnId, status: 'inProgress' }];
  assert.equal((await f.adapter.list(30))[0].activeTurnId, turnId);
  assert.equal((await f.adapter.send(input)).reason, 'queue_waiting_for_idle');
  assert.equal((await f.adapter.interrupt({ sessionId, expectedWorkspace: workspace, expectedTurnId: 'stale' })).reason, 'target_execution_changed');
  assert.deepEqual(f.writes(), []);
  const steer = await f.adapter.send({ ...input, mode: 'steer' });
  assert.equal(steer.result, 'accepted');
  assert.equal(steer.turnId, turnId);
  await f.windows.at(-1).closed;
  assert.equal((await f.adapter.interrupt({ sessionId, expectedWorkspace: '/test/fixture/./', expectedTurnId: turnId })).result, 'accepted');
  assert.deepEqual(f.writes().map(x => x.method), ['turn/steer', 'turn/interrupt']);
});

test('101 用调用方工作区校验首次操作，且发送前复核恢复后的真实工作区', { timeout: 8000 }, async t => {
  const f = await fixture(t, { unpinned: true });
  const mismatch = { result: 'not_sent', reason: 'session_identity_mismatch', code: 'SESSION_IDENTITY_MISMATCH' };
  assert.deepEqual(await f.adapter.send({ ...input, expectedWorkspace: '/test/Fixture' }), mismatch);
  assert.deepEqual(await f.adapter.send({ ...input, expectedWorkspace: undefined }), mismatch);
  f.views.thread.status.type = 'active';
  f.views.turns = [{ id: turnId, status: 'inProgress' }];
  assert.deepEqual(await f.adapter.interrupt({ sessionId, expectedWorkspace: '/wrong', expectedTurnId: turnId }), mismatch);
  assert.ok(f.calls.every(call => !['thread/turns/list', 'thread/resume'].includes(call.method)));
  f.views.thread.status.type = 'notLoaded';
  f.views.turns[0].status = 'completed';
  f.views.cwdAfterResume = '/wrong-after-resume';
  assert.deepEqual(await f.adapter.send(input), mismatch);
  assert.deepEqual(f.calls.slice(-2).map(call => call.method), ['thread/resume', 'thread/read']);
  assert.deepEqual(f.writes(), []);
});

test('101 检查审批通知和工作区，并用 summary 读取旧会话', { timeout: 8000 }, async t => {
  const f = await fixture(t, { legacy: true });
  f.views.turns = [{ id: turnId, status: 'inProgress' }];
  f.views.thread.status.type = 'active';
  f.views.approval = true;
  assert.equal((await f.adapter.status(sessionId)).state, 'waiting_approval');
  assert.equal((await f.adapter.send({ ...input, mode: 'steer' })).result, 'not_sent');
  f.views.resolved = true;
  assert.equal((await f.adapter.status(sessionId)).state, 'active');
  f.views.approval = false;
  f.views.thread.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  assert.equal((await f.adapter.status(sessionId)).state, 'waiting_approval');
  f.views.thread.cwd = '/wrong';
  assert.equal((await f.adapter.send(input)).code, 'SESSION_IDENTITY_MISMATCH');
  f.views.thread.cwd = workspace;
  f.views.thread.status = { type: 'notLoaded' };
  f.views.turns[0].status = 'completed';
  assert.equal((await f.adapter.send(input)).result, 'accepted');
  assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, 1);
  const read = await f.adapter.read(sessionId);
  assert.equal(read.messages[0].operationId, input.operationId);
  assert.ok(f.calls.some(call => call.method === 'thread/turns/list' && call.params.itemsView === 'summary'));
  assert.deepEqual(f.writes().map(x => x.method), ['turn/start']);
});
