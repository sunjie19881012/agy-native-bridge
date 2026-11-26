import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopCodex } from '../src/adapters/desktop-codex.mjs';
import { RemoteCodex } from '../src/adapters/remote-codex.mjs';
import { createToolInvoker } from '../src/mcp/server.mjs';
import { BridgeError } from '../src/shared/errors.mjs';

const reminder = '请在原窗口核对新会话的模型、思考强度与审批策略。';

function desktopFixture(target, projects, { promptRequired = false, result = { threadId: 'new-fixture' } } = {}) {
  const calls = [];
  let closed = 0;
  const adapter = new DesktopCodex({ target, workspaces: {}, connect: async () => ({
    requiresInput(name, property) {
      assert.deepEqual([name, property], ['create_thread', 'prompt']);
      return promptRequired;
    },
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'list_projects') return { projects };
      if (result instanceof Error) throw result;
      return result;
    },
    close() { closed++; }
  }) });
  return { adapter, calls, closed: () => closed };
}

test('Windows 与 101 默认桌面各自匹配唯一的本地项目，只传原生创建需要的字段', async () => {
  const paths = { 'win-codex': ['C:\\Mock\\Project', 'c:/mock/project/'], '101-codex': ['/mock/project', '/mock/project/'] };
  for (const [target, [nativePath, workspacePath]] of Object.entries(paths)) {
    const { adapter, calls, closed } = desktopFixture(target, [
      { hostId: 'local', path: nativePath, projectId: 'fixture-project' },
      { hostId: 'not-local', path: nativePath, projectId: 'remote-project' }
    ]);
    const args = { workspacePath, title: 'Mock title', ...(target === '101-codex' && { prompt: 'mock first message' }) };
    assert.deepEqual(await adapter.create(args), {
      result: 'created', target, sessionId: 'new-fixture', workspacePath: nativePath, title: args.title, reminder
    });
    assert.deepEqual(calls, [['list_projects', {}], ['create_thread', {
      title: args.title, ...(args.prompt && { prompt: args.prompt }),
      target: { type: 'project', projectId: 'fixture-project', environment: { type: 'local' } }
    }]]);
    assert.equal(closed(), 1);
  }
});

test('桌面新建对无匹配、多匹配和必需首条消息均在写入前停止，丢失回执不重试', async () => {
  const target = '101-codex';
  const args = { workspacePath: '/mock/workspace', title: 'Mock title' };
  const project = { hostId: 'local', path: args.workspacePath, projectId: 'fixture-project' };
  for (const [projects, options, reason] of [
    [[], {}, 'workspace_not_found'],
    [[project, { ...project, projectId: 'second' }], {}, 'workspace_ambiguous'],
    [[project], { promptRequired: true }, 'initial_prompt_required']
  ]) {
    const f = desktopFixture(target, projects, options);
    assert.deepEqual(await f.adapter.create(args), { result: 'not_sent', reason });
    assert.deepEqual(f.calls, [['list_projects', {}]]);
  }
  for (const result of [
    new BridgeError('NATIVE_TIMEOUT', 'timed out fixture'), { clientThreadId: 'optimistic' },
    { threadId: 'new', cwd: '/other' }
  ]) {
    const f = desktopFixture(target, [project], { result });
    const outcome = await f.adapter.create(args);
    assert.equal(outcome.result, 'unknown');
    assert.equal(outcome.clientThreadId, result.clientThreadId);
    assert.equal(f.calls.filter(([name]) => name === 'create_thread').length, 1);
  }
});

test('显式 101 daemon 用 thread/start 和改名创建，按需发送首条消息并独立报告回执', async () => {
  const calls = [];
  const adapter = new RemoteCodex({ remote: { transport: 'daemon' }, workspaces: {} });
  adapter.withDaemon = action => action({ async request(method, params) {
    calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'fixture-thread', cwd: '/mock/cwd' } };
    if (method === 'thread/name/set') return {};
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } };
    assert.fail('unexpected request ' + method);
  } });
  const args = { workspacePath: '/mock/cwd/', title: 'Mock title' };
  assert.deepEqual(await adapter.create(args), {
    result: 'created', target: '101-codex', workspacePath: '/mock/cwd', title: args.title, sessionId: 'fixture-thread', reminder
  });
  assert.deepEqual(calls, [
    ['thread/start', { cwd: '/mock/cwd/', ephemeral: false }],
    ['thread/name/set', { threadId: 'fixture-thread', name: args.title }]
  ]);
  const withPrompt = await adapter.create({ ...args, prompt: 'mock prompt' });
  assert.equal(withPrompt.promptDelivery.result, 'accepted');
  assert.equal(withPrompt.promptDelivery.turnId, 'fixture-turn');
  assert.deepEqual(calls.at(-1), ['turn/start', {
    threadId: 'fixture-thread', clientUserMessageId: withPrompt.promptDelivery.operationId,
    input: [{ type: 'text', text: '[AGY_BRIDGE_OP:' + withPrompt.promptDelivery.operationId + ']\nmock prompt' }]
  }]);
});

test('daemon 未收到创建回执不改名或重发，创建已知而首轮未知时保留新会话 ID', async () => {
  const calls = [];
  const adapter = new RemoteCodex({ remote: { transport: 'daemon' }, workspaces: {} });
  let startOk = false;
  adapter.withDaemon = action => action({ async request(name) {
    calls.push(name);
    if (startOk && name === 'thread/start') return { thread: { id: 'fixture-thread', cwd: '/mock' } };
    throw new BridgeError('NATIVE_DISCONNECTED', 'fixture disconnected');
  } });
  const args = { workspacePath: '/mock', title: 'Mock', prompt: 'fixture' };
  assert.equal((await adapter.create(args)).result, 'unknown');
  assert.deepEqual(calls, ['thread/start']);
  startOk = true;
  const result = await adapter.create(args);
  assert.equal(result.result, 'created');
  assert.equal(result.sessionId, 'fixture-thread');
  assert.equal(result.titleConfirmed, false);
  assert.equal(result.promptDelivery.result, 'unknown');
  assert.deepEqual(calls.slice(1), ['thread/start', 'thread/name/set', 'turn/start']);
});

test('MCP 新建成功尽力触发 Sidecar，初始消息已获确认时才记录跟踪', async () => {
  const nudges = [];
  const target = 'win-codex';
  const invoker = createToolInvoker({ [target]: {
    async create(args) {
      return args.title === 'fail' ? { result: 'unknown' } : {
        result: 'created', target, sessionId: 'new-fixture', title: args.title, workspacePath: args.workspacePath,
        reminder, ...(args.prompt && { promptDelivery: { result: 'accepted', turnId: 'first' } })
      };
    }
  } }, { env: {}, async post(route, body) { nudges.push([route, body]); throw new Error('sidecar down'); } });
  const args = { target, workspacePath: 'C:\\Fixture', title: 'Mock' };
  assert.equal((await invoker('bridge_create', args)).result, 'created');
  assert.equal((await invoker('bridge_create', { ...args, prompt: 'mock' })).result, 'created');
  assert.equal((await invoker('bridge_create', { ...args, title: 'fail' })).result, 'unknown');
  assert.equal(nudges.length, 2);
  assert.deepEqual(nudges[0], ['/api/nudge', {
    action: 'create', target, sessionId: 'new-fixture', workspacePath: args.workspacePath
  }]);
  assert.equal(nudges[1][1].tracking, true);
  assert.equal(nudges[1][1].turnId, 'first');
});
