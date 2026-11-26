import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sessionStartSummary } from '../src/hooks/agy-session-start.mjs';
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

test('Antigravity Hook 的实际命令找不到状态时输出空 JSON，doctor 执行真实本地 MCP 握手', () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'));
  const hook = hooks['agy-native-bridge'].SessionStart[0];
  assert.equal(hook.timeout, 2);
  assert.match(hook.command, /^node -e ".+"$/);
  const env = { ...process.env, PLUGIN_ROOT: process.cwd(), AGY_NATIVE_BRIDGE_HOME: path.resolve('test', 'missing-home') };
  const child = spawnSync(process.execPath, ['-e', hook.command.slice('node -e "'.length, -1)], {
    env, timeout: 2000, encoding: 'utf8'
  });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), {});
  assert.match(checkMcp(env), /2025-11-25/);
});
