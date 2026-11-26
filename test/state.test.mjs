import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIdentity, normalizeState, sessionView, withLatest } from '../src/shared/state.mjs';

test('状态归一化使用原生状态、审批通知及历史轮次', () => {
  const cases = [
    [{ type: 'active' }, null, false, 'active'],
    [{ type: 'idle' }, { status: 'interrupted' }, false, 'idle'],
    [{ type: 'active', activeFlags: ['waitingOnApproval'] }, null, false, 'waiting_approval'],
    [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, null, false, 'waiting_approval'],
    [{ type: 'active' }, null, true, 'waiting_approval'],
    [{ type: 'active', activeFlags: ['someOtherFlag'] }, null, false, 'paused'],
    [{ type: 'paused' }, null, false, 'paused'],
    [{ type: 'notLoaded' }, { status: 'interrupted' }, false, 'paused'],
    [{ type: 'notLoaded' }, { status: 'completed' }, false, 'idle'],
    [{ type: 'notLoaded' }, null, false, 'unknown'],
    [{ type: 'unrecognized' }, null, false, 'unknown'],
    [{ type: 'offline' }, null, false, 'offline']
  ];
  for (const [status, latest, approval, expected] of cases) {
    assert.equal(normalizeState(status, latest, approval).state, expected);
  }
});

test('状态保留轮次 ID 与安全的工作区身份比较', () => {
  const thread = { id: 'test', cwd: 'C:\\Work\\A', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, updatedAt: 1728000000 };
  const latest = { id: 'turn-a', status: 'inProgress', items: [{ text: 'private' }] };
  const view = withLatest(sessionView('win-codex', thread, latest), latest);
  assert.equal(view.state, 'waiting_approval');
  assert.equal(view.activeTurnId, 'turn-a');
  assert.deepEqual(view.latestTurn, { id: 'turn-a', status: 'inProgress' });
  assert.deepEqual(view.activeFlags, ['waitingOnApproval']);
  assert.equal(view.updatedAt, new Date(1728000000 * 1000).toISOString());
  checkIdentity('win-codex', thread, 'test', 'c:/work/a/');
  assert.throws(() => checkIdentity('win-codex', thread, 'other'), { code: 'SESSION_IDENTITY_MISMATCH' });
  assert.throws(() => checkIdentity('win-codex', thread, 'test', 'C:\\Work\\B'), { code: 'SESSION_IDENTITY_MISMATCH' });
  assert.throws(() => checkIdentity('101-codex', { id: 'test', cwd: '/Work/A' }, 'test', '/work/a'), { code: 'SESSION_IDENTITY_MISMATCH' });
});
