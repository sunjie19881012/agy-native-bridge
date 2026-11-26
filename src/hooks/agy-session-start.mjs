import { pathToFileURL } from 'node:url';
import { bridgeTargets, cacheMaxAge, readLocalJson, sampleAge } from '../shared/bridge-cache.mjs';
import { recentUnreadMs } from '../sidecar/heartbeat.mjs';

export function sessionStartSummary(snapshot, now = Date.now()) {
  const parts = [];
  for (const target of bridgeTargets) {
    const row = snapshot?.targets?.[target];
    const age = sampleAge(row?.sampledAt ?? snapshot?.sampledAt, now);
    if (!row?.reachable || !Array.isArray(row.sessions) || age === null || age >= cacheMaxAge(snapshot.intervalMs)) continue;
    const active = row.sessions.filter(session => session.state === 'active').length;
    const approval = row.sessions.filter(session => session.state === 'waiting_approval').length;
    const unread = row.sessions.filter(({ unread }) => ['completed', 'failed'].includes(unread?.kind)
      && Number.isFinite(unread.at) && now >= unread.at && now - unread.at <= recentUnreadMs).length;
    const count = n => n > 99 ? '99+' : String(n);
    const details = [active && '运行 ' + count(active), approval && '待审批 ' + count(approval), unread && '完成未读 ' + count(unread)]
      .filter(Boolean).join('、');
    if (details) parts.push((target === '101-codex' ? '101' : 'Windows') + ' ' + details);
  }
  if (!parts.length) return {};
  return { injectSteps: [{ systemMessage: { systemMessage: 'Codex ' + parts.join('。') + '。' } }] };
}

export async function runSessionStart() {
  const state = await readLocalJson('state.json', { signal: AbortSignal.timeout(1200) });
  process.stdout.write(JSON.stringify(sessionStartSummary(state)) + '\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runSessionStart();
