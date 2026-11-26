export const heartbeatMs = {
  startup: 2_000, active: 30_000, idle: 300_000, offline: 600_000, focus: 15_000
};
const followUps = [5_000, 15_000];
export const recentUnreadMs = 15 * 60_000;

export function busy(state) {
  return state === 'active' || state === 'waiting_approval';
}

export function intervalFor(targets) {
  const rows = Object.values(targets);
  if (rows.some(row => row.reachable && row.sessions.some(session => busy(session.state)))) return heartbeatMs.active;
  return rows.length && rows.every(row => row.failures >= 2) ? heartbeatMs.offline : heartbeatMs.idle;
}

export function createHeartbeat({ probe, clock = Date.now, timers = globalThis, paused = false }) {
  let stopped = false;
  let intervalMs = heartbeatMs.idle;
  let scheduled;
  let inFlight;
  let lastFocus = -Infinity;
  const supplement = new Set();

  function cancel() {
    timers.clearTimeout(scheduled);
    for (const timer of supplement) timers.clearTimeout(timer);
    supplement.clear();
  }

  function schedule(delay, reason) {
    timers.clearTimeout(scheduled);
    if (!paused && !stopped) scheduled = timers.setTimeout(() => { void refresh(reason); }, delay);
  }

  function refresh(reason = 'manual', target) {
    if (stopped || (paused && reason !== 'manual')) return Promise.resolve({ skipped: true });
    if (reason === 'focus') {
      const now = clock();
      if (now - lastFocus < heartbeatMs.focus) return Promise.resolve({ skipped: true });
      lastFocus = now;
    }
    if (inFlight) return inFlight;
    timers.clearTimeout(scheduled);
    inFlight = Promise.resolve().then(() => probe({ reason, target })).then(next => {
      if (next?.intervalMs) intervalMs = next.intervalMs;
      return { skipped: false };
    }, () => ({ skipped: false, error: true })).finally(() => {
      inFlight = undefined;
      schedule(intervalMs, 'periodic');
    });
    return inFlight;
  }

  return {
    start: () => schedule(heartbeatMs.startup, 'startup'),
    refresh,
    nudge(target) {
      if (paused || stopped) return;
      void refresh('action', target);
      for (const timer of supplement) timers.clearTimeout(timer);
      supplement.clear();
      for (const delay of followUps) {
        const timer = timers.setTimeout(() => { supplement.delete(timer); void refresh('action', target); }, delay);
        supplement.add(timer);
      }
    },
    setPaused(value) {
      if (paused === value) return;
      paused = value;
      if (paused) cancel();
      else schedule(0, 'periodic');
    },
    async stop() {
      stopped = true;
      cancel();
      await inFlight;
    }
  };
}
