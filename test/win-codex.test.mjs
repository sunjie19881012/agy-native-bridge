import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { discoverWinCallerThread, discoverWinPipes, resolveWinBindings, WinCodex } from '../src/adapters/win-codex.mjs';
import { createRolloutReader } from '../src/adapters/win-rollout.mjs';
import { validateConfig } from '../src/shared/config.mjs';

const sessionId = '0b1e482a-4efa-401a-9e5c-734dcfba5b63';
const turnId = '73315155-2455-475a-aadd-dcd9bfa34984';
const workspace = 'C:\\Mock\\Workspace';
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const localHistory = { mode: 'history', source: 'codex', hostId: 'local', archived: false, limit: 50 };

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function listenMockPipe(t, server) {
  if (process.platform === 'win32') server.listen('\\\\.\\pipe\\agy-window-fixture-' + randomUUID());
  else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
}

function connectMockPipe(server) {
  const address = server.address();
  return typeof address === 'string' ? net.createConnection(address)
    : net.createConnection({ host: '127.0.0.1', port: address.port });
}

async function fixture(t, { listInputs, historyFailure, quotaTimeout, discover, requestTimeoutMs = 1500, ...extra } = {}) {
  const endpoint = '\\\\.\\pipe\\codex-app-tools-' + randomUUID();
  const callerThreadId = randomUUID();
  const sockets = new Set();
  const calls = [];
  const attempts = [];
  let thread = { id: sessionId, title: '模拟会话', cwd: workspace, hostId: 'local', status: { type: 'idle' } };
  let turns = [{ id: turnId, status: 'completed', items: [user('input', '问题')] }];
  let sendReply = { threadId: sessionId };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const end = buffer.readUInt32LE() + 4;
        const request = JSON.parse(buffer.subarray(4, end));
        buffer = buffer.subarray(end);
        calls.push(request);
        let result;
        let error;
        if (request.method === 'tools/list') {
          result = { tools: ['list_threads', 'read_thread', 'send_message_to_thread', 'get_usage_limits',
            'list_projects', 'create_thread', 'set_thread_title'].map(name => ({
            name, namespace: 'fixture', ...(name === 'create_thread' && { inputSchema: { required: ['prompt'] } }),
            ...(name === 'list_threads' && listInputs && { inputSchema: {
              properties: Object.fromEntries(listInputs.map(property => [property, {}]))
            } })
          })) };
        } else {
          assert.equal(request.params.threadId, callerThreadId);
          assert.equal(request.params.callerSource, 'codex');
          assert.equal(request.params.namespace, 'fixture');
          assert.equal(typeof request.params.callId, 'string');
          const { tool, arguments: args } = request.params;
          let data;
          if (tool === 'list_threads') {
            if (args.mode === 'history' && historyFailure === 'timeout') return;
            if (args.mode === 'history' && historyFailure === 'rejected') error = { code: -32602, message: 'fixture rejected history' };
            if (args.mode === 'history' && historyFailure === 'failed') result = { success: false };
            data = { pinnedThreads: [thread], threads: [thread, { ...thread, id: 'remote', hostId: 'other-host' }] };
          } else if (tool === 'read_thread') {
            assert.equal(args.includeOutputs, false);
            assert.equal(args.turnLimit, 1);
            data = { thread, turns, page: { order: 'newest_first' } };
          } else if (tool === 'send_message_to_thread') data = sendReply;
          else if (tool === 'get_usage_limits') {
            if (quotaTimeout) return;
            data = { rateLimits: { primary: { usedPercent: 25 } } };
          }
          else if (tool === 'list_projects') data = { projects: [{ projectId: 'project', path: workspace, hostId: 'local' }] };
          else if (tool === 'create_thread') data = { threadId: sessionId, hostId: 'local' };
          else assert.fail('unexpected desktop tool ' + tool);
          if (data === 'disconnect') { socket.destroy(); return; }
          result ??= { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
        }
        const response = frame({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) });
        socket.write(response.subarray(0, 2));
        setImmediate(() => { if (!socket.destroyed) socket.write(response.subarray(2)); });
      }
    });
  });
  if (process.platform === 'win32') server.listen(endpoint);
  else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const binding = { endpoint, callerThreadId };
  const pipeNames = [path.win32.basename(endpoint), 'codex-app-tools-' + randomUUID()];
  const discovery = discover ? {
    platform: 'win32',
    io: {
      readFile: async () => JSON.stringify(binding),
      readdir: async () => pipeNames
    }
  } : { binding: async () => binding };
  return {
    calls, attempts, endpoint,
    adapter: new WinCodex(validateConfig({ win: { requestTimeoutMs } }), {
      ...discovery,
      createSocket: candidate => { attempts.push(candidate); return connectMockPipe(server); },
      ...extra
    }),
    setThread: value => { thread = { ...thread, ...value }; },
    setTurns: value => { turns = value; },
    setSendReply: value => { sendReply = value; }
  };
}

test('Windows 桌面按工具 schema 请求纯本地历史，旧 schema 和缺失的可选参数保持兼容', async t => {
  const inputs = ['mode', 'source', 'hostId', 'archived'];
  for (const [listInputs, expected] of [
    [inputs, localHistory],
    [inputs.slice(0, 3), { mode: 'history', source: 'codex', hostId: 'local', limit: 50 }],
    [['source', 'hostId', 'archived'], { limit: 50 }]
  ]) {
    const f = await fixture(t, { listInputs, discover: true });
    assert.deepEqual((await f.adapter.list(60)).map(row => row.sessionId), [sessionId]);
    assert.deepEqual(f.calls.filter(call => call.params.tool === 'list_threads').map(call => call.params.arguments), [expected]);
  }
});

test('本地历史仅在原生拒绝或工具失败时回退一次，超时不重查默认模式', async t => {
  for (const historyFailure of ['rejected', 'failed', 'timeout']) {
    const f = await fixture(t, { listInputs: ['mode', 'source', 'hostId', 'archived'], historyFailure, requestTimeoutMs: 200 });
    if (historyFailure === 'timeout') await assert.rejects(f.adapter.list(50), { code: 'NATIVE_TIMEOUT' });
    else assert.equal((await f.adapter.list(50)).length, 1);
    const expected = historyFailure === 'timeout' ? [localHistory] : [localHistory, { limit: 50 }];
    assert.deepEqual(f.calls.filter(call => call.params.tool === 'list_threads').map(call => call.params.arguments), expected);
  }
});

test('Windows 可选额度超时保留心跳和健康端点，同条连接仍可读取', { timeout: 2500 }, async t => {
  const f = await fixture(t, { quotaTimeout: true, discover: true, requestTimeoutMs: 200 });
  const result = await f.adapter.heartbeat({ sessionIds: [sessionId], includeQuota: true });
  assert.equal(result.quota, null);
  assert.deepEqual(result.sessions.map(row => row.sessionId), [sessionId]);
  assert.deepEqual(result.catalog.map(row => row.sessionId), [sessionId]);
  assert.deepEqual(f.attempts, [f.endpoint]);
  assert.equal(f.adapter.lastHealthyEndpoint, f.endpoint);
  assert.equal(f.adapter.unhealthyUntil.size, 0);

  await f.adapter.withPipe(async client => {
    await assert.rejects(client.call('get_usage_limits', {}, { timeoutMs: 100 }), { code: 'NATIVE_TIMEOUT' });
    assert.ok((await client.call('list_threads', { limit: 1 })).threads.length);
  });
  await assert.rejects(f.adapter.withPipe(client => client.call('get_usage_limits', {})), { code: 'NATIVE_TIMEOUT' });
  assert.deepEqual(f.attempts, [f.endpoint, f.endpoint, f.endpoint]);
  assert.equal(f.adapter.unhealthyUntil.size, 0);
});

test('Windows 管道白名单支持只读额度查询', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.withPipe(client => client.call('get_usage_limits', {})), {
    rateLimits: { primary: { usedPercent: 25 } }
  });
});

test('Windows 桌面通过长度帧完成项目匹配和新建，遵守原生工具声明的必需首条消息', async t => {
  const f = await fixture(t);
  const args = { workspacePath: 'c:/mock/workspace/', title: 'Fixture' };
  assert.equal((await f.adapter.create(args)).reason, 'initial_prompt_required');
  assert.equal(f.calls.some(call => call.params.tool === 'create_thread'), false);
  const result = await f.adapter.create({ ...args, prompt: 'Mock only' });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.result, 'created');
  assert.deepEqual(f.calls.at(-1).params.arguments, {
    title: 'Fixture', prompt: 'Mock only',
    target: { type: 'project', projectId: 'project', environment: { type: 'local' } }
  });
});

test('Windows 管道使用长度帧派发一次并要求原生会话回执', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.adapter.list(30)).map(row => row.sessionId), [sessionId]);
  assert.equal((await f.adapter.status(sessionId)).latestTurn.id, turnId);
  const input = { sessionId, expectedWorkspace: 'c:/MOCK/workspace/', prompt: '合成测试', mode: 'queue', operationId: 'test-op' };
  assert.deepEqual(await f.adapter.send(input), {
    result: 'accepted', operationId: 'test-op', sessionId, turnId: null, beforeTurnId: turnId, effectiveDelivery: 'unconfirmed'
  });
  let writes = f.calls.filter(call => call.params.tool === 'send_message_to_thread');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params.arguments, {
    threadId: sessionId, hostId: 'local', prompt: '[AGY_BRIDGE_OP:test-op]\n合成测试'
  });
  f.setThread({ cwd: 'C:\\Mock\\Wrong' });
  assert.equal((await f.adapter.send(input)).reason, 'session_identity_mismatch');
  f.setThread({ cwd: workspace, status: { type: 'active' } });
  f.setTurns([{ id: turnId, status: 'inProgress' }]);
  assert.equal((await f.adapter.send(input)).reason, 'queue_waiting_for_idle');
  assert.equal((await f.adapter.interrupt({ sessionId, expectedWorkspace: workspace, expectedTurnId: turnId })).reason, 'delivery_mode_unsupported');
  f.setSendReply({ threadId: 'wrong-id' });
  assert.equal((await f.adapter.send({ ...input, mode: 'steer' })).code, 'UNKNOWN_OUTCOME');
  f.setSendReply('disconnect');
  assert.equal((await f.adapter.send({ ...input, mode: 'steer' })).result, 'unknown');
  writes = f.calls.filter(call => call.params.tool === 'send_message_to_thread');
  assert.equal(writes.length, 3);
  assert.ok(f.calls.every(call => !['interrupt', 'create_thread'].includes(call.params.tool)));
});

test('Windows 首次操作校验真实工作区，无历史派发返回空 beforeTurnId', async t => {
  const f = await fixture(t);
  const args = { sessionId, prompt: '合成测试', mode: 'queue', operationId: 'workspace-op' };
  const mismatch = { result: 'not_sent', reason: 'session_identity_mismatch', code: 'SESSION_IDENTITY_MISMATCH' };
  assert.deepEqual(await f.adapter.send({ ...args, expectedWorkspace: 'C:\\Wrong' }), mismatch);
  assert.deepEqual(await f.adapter.send(args), mismatch);
  f.setThread({ status: { type: 'active' } });
  f.setTurns([{ id: turnId, status: 'inProgress' }]);
  assert.deepEqual(await f.adapter.interrupt({ sessionId, expectedWorkspace: 'C:\\Wrong', expectedTurnId: turnId }), mismatch);
  assert.equal(f.calls.filter(call => call.params.tool === 'send_message_to_thread').length, 0);
  f.setThread({ status: { type: 'idle' } });
  f.setTurns([]);
  const accepted = await f.adapter.send({ ...args, expectedWorkspace: workspace });
  assert.equal(accepted.result, 'accepted');
  assert.equal(accepted.beforeTurnId, null);
});

function rolloutFixture() {
  const base = path.resolve('test', 'virtual-codex-sessions');
  const file = 'rollout-synthetic-' + sessionId + '.jsonl';
  const starts = [];
  const bytes = record => Buffer.from(JSON.stringify(record) + '\n');
  let buf = Buffer.concat([
    bytes({ type: 'session_meta', payload: { id: sessionId, cwd: workspace } }),
    bytes({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
    bytes({ type: 'response_item', payload: { type: 'message', phase: 'final_answer', role: 'assistant', content: [{ type: 'output_text', text: '等待完成记录' }] } })
  ]);
  let mtimeMs = 1;
  return {
    starts,
    bytes,
    get length() { return buf.length; },
    append(content) { buf = Buffer.concat([buf, content]); mtimeMs++; },
    read: createRolloutReader(base, {
      async realpath(value) { return path.resolve(value); },
      async readdir(value) {
        assert.equal(value, base);
        return [{ name: file, isDirectory: () => false, isFile: () => true }];
      },
      async open(value, mode) {
        assert.equal(value, path.join(base, file));
        assert.equal(mode, 'r');
        return {
          async stat() { return { dev: 1, ino: 1, size: buf.length, mtimeMs, isFile: () => true }; },
          async read(destination, offset, length, position) {
            return { bytesRead: buf.copy(destination, offset, position, position + length) };
          },
          createReadStream({ start, end }) {
            starts.push(start);
            return Readable.from([buf.subarray(start, end + 1)]);
          },
          async close() {}
        };
      }
    })
  };
}

test('Windows 读取公开消息并增量补齐匹配会话和已完成轮次的 rollout 最终回答', async t => {
  const r = rolloutFixture();
  const f = await fixture(t, { rollout: r.read });
  f.setTurns([{ id: turnId, status: 'completed', items: [
    user('input', '问题'), { id: 'reason', type: 'reasoning', text: 'secret reasoning' },
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '执行中' }
  ] }]);
  assert.deepEqual((await f.adapter.read(sessionId)).messages.map(item => item.text), ['问题', '执行中']);
  const completion = r.bytes({ type: 'event_msg', payload: {
    type: 'task_complete', turn_id: turnId, last_agent_message: '最终回答 password=synthetic-password'
  } });
  const firstOffset = r.length;
  const multibyte = completion.indexOf(Buffer.from('最')) + 1;
  r.append(completion.subarray(0, multibyte));
  assert.equal(await r.read(sessionId, workspace, turnId), null);
  r.append(completion.subarray(multibyte));
  const page = await f.adapter.read(sessionId, { limit: 3 });
  assert.deepEqual(page.messages.map(item => item.phase), [undefined, 'commentary', 'final_answer']);
  assert.match(page.messages[2].text, /^最终回答 password=\[已遮盖\]$/);
  assert.deepEqual(r.starts, [0, firstOffset, firstOffset + multibyte]);
  assert.equal(await r.read(sessionId, 'C:\\Wrong', turnId), null);
  assert.equal(await r.read(sessionId, workspace, randomUUID()), null);
});

test('Windows 调用会话发现限量读取首条元数据，跳过子代理并按时间与路径排序', async () => {
  const sessionsRoot = path.resolve('test', 'virtual-win-sessions');
  const latest = randomUUID();
  const regular = randomUUID();
  const other = randomUUID();
  const guardian = 'rollout-guardian-' + latest + '.jsonl';
  const regularFile = 'rollout-z-main-' + regular + '.jsonl';
  const otherFile = 'rollout-a-main-' + other + '.jsonl';
  const firstLine = source => JSON.stringify({ type: 'session_meta', payload: { source } }) + '\r\n';
  const guardianMeta = firstLine({ subagent: { guardian: {} } });
  const sources = new Map([[guardian, guardianMeta], [regularFile, firstLine('vscode')], [otherFile, firstLine('cli')]]);
  const closed = [];
  const list = {
    readdir: async () => [otherFile, guardian, regularFile],
    lstat: async file => ({ isFile: () => true, mtimeMs: path.basename(file) === guardian ? 300 : 200 })
  };
  const discovered = await discoverWinCallerThread(sessionsRoot, {
    ...list,
    async open(file, flag) {
      assert.equal(flag, 'r');
      const name = path.basename(file);
      return {
        async read(buffer, offset, length, position) {
          assert.deepEqual([offset, length, position], [0, 4096, 0]);
          const bytesRead = Buffer.from(sources.get(name) + 'x'.repeat(5000)).copy(buffer, offset, 0, length);
          return { bytesRead };
        },
        async close() { closed.push(name); }
      };
    },
    readFile: async () => assert.fail('open is available')
  });
  assert.equal(discovered, regular);
  assert.deepEqual(closed, [guardian, regularFile]);

  const selected = source => discoverWinCallerThread(sessionsRoot, {
    ...list,
    readFile: async (file, encoding) => {
      assert.equal(encoding, 'utf8');
      return source(path.basename(file));
    }
  });
  assert.equal(await selected(() => guardianMeta), latest);
  assert.equal(await selected(name => name === guardian ? guardianMeta : '{invalid fixture JSON'), regular);
  assert.equal(await selected(name => {
    if (name === guardian) throw new Error('fixture unreadable');
    return firstLine('cli');
  }), latest);
});

test('Windows 缺失发现文件时自动扫描桌面管道与最新 rollout 会话并连上通信', async t => {
  const olderCaller = randomUUID();
  const newestCaller = randomUUID();
  const pipeName = 'codex-app-tools-' + randomUUID();
  const livePipe = '\\\\.\\pipe\\' + pipeName;
  const sessionsRoot = path.resolve('test', 'virtual-win-sessions');
  const dayDir = path.join(sessionsRoot, '2026', '11', '25');
  const olderFile = path.join(dayDir, 'rollout-2026-11-25T10-00-00-' + olderCaller + '.jsonl');
  const newestFile = path.join(dayDir, 'rollout-2026-11-25T20-00-00-' + newestCaller + '.jsonl');
  const dirEntry = (name, isDir) => ({ name, isDirectory: () => isDir, isFile: () => !isDir });
  const io = {
    async readFile() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    async readdir(dir) {
      if (dir === '\\\\.\\pipe\\') return ['codex-browser-use-' + randomUUID(), pipeName];
      if (dir === sessionsRoot) return [dirEntry('2026', true)];
      if (dir === path.join(sessionsRoot, '2026')) return [dirEntry('11', true)];
      if (dir === path.join(sessionsRoot, '2026', '11')) return [dirEntry('25', true)];
      if (dir === dayDir) return [dirEntry(path.basename(olderFile), false), dirEntry(path.basename(newestFile), false)];
      return [];
    },
    async lstat(targetPath) {
      if (targetPath === olderFile) return { mtimeMs: 100, isFile: () => true };
      if (targetPath === newestFile) return { mtimeMs: 200, isFile: () => true };
      return null;
    }
  };
  assert.deepEqual(await discoverWinPipes(io, 'win32'), [livePipe]);
  assert.equal(await discoverWinCallerThread(sessionsRoot, io), newestCaller);

  const server = net.createServer(socket => {
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= buf.readUInt32LE() + 4) {
        const end = buf.readUInt32LE() + 4;
        const req = JSON.parse(buf.subarray(4, end));
        buf = buf.subarray(end);
        let result;
        if (req.method === 'tools/list') result = { tools: [{ name: 'list_threads', namespace: 'fixture' }] };
        else {
          assert.equal(req.params.threadId, newestCaller);
          result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threads: [{ id: sessionId, title: 'Auto', cwd: workspace, hostId: 'local', status: { type: 'idle' } }] }) }] };
        }
        socket.write(frame({ jsonrpc: '2.0', id: req.id, result }));
      }
    });
  });
  if (process.platform === 'win32') server.listen(livePipe);
  else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const adapter = new WinCodex(validateConfig({ win: { sessionsRoot, requestTimeoutMs: 1500 } }), {
    env: { AGY_NATIVE_BRIDGE_HOME: path.resolve('test', 'missing-home') },
    io,
    platform: 'win32',
    createSocket: endpoint => {
      assert.equal(endpoint, livePipe);
      return process.platform === 'win32' ? net.createConnection(livePipe)
        : net.createConnection({ host: '127.0.0.1', port: server.address().port });
    }
  });
  const rows = await adapter.list(5);
  assert.deepEqual(rows.map(row => row.sessionId), [sessionId]);
});

test('Windows 发现文件指向旧管道时优先跳过失效管道并选用活动管道', async () => {
  const caller = randomUUID();
  const stalePipe = '\\\\.\\pipe\\codex-app-tools-' + randomUUID();
  const livePipe = '\\\\.\\pipe\\codex-app-tools-' + randomUUID();
  const sessionsRoot = path.resolve('test', 'virtual-win-sessions');
  const ioWithLive = {
    async readFile() { return JSON.stringify({ endpoint: stalePipe, callerThreadId: caller }); },
    async readdir(dir) { return dir === '\\\\.\\pipe\\' ? [path.basename(livePipe)] : []; }
  };
  assert.deepEqual(
    await resolveWinBindings(validateConfig({ win: { sessionsRoot } }), { io: ioWithLive, platform: 'win32' }),
    [{ endpoint: livePipe, callerThreadId: caller }]
  );
  const ioNoScan = {
    async readFile() { return JSON.stringify({ endpoint: stalePipe, callerThreadId: caller }); },
    async readdir() { throw new Error('unsupported'); }
  };
  assert.deepEqual(
    await resolveWinBindings(validateConfig({ win: { sessionsRoot } }), { io: ioNoScan, platform: 'win32' }),
    [{ endpoint: stalePipe, callerThreadId: caller }]
  );
});

test('Windows 首条管道挂起时自动切换至健康管道并在冷却期跳过故障管道', async t => {
  const caller = randomUUID();
  const zombieName = 'codex-app-tools-00000000-0000-4000-8000-000000000001';
  const healthyName = 'codex-app-tools-00000000-0000-4000-8000-000000000002';
  const zombiePipe = '\\\\.\\pipe\\' + zombieName;
  const healthyPipe = '\\\\.\\pipe\\' + healthyName;
  const attempts = [];
  const createMultiServer = handler => {
    const server = net.createServer(socket => {
      socket.on('error', () => {});
      let buf = Buffer.alloc(0);
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4 && buf.length >= buf.readUInt32LE() + 4) {
          const end = buf.readUInt32LE() + 4;
          const req = JSON.parse(buf.subarray(4, end));
          buf = buf.subarray(end);
          handler(req, socket);
        }
      });
    });
    return server;
  };
  const zombieServer = createMultiServer((req, socket) => {
    if (req.method === 'tools/list') {
      socket.write(frame({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'list_threads', namespace: 'fixture' }] } }));
    }
    // Hang on list_threads to simulate a post-lock zombie desktop pipe.
  });
  const healthyServer = createMultiServer((req, socket) => {
    let result;
    if (req.method === 'tools/list') result = { tools: [{ name: 'list_threads', namespace: 'fixture' }] };
    else result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threads: [{ id: sessionId, title: 'Recovered', cwd: workspace, hostId: 'local', status: { type: 'idle' } }] }) }] };
    socket.write(frame({ jsonrpc: '2.0', id: req.id, result }));
  });
  for (const server of [zombieServer, healthyServer]) await listenMockPipe(t, server);
  const io = {
    async readFile() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    async readdir(dir) { return dir === '\\\\.\\pipe\\' ? [zombieName, healthyName] : []; }
  };
  let now = 1_761_000_000_000;
  const adapter = new WinCodex(validateConfig({ win: { sessionsRoot: path.resolve('test', 'virtual-win-sessions'), callerThreadId: caller, requestTimeoutMs: 250 } }), {
    env: { AGY_NATIVE_BRIDGE_HOME: path.resolve('test', 'missing-home') },
    io,
    platform: 'win32',
    clock: () => now,
    createSocket: endpoint => {
      attempts.push(endpoint);
      return connectMockPipe(endpoint === zombiePipe ? zombieServer : healthyServer);
    }
  });
  const first = await adapter.list(5);
  assert.deepEqual(first.map(row => row.sessionId), [sessionId]);
  assert.deepEqual(attempts, [zombiePipe, healthyPipe]);

  attempts.length = 0;
  now += 5_000;
  const second = await adapter.list(5);
  assert.deepEqual(second.map(row => row.sessionId), [sessionId]);
  assert.deepEqual(attempts, [healthyPipe]);
});

test('Windows 写入工具在首条管道超时时保持 unknown 且绝不在备用管道重投', async t => {
  const caller = randomUUID();
  const pipeAName = 'codex-app-tools-00000000-0000-4000-8000-000000000003';
  const pipeBName = 'codex-app-tools-00000000-0000-4000-8000-000000000004';
  const pipeA = '\\\\.\\pipe\\' + pipeAName;
  const pipeB = '\\\\.\\pipe\\' + pipeBName;
  const sends = [];
  const createMultiServer = endpoint => net.createServer(socket => {
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= buf.readUInt32LE() + 4) {
        const end = buf.readUInt32LE() + 4;
        const req = JSON.parse(buf.subarray(4, end));
        buf = buf.subarray(end);
        if (req.method === 'tools/list') {
          socket.write(frame({ jsonrpc: '2.0', id: req.id, result: { tools: ['read_thread', 'send_message_to_thread'].map(name => ({ name, namespace: 'fixture' })) } }));
        } else if (req.params.tool === 'read_thread') {
          socket.write(frame({ jsonrpc: '2.0', id: req.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ thread: { id: sessionId, title: 'Write', cwd: workspace, hostId: 'local', status: { type: 'idle' } }, turns: [], page: { order: 'newest_first' } }) }] } }));
        } else if (req.params.tool === 'send_message_to_thread') {
          sends.push(endpoint);
          // Drop/hang write on pipeA; must not fail over to pipeB.
        }
      }
    });
  });
  const serverA = createMultiServer(pipeA);
  const serverB = createMultiServer(pipeB);
  for (const server of [serverA, serverB]) await listenMockPipe(t, server);
  const io = {
    async readFile() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    async readdir(dir) { return dir === '\\\\.\\pipe\\' ? [pipeAName, pipeBName] : []; }
  };
  const adapter = new WinCodex(validateConfig({ win: { sessionsRoot: path.resolve('test', 'virtual-win-sessions'), callerThreadId: caller, requestTimeoutMs: 250 } }), {
    env: { AGY_NATIVE_BRIDGE_HOME: path.resolve('test', 'missing-home') },
    io,
    platform: 'win32',
    createSocket: endpoint => connectMockPipe(endpoint === pipeA ? serverA : serverB)
  });
  const outcome = await adapter.send({ sessionId, expectedWorkspace: workspace, prompt: 'no-retry', mode: 'queue', operationId: 'op-no-retry' });
  assert.equal(outcome.result, 'unknown');
  assert.deepEqual(sends, [pipeA]);
});
