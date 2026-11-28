import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { RemoteCodex } from '../src/adapters/remote-codex.mjs';
import { desktopSshArgs, discoverCallerThread, discoverDesktopSocket } from '../src/adapters/ssh-desktop.mjs';
import { validateConfig } from '../src/shared/config.mjs';

const sessionId = '2129b8cc-38d4-47a1-befc-d001c68b6308';
const discoveredId = '8a7179cf-bd5e-467c-b4b1-6ef58372cc85';
const configuredId = 'acbf063f-55fc-4a93-ab42-627de4330812';
const workspace = '/home/mock/workspace';
const turnId = 'latest-desktop-turn';
const input = { sessionId, expectedWorkspace: workspace, mode: 'queue', operationId: 'mock-op', prompt: '合成测试' };
const daemonPath = '/home/user/.codex/app-server-control/app-server-control.sock';

test('101 默认使用自动发现的桌面管道，显式 daemon 才使用旧 socket', () => {
  const { remote } = validateConfig({});
  assert.equal(remote.transport, 'desktop-pipe');
  assert.equal(remote.socketPath, undefined);
  assert.equal(validateConfig({ remote: { transport: 'daemon' } }).remote.socketPath, daemonPath);
  assert.throws(() => validateConfig({ remote: { socketPath: daemonPath } }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig({ remote: { transport: 'automatic' } }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig({ remote: { callerThreadId: 'invalid' } }), { code: 'INVALID_CONFIG' });
  const args = desktopSshArgs(remote);
  assert.ok(args.includes('-T') && args.includes('BatchMode=yes') && args.includes('StrictHostKeyChecking=yes'));
  const command = args.at(-1);
  assert.match(command, /command -v node.*\.nvm\/versions\/node/s);
  assert.match(command, /\/tmp\/codex-app-tools-/);
  assert.match(command, /process\.geteuid\(\)/);
  assert.match(command, /' '--'$/);
  assert.ok(!command.includes('app-server-control.sock'));
  const explicit = validateConfig({ remote: { socketPath: "/tmp/mock desktop/part's.sock", nodeBin: '/opt/node' } }).remote;
  const explicitCommand = desktopSshArgs(explicit).at(-1);
  assert.ok(explicitCommand.startsWith("exec '/opt/node' '-e' '"));
  assert.ok(explicitCommand.endsWith("' '--' '/tmp/mock desktop/part'\\''s.sock'"));
});

test('101 按修改时间从 rollout 文件名选真实调用会话 ID', async () => {
  const folder = '/home/mock/.codex/sessions';
  const entry = (name, directory = false) => ({ name, isDirectory: () => directory, isFile: () => !directory });
  const dirs = new Map([
    [folder, [entry('2025', true), entry('2026', true)]],
    [folder + '/2025', [entry('rollout-stamp-' + discoveredId + '.jsonl')]],
    [folder + '/2026', [entry('rollout-stamp-' + sessionId + '.jsonl'), entry('rollout-fake-not-uuid.jsonl')]]
  ]);
  const io = {
    readdir: async path => dirs.get(path) ?? [],
    lstat: async path => ({ isFile: () => true, mtimeMs: path.includes('/2025/') ? 3 : 2 })
  };
  assert.equal(await discoverCallerThread('/home/mock', io), discoveredId);
  assert.equal(await discoverCallerThread('/missing', io), null);
});

test('101 发现按修改时间降序试连当前用户的 socket，跳过失效或非本用户文件', async () => {
  const directory = '/tmp/codex-app-tools-1000';
  const entries = [
    { name: 'old.sock', uid: 1000, mtimeMs: 2 },
    { name: 'live.sock', uid: 1000, mtimeMs: 10 },
    { name: 'stale.sock', uid: 1000, mtimeMs: 100 },
    { name: 'foreign.sock', uid: 1001, mtimeMs: 200 },
    { name: 'regular.sock', regular: true },
    { name: 'socket.bak', uid: 1000, mtimeMs: 300 }
  ].map(entry => ({ ...entry, isSocket: () => !entry.regular }));
  const attempted = [];
  const live = {};
  const filesystem = {
    async readdir(path, options) {
      assert.equal(path, directory);
      assert.equal(options.withFileTypes, true);
      return entries;
    },
    async lstat(path) {
      if (path === directory) return { uid: 1000, isDirectory: () => true };
      return entries.find(entry => directory + '/' + entry.name === path);
    }
  };
  const socket = await discoverDesktopSocket(1000, {
    ...filesystem,
    async connect(path) {
      attempted.push(path);
      if (path === directory + '/live.sock') return live;
      throw new Error('stale socket');
    }
  });
  assert.equal(socket, live);
  assert.deepEqual(attempted, [directory + '/stale.sock', directory + '/live.sock']);
  assert.equal(await discoverDesktopSocket(1000, { ...filesystem, connect: async () => { throw new Error('unreachable'); } }), null);
  assert.equal(await discoverDesktopSocket(1000, { lstat: async () => ({ uid: 1001, isDirectory: () => true }) }), null);
});

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function fixture(t, { sendBehavior, noSocket, itemPagination, callerThreadId, missingCaller, localHistory, quotaTimeout,
  timeout = 1600 } = {}) {
  const calls = [];
  const relays = [];
  const sockets = new Set();
  const children = new Set();
  const thread = { id: sessionId, kind: 'codex', hostId: 'local', cwd: workspace, status: { type: 'idle' } };
  const latest = {
    id: turnId, status: 'completed', items: [
      { id: 'question', type: 'userMessage', content: [{ type: 'text', text: '最新问题' }] },
      { id: 'private', type: 'reasoning', text: 'private reasoning' },
      { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '最新答复 password=secret-fixture' }
    ]
  };
  const earlierItem = itemPagination ? latest.items.shift() : null;
  if (itemPagination) latest.nextItemCursor = 'older-item-page';
  const older = {
    id: 'earlier-turn', status: 'completed', items: [
      { id: 'older-final', type: 'agentMessage', phase: 'final_answer', text: '较早答复' }
    ]
  };
  const tools = ['list_threads', 'read_thread', 'send_message_to_thread', 'get_usage_limits',
    'list_projects', 'create_thread', 'set_thread_title', 'delete_thread'];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const end = 4 + buffer.readUInt32LE();
        const call = JSON.parse(buffer.subarray(4, end).toString('utf8'));
        buffer = buffer.subarray(end);
        calls.push(call);
        assert.equal(call.jsonrpc, '2.0');
        let result;
        if (call.method === 'tools/list') {
          assert.deepEqual(call.params, { threadStartKind: 'all' });
          result = { tools: tools.map(name => ({ name, namespace: 'desktop-fixture',
            ...(name === 'list_threads' && localHistory && { inputSchema: {
              properties: { mode: {}, source: {}, hostId: {}, archived: {} }
            } })
          })) };
        } else {
          assert.equal(call.method, 'tools/call');
          const { tool, namespace, callerSource, threadId, turnId: envelopeTurnId, arguments: args } = call.params;
          assert.equal(namespace, 'desktop-fixture');
          assert.equal(callerSource, 'codex');
          assert.match(envelopeTurnId, /^agy-bridge-/);
          if (args.threadId) assert.equal(threadId, sessionId);
          else assert.equal(threadId, callerThreadId ?? discoveredId);
          let data;
          if (tool === 'list_threads') {
            data = { pinnedThreads: [thread], threads: [thread, { id: 'non-local', hostId: 'other' }, { id: 'chatgpt', kind: 'chatgpt' }] };
          } else if (tool === 'read_thread') {
            assert.equal(args.hostId, 'local');
            assert.equal(args.includeOutputs, false);
            assert.ok(args.maxOutputCharsPerItem <= 20_000);
            if (args.itemCursor) {
              assert.equal(args.itemCursor, 'older-item-page');
              assert.equal(args.cursor, undefined);
              data = { threadId: sessionId, turnId, items: [earlierItem], nextItemCursor: null };
            } else {
              assert.equal(args.turnLimit, 1);
              data = args.cursor === 'older-page'
                ? { thread, turns: [older], page: { order: 'newest_first', nextCursor: null } }
                : { thread, turns: [latest], page: { order: 'newest_first', nextCursor: 'older-page' } };
            }
          } else if (tool === 'send_message_to_thread') {
            assert.deepEqual(args, { threadId: sessionId, hostId: 'local', prompt: '[AGY_BRIDGE_OP:mock-op]\n合成测试' });
            if (sendBehavior === 'timeout') return;
            if (sendBehavior === 'disconnect') { socket.destroy(); return; }
            data = { threadId: sessionId };
          } else if (tool === 'get_usage_limits') {
            assert.deepEqual(args, {});
            if (quotaTimeout) return;
            data = { rateLimits: { secondary: { usedPercent: 25 } } };
          } else if (tool === 'list_projects') {
            data = { projects: [{ path: workspace, hostId: 'local', projectId: 'desk-project' }] };
          } else if (tool === 'create_thread') {
            data = { threadId: sessionId, hostId: 'local' };
          } else {
            assert.fail('unexpected desktop tool ' + tool);
          }
          result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
        }
        const frame = encodeFrame({ jsonrpc: '2.0', id: call.id, result });
        socket.write(frame.subarray(0, 2));
        setImmediate(() => { if (!socket.destroyed) socket.write(frame.subarray(2)); });
      }
    });
  });
  if (process.platform === 'win32') server.listen('\\\\.\\pipe\\agy-desktop-fixture-' + randomUUID());
  else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const child of children) child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  const config = validateConfig({ remote: { sshTarget: 'mock-101', requestTimeoutMs: timeout, callerThreadId } });
  const adapter = new RemoteCodex(config, {
    spawnProcess(executable, args, options) {
      assert.equal(executable, 'ssh');
      assert.deepEqual(args.slice(-3, -1), ['--', 'mock-101']);
      const command = args.at(-1);
      const prefix = "exec \"$node_bin\" '-e' '";
      const suffix = callerThreadId ? "' '--' '' 'configured-caller'" : "' '--'";
      assert.ok(command.includes(prefix) && command.endsWith(suffix));
      assert.ok(!command.includes('app-server-control.sock'));
      const script = command.slice(command.indexOf(prefix) + prefix.length, -suffix.length).replaceAll("'\\''", "'")
        .replace('await discoverCallerThread(process.env.HOME, { lstat, readdir })', JSON.stringify(missingCaller ? null : discoveredId));
      const address = server.address();
      const relayArgs = typeof address === 'string'
        ? [script, '--', address]
        : [script.replace('createConnection(path)', 'createConnection(JSON.parse(path))'),
          '--', JSON.stringify({ host: '127.0.0.1', port: address.port })];
      if (callerThreadId) relayArgs.push('configured-caller');
      const child = spawn(process.execPath, noSocket ? ['-e', 'process.exitCode = 1'] : ['-e', ...relayArgs], options);
      children.add(child);
      relays.push(once(child, 'exit'));
      child.on('exit', () => children.delete(child));
      return child;
    }
  });
  return { adapter, calls, relays, thread, latest, writes: () => calls.filter(call => call.params.tool === 'send_message_to_thread') };
}

test('101 优先用目标 UUID，主机工具使用显式配置的 UUID', { timeout: 8000 }, async t => {
  const f = await fixture(t, { callerThreadId: configuredId });
  await f.adapter.list(30);
  await f.adapter.status(sessionId);
  assert.equal(f.calls.find(call => call.params.tool === 'list_threads').params.threadId, configuredId);
  assert.equal(f.calls.find(call => call.params.tool === 'read_thread').params.threadId, sessionId);
});

test('101 没有发现调用 UUID 时不执行主机工具，指定会话仍可读取', { timeout: 8000 }, async t => {
  const f = await fixture(t, { missingCaller: true });
  await assert.rejects(f.adapter.list(30), { code: 'CALLER_THREAD_UNAVAILABLE' });
  assert.equal((await f.adapter.status(sessionId)).sessionId, sessionId);
  assert.equal(f.calls.filter(call => call.params.tool === 'list_threads').length, 0);
});

test('101 默认桌面模式通过 SSH stdio 收发长度帧，核对工作区并回传 beforeTurnId', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.send({ ...input, expectedWorkspace: '/wrong' }), {
    result: 'not_sent', reason: 'session_identity_mismatch', code: 'SESSION_IDENTITY_MISMATCH'
  });
  assert.equal(f.writes().length, 0);
  const sent = await f.adapter.send({ ...input, expectedWorkspace: workspace + '/./' });
  assert.deepEqual(sent, { result: 'accepted', operationId: 'mock-op', sessionId, turnId: null, beforeTurnId: turnId, effectiveDelivery: 'unconfirmed' });
  assert.equal(f.writes().length, 1);
  assert.equal(f.relays.length, 2);
  await f.relays[1];
  f.thread.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  f.latest.status = 'inProgress';
  assert.equal((await f.adapter.status(sessionId)).state, 'waiting_approval');
  f.thread.status = { type: 'active' };
  assert.equal((await f.adapter.send(input)).reason, 'queue_waiting_for_idle');
  assert.equal((await f.adapter.interrupt({ ...input, expectedTurnId: turnId })).reason, 'delivery_mode_unsupported');
  assert.equal((await f.adapter.interrupt({ ...input, expectedTurnId: 'stale' })).reason, 'target_execution_changed');
  assert.equal(f.writes().length, 1);
});

test('101 桌面管道对公开消息分页并使用 get_usage_limits', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.adapter.list(30)).map(row => [row.target, row.sessionId]), [['101-codex', sessionId]]);
  const first = await f.adapter.read(sessionId, { limit: 1 });
  assert.deepEqual(first.messages.map(message => message.text), ['最新答复 password=[已遮盖]']);
  const next = await f.adapter.read(sessionId, { cursor: first.nextCursor });
  assert.deepEqual(next.messages.map(message => message.text), ['较早答复', '最新问题']);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(await f.adapter.usageLimits(), { rateLimits: { secondary: { usedPercent: 25 } } });
  await assert.rejects(f.adapter.desktop.withPipe(client => client.call('delete_thread', {})), { code: 'NATIVE_TOOL_UNAVAILABLE' });
  assert.ok(f.calls.every(call => call.params.tool !== 'delete_thread'));
});

test('101 在同一条 SSH A 路连接核对项目并创建原生会话', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const result = await f.adapter.create({ workspacePath: workspace, title: 'Fixture', prompt: 'Mock only' });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.result, 'created');
  assert.equal(f.relays.length, 1);
  const calls = f.calls.filter(call => call.method === 'tools/call');
  assert.deepEqual(calls.map(call => call.params.tool), ['list_projects', 'create_thread']);
  assert.deepEqual(calls[1].params.arguments, {
    title: 'Fixture', prompt: 'Mock only', target: { type: 'project', projectId: 'desk-project', environment: { type: 'local' } }
  });
});

test('101 A 路心跳用单条 SSH 列出活动会话并读取无正文元数据和额度', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  f.thread.status = { type: 'active' };
  f.latest.status = 'inProgress';
  const result = await f.adapter.heartbeat({ sessionIds: [sessionId], includeQuota: true });
  assert.equal(f.relays.length, 1);
  const calls = f.calls.filter(call => call.method === 'tools/call');
  assert.deepEqual(calls.map(call => call.params.tool), ['list_threads', 'read_thread', 'get_usage_limits']);
  assert.deepEqual(calls[0].params.arguments, { limit: 50 });
  assert.equal(calls[1].params.arguments.turnLimit, 1);
  assert.equal(calls[1].params.arguments.includeOutputs, false);
  assert.equal(calls[1].params.arguments.maxOutputCharsPerItem, 0);
  assert.equal(result.sessions[0].latestTurn.id, turnId);
  assert.doesNotMatch(JSON.stringify(result), /secret-fixture|private reasoning/);
});

test('101 A 路使用纯本地历史，并把挂起的配额请求限制在 3 秒', { timeout: 6500 }, async t => {
  const f = await fixture(t, { localHistory: true, quotaTimeout: true, timeout: 8000 });
  const result = await f.adapter.heartbeat({ sessionIds: [sessionId], includeQuota: true });
  assert.equal(result.quota, null);
  assert.equal(result.catalogAvailable, true);
  assert.deepEqual(result.sessions.map(row => row.sessionId), [sessionId]);
  assert.deepEqual(result.catalog.map(row => row.sessionId), [sessionId]);
  assert.equal(f.relays.length, 1);
  const calls = f.calls.filter(call => call.method === 'tools/call');
  assert.deepEqual(calls.map(call => call.params.tool), ['list_threads', 'read_thread', 'get_usage_limits']);
  assert.deepEqual(calls[0].params.arguments, { mode: 'history', source: 'codex', hostId: 'local', archived: false, limit: 50 });
  assert.equal(Object.hasOwn(calls.at(-1).params, 'timeoutMs'), false);
  assert.equal(Object.hasOwn(calls.at(-1).params, 'optional'), false);
});

test('101 桌面管道读完同轮次的消息续页，再读取更早轮次', { timeout: 8000 }, async t => {
  const f = await fixture(t, { itemPagination: true });
  const first = await f.adapter.read(sessionId, { limit: 1 });
  assert.deepEqual(first.messages.map(message => message.text), ['最新答复 password=[已遮盖]']);
  const next = await f.adapter.read(sessionId, { cursor: first.nextCursor });
  assert.deepEqual(next.messages.map(message => message.text), ['较早答复', '最新问题']);
  assert.equal(next.workspacePath, workspace);
  assert.equal(next.nextCursor, null);
  const reads = f.calls.filter(call => call.params.tool === 'read_thread');
  assert.equal(reads.at(-2).params.arguments.itemCursor, 'older-item-page');
  assert.equal(reads.at(-1).params.arguments.cursor, 'older-page');
});

test('101 桌面管道不可用时直接返回，访问 Daemon 的入口也拒绝连接', { timeout: 8000 }, async t => {
  const f = await fixture(t, { noSocket: true });
  await assert.rejects(f.adapter.list(30), { code: 'PIPE_UNAVAILABLE' });
  assert.deepEqual(await f.adapter.send(input), { result: 'not_sent', reason: 'preflight_failed', code: 'PIPE_UNAVAILABLE' });
  await assert.rejects(f.adapter.withDaemon(() => assert.fail('unexpected daemon action')), { code: 'NATIVE_TOOL_UNAVAILABLE' });
  await assert.rejects(f.adapter.reconcile(sessionId, input.operationId), { code: 'NATIVE_TOOL_UNAVAILABLE' });
  assert.equal(f.relays.length, 2);
  assert.equal(f.calls.length, 0);
});

for (const sendBehavior of ['timeout', 'disconnect']) {
  test('101 桌面写入遇到 ' + sendBehavior + ' 保持 unknown，既不重复发送也不切 Daemon', { timeout: 8000 }, async t => {
    const f = await fixture(t, { sendBehavior, timeout: 1000 });
    const result = await f.adapter.send(input);
    assert.equal(result.result, 'unknown');
    assert.equal(result.code, 'UNKNOWN_OUTCOME');
    assert.equal(result.operationId, input.operationId);
    assert.match(result.message, /bridge_read/);
    assert.equal(f.writes().length, 1);
    assert.equal(f.relays.length, 1);
    await f.relays[0];
  });
}
