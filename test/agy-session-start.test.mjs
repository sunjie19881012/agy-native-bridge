import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hookConversationId, sessionStartSummary } from '../src/hooks/agy-session-start.mjs';
import { checkMcp } from '../src/sidecar/doctor.mjs';

const now = Date.parse('2026-11-25T07:00:00Z');
const sample = (sessions, { age = 1000, reachable = true } = {}) => ({
  intervalMs: 30_000, targets: { '101-codex': { reachable, sampledAt: new Date(now - age).toISOString(), sessions } }
});

test('SessionStart 仅为运行、待审批或刚完成未读的会话注入短摘要', () => {
  const active = { state: 'active', title: '不得注入实际会话正文或标题' };
  const done = { state: 'idle', unread: { kind: 'completed', at: now - 1000 } };
  const snapshot = sample([active, { state: 'waiting_approval' }, done]);
  snapshot.targets['win-codex'] = { ...snapshot.targets['101-codex'] };
  const sentence = sessionStartSummary(snapshot, now).injectSteps[0].systemMessage.systemMessage;
  assert.match(sentence, /101 运行 1、待审批 1、完成未读 1/);
  assert.match(sentence, /Windows 运行 1、待审批 1、完成未读 1/);
  assert.doesNotMatch(sentence, /不得注入/);
  assert.ok(Array.from(sentence).length < 70);
  assert.match(sessionStartSummary(sample([done]), now).injectSteps[0].systemMessage.systemMessage, /完成未读 1/);
});

test('SessionStart 在缓存缺失、过期、全空闲、离线或未读太旧时保持静默', () => {
  for (const value of [null, sample([{ state: 'idle' }]), sample([{ state: 'idle', unread: { kind: 'completed', at: now - 901_000 } }]),
    sample([{ state: 'active' }], { age: 60_000 }), sample([{ state: 'waiting_approval' }], { reachable: false })]) {
    assert.deepEqual(sessionStartSummary(value, now), {});
  }
});

test('SessionStart 只注入当前对话的未隐藏配对和分工，未关联对话静默', () => {
  const state = sample([{ sessionId: 'second', state: 'idle', title: '原生标题' }]);
  const prefs = { sessions: {
    'win-dsh:paired-task': { pairedConversationId: 'chat_a', pairLabel: '示例任务', pairedAt: new Date(now).toISOString() },
    '101-codex:second': { pairedConversationId: 'chat_b' },
    'win-codex:excluded': { pairedConversationId: 'chat_a', hidden: true, pairLabel: '不应注入' }
  } };
  const message = (conversationId, snapshot = state) =>
    sessionStartSummary(snapshot, now, { prefs, conversationId }).injectSteps?.[0].systemMessage.systemMessage;
  const first = message('chat_a', null);
  assert.match(first, /win-dsh paired-task「示例任务」.*默认由协作窗口改动、自测/);
  assert.match(first, /仅用户明确要求时本端才改代码/);
  assert.doesNotMatch(first, /excluded|不应注入|second/);
  assert.equal(first.split('\n').length, 1);
  assert.ok(Array.from(first).length < 120);
  assert.match(message('chat_b'), /101-codex second「原生标题」/);
  assert.equal(message('unrelated_chat'), undefined);
  assert.equal(message(undefined), undefined);
});

test('SessionStart 从 stdin 识别对话 ID，空或非法内容安全回退到宿主环境', () => {
  const env = { ANTIGRAVITY_CONVERSATION_ID: 'env_chat' };
  assert.equal(hookConversationId('{"conversationId":"stdin_chat"}', env), 'stdin_chat');
  assert.equal(hookConversationId('{"conversation_id":"second_chat"}', env), 'second_chat');
  for (const bad of ['', '{bad JSON', '{"conversationId":"invalid/id"}', '{"conversationId":"--help"}']) {
    assert.equal(hookConversationId(bad, env), 'env_chat');
  }
  assert.equal(hookConversationId('', {}), undefined);
});

test('SessionStart 一对多只摘要未隐藏关联总数和最近关联会话', () => {
  const prefs = { sessions: {
    'win-codex:earlier': { pairedConversationId: 'fixture_chat', pairedAt: new Date(now - 2000).toISOString() },
    'win-codex:same-end': { pairedConversationId: 'fixture_chat', pairedAt: new Date(now - 1000).toISOString() },
    '101-dsh:recent-fixture': { pairedConversationId: 'fixture_chat', pairedAt: new Date(now).toISOString(), pairLabel: '最近评审任务' },
    '101-codex:hidden-item': { pairedConversationId: 'fixture_chat', hidden: true, pairedAt: new Date(now + 1000).toISOString() },
    'win-dsh:other-chat': { pairedConversationId: 'other_chat', pairedAt: new Date(now + 2000).toISOString() }
  } };
  const result = sessionStartSummary(null, now, { prefs, conversationId: 'fixture_chat' });
  const message = result.injectSteps[0].systemMessage.systemMessage;
  assert.match(message, /配对 3 个，最近 101-dsh recent-fixture「最近评审任务」/);
  assert.match(message, /默认由协作窗口改动、自测.*仅用户明确要求时本端才改代码/);
  assert.doesNotMatch(message, /earlier|same-end|hidden-item|other-chat/);
  assert.ok(Array.from(message).length < 100);
});

test('Antigravity Hook 的实际命令找不到状态时输出空 JSON，doctor 执行真实本地 MCP 握手', () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'));
  const hook = hooks['agy-native-bridge'].SessionStart[0];
  assert.equal(hook.timeout, 2);
  assert.match(hook.command, /^node -e ".+"$/);
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ANTIGRAVITY_/i.test(key)));
  const env = { ...childEnv, PLUGIN_ROOT: process.cwd(), AGY_NATIVE_BRIDGE_HOME: path.resolve('test', 'missing-home') };
  const child = spawnSync(process.execPath, ['-e', hook.command.slice('node -e "'.length, -1)], {
    env, timeout: 2000, encoding: 'utf8'
  });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), {});
  assert.match(checkMcp(env), /2025-11-25/);
});
