import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordPipe } from '../src/hooks/codex-pipe-hook.mjs';
import { pipePattern } from '../src/shared/state.mjs';

const id = '6d95b7b3-a74c-4223-a01e-42a68f38e004';
const endpoint = '\\\\.\\pipe\\codex-app-tools-' + id;
const event = { hook_event_name: 'UserPromptSubmit', session_id: id, prompt: 'synthetic private prompt', token: 'synthetic token' };
const env = { CODEX_APP_TOOLS_PIPE_PATH: endpoint, CODEX_THREAD_ID: id, AGY_NATIVE_BRIDGE_HOME: path.resolve('test', 'fake-home') };

test('只接受严格的本机 Codex 管道命名', () => {
  for (const accepted of [endpoint, endpoint.toUpperCase()]) assert.match(accepted, pipePattern);
  for (const denied of [
    endpoint.replace('app-tools', 'browser-use'), endpoint + '\\extra', endpoint.replace('.', 'host'),
    endpoint.replace('codex', 'other'), endpoint.slice(0, -1), 'http://localhost/'
  ]) {
    assert.doesNotMatch(denied, pipePattern);
  }
});

test('普通会话、错误事件与不匹配身份不会写入', async () => {
  const io = { mkdir: () => assert.fail('invalid context must not write') };
  for (const [payload, candidate, platform] of [
    [event, env, 'linux'], [event, {}, 'win32'], [event, { ...env, CODEX_THREAD_ID: 'other-' + id }, 'win32'],
    [event, { ...env, CODEX_THREAD_ID: '' }, 'win32'], [{ ...event, session_id: 'invalid' }, env, 'win32'],
    [{ ...event, hook_event_name: 'Stop' }, env, 'win32'], [event, { ...env, CODEX_APP_TOOLS_PIPE_PATH: 'bad' }, 'win32'],
    [event, { ...env, CODEX_APP_TOOLS_PIPE_PATH: endpoint.replace('app-tools', 'browser-use') }, 'win32']
  ]) assert.equal(await recordPipe(payload, { env: candidate, platform, io }), false);
});

test('发现文件用临时文件原子替换，保存且仅保存最小字段', async () => {
  const target = path.join(env.AGY_NATIVE_BRIDGE_HOME, 'win-codex-pipe.json');
  const writes = new Map([[target, 'old state']]);
  let renamed = false;
  const io = {
    async mkdir(directory, options) {
      assert.equal(directory, env.AGY_NATIVE_BRIDGE_HOME);
      assert.equal(options.recursive, true);
    },
    async writeFile(temporary, json, options) {
      assert.equal(writes.get(target), 'old state');
      assert.notEqual(temporary, target);
      assert.equal(path.dirname(temporary), path.dirname(target));
      assert.equal(options.flag, 'wx');
      writes.set(temporary, json);
    },
    async rename(temporary, file) {
      assert.equal(file, target);
      assert.equal(writes.get(target), 'old state');
      writes.set(file, writes.get(temporary));
      renamed = true;
    }
  };
  const now = () => new Date('2026-11-25T00:00:00Z');
  assert.equal(await recordPipe(event, { env, platform: 'win32', io, now }), true);
  assert.equal(renamed, true);
  assert.deepEqual(JSON.parse(writes.get(target)), { endpoint, callerThreadId: id, updatedAt: '2026-11-25T00:00:00.000Z' });
});

test('Hook 入口对无管道、非法身份及无效 JSON 静默退出', () => {
  const script = fileURLToPath(new URL('../src/hooks/codex-pipe-hook.mjs', import.meta.url));
  for (const [payload, discovery] of [[JSON.stringify(event), ''], [JSON.stringify({ ...event, session_id: 'invalid' }), endpoint], ['{', endpoint]]) {
    const child = spawnSync(process.execPath, [script], {
      input: payload, encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, ...env, CODEX_APP_TOOLS_PIPE_PATH: discovery }
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
  }
});
