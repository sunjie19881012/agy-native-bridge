import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDirectory } from './config.mjs';

export const bridgeTargets = ['101-codex', 'win-codex'];
export const quotaPeriodMs = 300_000;

export async function readLocalJson(name, { directory = stateDirectory(), signal, io = { readFile } } = {}) {
  try { return JSON.parse(await io.readFile(path.join(directory, name), { encoding: 'utf8', signal })); }
  catch { return null; }
}

export function sampleAge(sampledAt, now) {
  const at = Date.parse(sampledAt);
  return Number.isFinite(at) && at <= now ? now - at : null;
}

export function cacheMaxAge(intervalMs) {
  return Math.min(Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs * 2 : 600_000, 600_000);
}

export function cachedCatalog(state, target, now) {
  const entry = state?.targets?.[target];
  if (entry?.catalog === null) return null;
  const catalog = entry?.catalog ?? entry;
  const age = sampleAge(catalog?.sampledAt ?? state?.sampledAt, now);
  if (age === null || !Array.isArray(catalog?.sessions) || typeof catalog.reachable !== 'boolean') return null;
  const lastFailureIsNewer = entry.reachable === false && Date.parse(entry.sampledAt) > Date.parse(catalog.sampledAt);
  const error = lastFailureIsNewer ? entry.error : catalog.error;
  return {
    age, stale: age >= cacheMaxAge(state.intervalMs),
    value: { reachable: catalog.reachable && !lastFailureIsNewer, sessions: catalog.sessions, ...(error && { error }) }
  };
}

export async function postSidecar(route, value, { directory, fetch = globalThis.fetch, read = readLocalJson } = {}) {
  try {
    const runtime = await read('sidecar-runtime.json', { directory });
    if (!Number.isInteger(runtime?.port) || runtime.port < 1 || runtime.port > 65_535
        || typeof runtime.nudgeToken !== 'string' || !/^[a-f0-9]{64}$/.test(runtime.nudgeToken)) return false;
    const reply = await fetch('http://127.0.0.1:' + runtime.port + route, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1000),
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': runtime.nudgeToken },
      body: JSON.stringify(value)
    });
    return reply.ok === true;
  } catch { return false; }
}
