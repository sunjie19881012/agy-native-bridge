import path from 'node:path';
import { BridgeError, notSent } from './errors.mjs';
import { windowsTarget } from './targets.mjs';

export const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const pipePattern = /^\\\\\.\\pipe\\codex-app-tools-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function normalizeState(status, latest, approvalPending = false) {
  const type = typeof status === 'string' ? status : status?.type;
  const flags = Array.isArray(status?.activeFlags) ? status.activeFlags.filter(f => typeof f === 'string') : [];
  if (type === 'offline') return { state: 'offline', activeFlags: flags };
  if (approvalPending || flags.some(flag => /approval|input/i.test(flag)) || type === 'waiting_approval') {
    return { state: 'waiting_approval', activeFlags: flags };
  }
  if (flags.length || type === 'paused') return { state: 'paused', activeFlags: flags };
  if (['active', 'running'].includes(type)) return { state: 'active', activeFlags: flags };
  if (type === 'idle') return { state: 'idle', activeFlags: flags };
  if (latest?.status === 'interrupted') return { state: 'paused', activeFlags: flags };
  if (type === 'notLoaded' && latest?.status === 'completed') return { state: 'idle', activeFlags: flags };
  return { state: 'unknown', activeFlags: flags };
}

export function workspaceKey(target, cwd) {
  if (typeof cwd !== 'string' || /[\x00-\x1f]/.test(cwd)) return null;
  if (windowsTarget(target)) {
    if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(cwd)) return null;
    return path.win32.normalize(cwd).replace(/[\\/]+$/, '').toLowerCase();
  }
  return path.posix.isAbsolute(cwd) ? path.posix.normalize(cwd).replace(/(.+)\/$/, '$1') : null;
}

export function checkIdentity(target, thread, sessionId, ...expectedWorkspaces) {
  const workspace = workspaceKey(target, thread?.cwd);
  if (thread?.id !== sessionId || !workspace
      || expectedWorkspaces.some(expected => expected !== undefined && workspace !== workspaceKey(target, expected))) {
    throw new BridgeError('SESSION_IDENTITY_MISMATCH', '原生会话标识或工作区与目标不符。');
  }
}

function time(value) {
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value ?? NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function sessionView(target, thread, latest, approvalPending = false) {
  const { state, activeFlags } = normalizeState(thread.status, latest, approvalPending);
  const busy = ['active', 'waiting_approval', 'paused'].includes(state);
  return {
    target,
    sessionId: thread.id,
    title: [thread.name, thread.title].find(title => typeof title === 'string' && title)?.slice(0, 160) ?? '',
    workspacePath: thread.cwd ?? null,
    state,
    activeTurnId: busy ? (latest?.status === 'inProgress' ? latest.id : thread.activeTurnId) ?? null : null,
    activeFlags,
    updatedAt: time(thread.updatedAt)
  };
}

export function withLatest(session, latest) {
  return { ...session, latestTurn: latest ? { id: latest.id, status: latest.status } : null };
}

export function sendBlocked(session, mode) {
  if (mode === 'queue' && session.state === 'active') return notSent('queue_waiting_for_idle');
  if (!['idle', 'active'].includes(session.state)) return notSent('state_changed_before_send');
  return null;
}
