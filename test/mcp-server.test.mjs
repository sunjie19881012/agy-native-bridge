import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const initialize = version => request(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'mock', version: '1' } });
const ready = request(undefined, 'notifications/initialized');
const tool = (id, name, args) => request(id, 'tools/call', { name, arguments: args });
const session = { target: '101-codex', sessionId: 'test-session' };
const writeSession = { ...session, expectedWorkspace: '/test/fixture' };

const fixture = [
  "import { serve } from './src/mcp/server.mjs';",
  "import { BridgeError } from './src/shared/errors.mjs';",
  'const remote = {',
  "  list: async limit => [{ target: '101-codex', sessionId: 'test-session', limit }],",
  "  status: async sessionId => ({ sessionId, state: 'idle' }),",
  '  read: async (sessionId, options) => ({ sessionId, maxChars: options.maxChars }),',
  "  send: async args => { if (args.prompt === 'notification') process.stderr.write('unexpected send'); return { result: 'accepted', args }; },",
  "  interrupt: async args => ({ result: 'not_sent', reason: 'target_execution_changed', args }),",
  "  create: async args => ({ result: 'created', target: '101-codex', sessionId: 'new-session', ...args })",
  '};',
  "const windows = { list: async () => { throw new BridgeError('PIPE_UNAVAILABLE', 'fixture offline'); } };",
  "await serve({ '101-codex': remote, 'win-codex': windows }, { env: {} });"
].join('\n');

function stdio(messages, args = ['--input-type=module', '-e', fixture]) {
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ANTIGRAVITY_/i.test(key)));
  const child = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 10_000,
    input: messages.map(message => typeof message === 'string' ? message : JSON.stringify(message)).join('\n') + '\n',
    env: { ...childEnv, AGY_NATIVE_BRIDGE_HOME: path.resolve('test', 'missing-home'), CODEX_HOME: path.resolve('test', 'missing-home') }
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  return child.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('通过 stdio 兼容三种协议版本，MCP 只公布六个工具', () => {
  const names = ['bridge_list', 'bridge_status', 'bridge_read', 'bridge_send', 'bridge_interrupt', 'bridge_create'];
  for (const version of ['2024-11-05', '2025-03-26', '2025-11-25']) {
    const replies = stdio([
      initialize(version), request(2, 'tools/list'), ready, request(3, 'tools/list'),
      tool(4, 'bridge_create', { ...session, sessionId: undefined, workspacePath: '/mock', title: 'Mock' })
    ]);
    const byId = new Map(replies.map(reply => [reply.id, reply]));
    assert.equal(byId.get(1).result.protocolVersion, version);
    assert.equal(byId.get(2).error.code, -32002);
    const tools = byId.get(3).result.tools;
    assert.deepEqual(tools.map(tool => tool.name), names);
    assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
    assert.deepEqual(tools.filter(tool => tool.inputSchema.required.includes('expectedWorkspace')).map(tool => tool.name),
      ['bridge_send', 'bridge_interrupt']);
    assert.equal(JSON.parse(byId.get(4).result.content[0].text).result, 'created');
    assert.equal(Boolean(byId.get(4).result.structuredContent), version === '2025-11-25');
  }
});

test('MCP 2025-03-26 接收入站 JSON-RPC 批次且不回复通知', () => {
  const replies = stdio([
    initialize('2025-03-26'), ready, [
      request(2, 'ping'), request(undefined, 'notifications/cancelled', { requestId: 2 }), request(3, 'tools/list')
    ]
  ]);
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[1].map(reply => reply.id), [2, 3]);
  assert.deepEqual(replies[1][0].result, {});
});

test('MCP 工具校验、公开结果与派发参数边界', () => {
  const send = { ...writeSession, prompt: 'fixture request' };
  const messages = [
    '{bad json', initialize('2025-11-25'), ready, request(2, 'ping'),
    tool(3, 'bridge_list', {}), tool(4, 'bridge_status', session), tool(5, 'bridge_read', { ...session, maxChars: 20 }),
    tool(6, 'bridge_send', { ...send, notifyOnFinish: true, autoReadOnFinish: true }), tool(7, 'bridge_interrupt', { ...writeSession, expectedTurnId: 'old' }),
    tool(8, 'bridge_send', { ...send, model: 'invalid' }), tool(9, 'bridge_send', { ...send, reasoningEffort: 'invalid' }),
    tool(10, 'bridge_send', { ...send, sandbox: 'invalid' }), tool(11, 'bridge_read', { ...session, limit: 21 }),
    tool(12, 'bridge_read', { ...session, maxChars: 24_001 }), tool(13, 'bridge_status', { ...session, target: 'invalid' }),
    tool(14, 'bridge_interrupt', writeSession), tool(15, 'reconcile', session),
    tool(16, 'bridge_send', { ...send, autoReadOnFinish: 'true' }),
    tool(undefined, 'bridge_send', { ...send, prompt: 'notification' })
  ];
  const replies = stdio(messages);
  assert.equal(replies.length, 17);
  const byId = new Map(replies.map(reply => [reply.id, reply]));
  assert.equal(byId.get(null).error.code, -32700);
  assert.deepEqual(byId.get(2).result, {});
  const get = id => byId.get(id).result.structuredContent;
  assert.equal(get(3).targets['101-codex'].sessions[0].limit, 30);
  assert.equal(get(3).targets['win-codex'].reachable, false);
  assert.equal(get(4).state, 'idle');
  assert.equal(get(5).maxChars, 20);
  assert.deepEqual(Object.keys(get(6).args).sort(), ['expectedWorkspace', 'mode', 'operationId', 'prompt', 'sessionId']);
  assert.equal(get(6).args.expectedWorkspace, writeSession.expectedWorkspace);
  assert.equal(get(6).args.mode, 'queue');
  assert.match(get(6).args.operationId, /^[a-f0-9-]{36}$/);
  assert.equal(get(7).reason, 'target_execution_changed');
  assert.equal(get(7).args.expectedWorkspace, writeSession.expectedWorkspace);
  for (let id = 8; id <= 14; id++) {
    assert.equal(byId.get(id).result.isError, true);
    assert.equal(get(id).error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal(byId.get(15).error.code, -32602);
  assert.equal(get(16).error.code, 'INVALID_ARGUMENTS');
});

test('MCP 拒绝派发和中断缺少 expectedWorkspace', () => {
  const replies = stdio([
    initialize('2025-11-25'), ready,
    tool(2, 'bridge_send', { ...session, prompt: 'fixture request' }),
    tool(3, 'bridge_interrupt', { ...session, expectedTurnId: 'turn-id' }),
    tool(4, 'bridge_send', { ...session, expectedWorkspace: ' ', prompt: 'fixture request' }),
    tool(5, 'bridge_interrupt', { ...session, expectedWorkspace: null, expectedTurnId: 'turn-id' })
  ]);
  assert.equal(replies.length, 5);
  for (const { result } of replies.filter(reply => reply.id !== 1)) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENTS');
  }
});

test('Antigravity MCP 配置只预加载四个高频工具', () => {
  const config = JSON.parse(readFileSync(new URL('../mcp_config.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.mcpServers['native-bridge'].tools, {
    bridge_list: { eager: true }, bridge_status: { eager: true },
    bridge_read: { eager: true }, bridge_send: { eager: true }
  });
});

test('生产 stdio 入口在隔离配置目录中拒绝调用未配置的 DSH 目标', () => {
  const replies = stdio([
    initialize('2025-11-25'), ready,
    tool(2, 'bridge_list', { target: 'win-dsh' }),
    tool(3, 'bridge_status', { target: 'win-dsh', sessionId: 'mock' }),
    tool(4, 'bridge_create', { target: 'win-dsh', workspacePath: 'C:\\Mock', title: 'Test' })
  ], [path.resolve('src', 'mcp', 'server.mjs')]);
  const byId = new Map(replies.map(reply => [reply.id, reply.result]));
  assert.equal(byId.get(2).structuredContent.targets['win-dsh'].error.code, 'DSH_NOT_CONFIGURED');
  for (const id of [3, 4]) {
    assert.equal(byId.get(id).structuredContent.error.code, 'DSH_NOT_CONFIGURED');
  }
});
