import { bridgeTargets, sampleAge } from '../shared/bridge-cache.mjs';
import { busy, heartbeatMs, intervalFor, recentUnreadMs } from './heartbeat.mjs';

export function initialSnapshot(value, targets = bridgeTargets) {
  return {
    sampledAt: value?.sampledAt ?? null,
    intervalMs: value?.intervalMs ?? heartbeatMs.idle,
    targets: Object.fromEntries(targets.map(target => {
      const row = value?.targets?.[target];
      return [target, row && Array.isArray(row.sessions) ? row : { reachable: false, sessions: [], failures: 0 }];
    }))
  };
}

function quotaSummary(value, sampledAt) {
  const bucket = value?.rateLimitsByLimitId?.codex ?? value?.rateLimits;
  if (!bucket) return null;
  const windows = {};
  for (const row of [bucket.primary, bucket.secondary]) {
    if (!Number.isFinite(row?.usedPercent)) continue;
    const name = { 300: '5h', 10080: '7d' }[row.windowDurationMins];
    if (name) windows[name] = {
      remainingPercent: Math.max(0, Math.min(100, 100 - row.usedPercent)),
      resetsAt: Number.isFinite(row.resetsAt) ? row.resetsAt : null
    };
  }
  return Object.keys(windows).length ? { sampledAt, windows } : null;
}

export function watchIds(row, fixed, { target, preferences = {} } = {}) {
  const prefix = target + ':';
  const watched = Object.entries(preferences)
    .filter(([key, value]) => key.startsWith(prefix) && key.length > prefix.length
      && value?.hidden !== true && (value?.starred === true || value?.autoRead === true))
    .map(([key]) => key.slice(prefix.length));
  return [...new Set([
    ...Object.keys(fixed ?? {}),
    ...row.sessions.filter(session => session.tracking || busy(session.state)).map(session => session.sessionId),
    ...watched
  ])];
}

function mergeSession(prior, current, now, transitions) {
  const latest = current.latestTurn;
  const tracking = prior?.tracking;
  const isBusy = busy(current.state);
  const matchedTracking = latest && tracking && (tracking.turnId
    ? latest.id === tracking.turnId
    : latest.id !== tracking.beforeTurnId || tracking.observedTurnId === latest.id);
  const priorTurn = prior?.latestTurn?.id ?? prior?.activeTurnId;
  const priorTurnMatches = busy(prior?.state) && (!priorTurn || priorTurn === latest?.id);
  const finished = !isBusy && latest && ['completed', 'failed', 'interrupted'].includes(latest.status)
    && (matchedTracking || priorTurnMatches);
  const outcome = finished ? latest.status : isBusy ? null : prior?.outcome ?? null;
  let unread = prior?.unread ?? null;
  const event = current.state === 'waiting_approval' && prior?.state !== 'waiting_approval'
    ? 'waiting_approval' : finished ? outcome : null;
  if (event) {
    const turnId = latest?.id ?? (event === 'waiting_approval' ? current.activeTurnId : null);
    unread = { kind: event, at: now, turnId };
    transitions.push({ target: current.target, sessionId: current.sessionId, kind: event,
      turnId, workspacePath: current.workspacePath, title: current.title });
  } else if (isBusy) unread = null;
  return {
    ...current, outcome, unread, outcomeAt: finished ? now : isBusy ? null : prior?.outcomeAt ?? null,
    tracking: tracking && !finished
      ? { ...tracking, observedTurnId: isBusy && latest && (tracking.mode === 'steer' || latest.id !== tracking.beforeTurnId)
        ? latest.id : tracking.observedTurnId }
      : null
  };
}

export function applySamples(state, results, now) {
  const sampledAt = new Date(now).toISOString();
  const targets = { ...state.targets };
  const transitions = [];
  for (const [target, sample] of results) {
    const before = targets[target];
    if (sample.error) {
      const failures = (before.failures ?? 0) + 1;
      targets[target] = {
        ...before, reachable: false, error: sample.error, sampledAt, failures,
        retryAt: failures >= 2 ? now + heartbeatMs.offline : null
      };
      continue;
    }
    const old = new Map(before.sessions.map(session => [session.sessionId, session]));
    const sessions = sample.sessions.map(session => {
      const prior = old.get(session.sessionId);
      old.delete(session.sessionId);
      return mergeSession(prior, session, now, transitions);
    });
    for (const session of old.values()) {
      const retained = session.tracking || busy(session.state) || session.unread
        || (session.outcomeAt && now - session.outcomeAt <= recentUnreadMs);
      if (retained) sessions.push(busy(session.state) && !session.tracking
        ? { ...session, state: 'unknown', activeTurnId: null } : session);
    }
    targets[target] = {
      reachable: true, failures: 0, retryAt: null, sampledAt, sessions,
      catalog: sample.catalogAvailable === false ? before.catalog ?? null
        : { reachable: true, sampledAt, sessions: sample.catalog },
      quotaCheckedAt: sample.quotaChecked ? now : before.quotaCheckedAt,
      rateLimits: quotaSummary(sample.quota, sampledAt) ?? before.rateLimits ?? null
    };
  }
  return {
    state: { sampledAt, intervalMs: intervalFor(targets), targets },
    transitions
  };
}

export function recordDispatch(state, notice, now) {
  if (notice.action !== 'send' && !(notice.action === 'create' && notice.tracking === true)) return state;
  const row = state.targets[notice.target];
  const previous = row.sessions.find(session => session.sessionId === notice.sessionId);
  const session = {
    target: notice.target, sessionId: notice.sessionId, title: '', state: 'unknown',
    workspacePath: notice.workspacePath, activeTurnId: null, activeFlags: [], updatedAt: null,
    ...previous,
    unread: null,
    tracking: { turnId: notice.turnId ?? null, beforeTurnId: notice.beforeTurnId ?? null, mode: notice.mode, acceptedAt: now }
  };
  return {
    ...state, targets: { ...state.targets, [notice.target]: {
      ...row, sessions: [...row.sessions.filter(item => item.sessionId !== notice.sessionId), session]
    } }
  };
}

export function latestQuota(state, target, now) {
  const value = state?.targets?.[target]?.rateLimits;
  const age = sampleAge(value?.sampledAt, now);
  return age !== null && age <= heartbeatMs.offline ? value : null;
}
