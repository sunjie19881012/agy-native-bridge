import { pathToFileURL } from 'node:url';
import { bridgeTargets, cacheMaxAge, readLocalJson, sampleAge } from '../shared/bridge-cache.mjs';
import { cleanPairText, validHostId } from '../shared/pairing.mjs';
import { toolTargets } from '../shared/targets.mjs';
import { recentUnreadMs } from '../sidecar/heartbeat.mjs';

export function sessionStartSummary(snapshot, now = Date.now(), { prefs, conversationId } = {}) {
  const paired = pairedSummary(snapshot, prefs, conversationId);
  if (paired) return injection(paired);
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
  return injection('Codex ' + parts.join('。') + '。');
}

function injection(message) {
  return { injectSteps: [{ systemMessage: { systemMessage: message } }] };
}

function pairedSummary(snapshot, prefs, conversationId) {
  if (!validHostId(conversationId)) return null;
  const sessions = [];
  for (const [key, pref] of Object.entries(prefs?.sessions ?? {})) {
    if (pref?.pairedConversationId !== conversationId || pref.hidden === true) continue;
    const separator = key.indexOf(':');
    const target = key.slice(0, separator);
    const sessionId = key.slice(separator + 1);
    if (!toolTargets.includes(target) || !/^[a-z0-9_.:-]{1,200}$/i.test(sessionId)) continue;
    const group = snapshot?.targets?.[target];
    const match = row => row.sessionId === sessionId;
    const find = rows => Array.isArray(rows) ? rows.find(match) : undefined;
    const row = find(group?.sessions) ?? find(group?.catalog?.sessions);
    const label = cleanPairText(pref.pairLabel ?? pref.pairedConversationTitle ?? row?.title, 12)?.replace(/[「」]/g, '');
    sessions.push({ target, sessionId, label, pairedAt: Date.parse(pref.pairedAt) || 0 });
  }
  sessions.sort((a, b) => b.pairedAt - a.pairedAt);
  if (!sessions.length) return null;
  const { target, sessionId, label } = sessions[0];
  const reference = sessionId.length <= 56 ? sessionId : sessionId.slice(0, 55) + '…';
  return '配对 ' + target + ' ' + reference + (label ? '「' + label + '」' : '')
    + '。默认由协作窗口改动、自测；仅用户明确要求时本端才改代码。';
}

export function hookConversationId(input, env = process.env) {
  let value;
  try { value = JSON.parse(input); } catch { /* fall back to the host environment */ }
  return [value?.conversationId, value?.conversation_id, value?.context?.conversationId, env.ANTIGRAVITY_CONVERSATION_ID]
    .find(validHostId);
}

function readHookInput(stream) {
  if (stream.isTTY || stream.readableEnded) return '';
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(''), 500);
    function finish(input) {
      clearTimeout(timer);
      stream.off('data', data);
      stream.off('end', end);
      stream.off('error', error);
      stream.pause();
      resolve(input);
    }
    const end = () => finish(Buffer.concat(chunks).toString('utf8'));
    const error = () => finish('');
    function data(chunk) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 32_768) finish('');
      else chunks.push(bytes);
    }
    stream.on('data', data).once('end', end).once('error', error);
  });
}

export async function runSessionStart() {
  const signal = AbortSignal.timeout(1200);
  const [state, prefs, input] = await Promise.all([
    readLocalJson('state.json', { signal }), readLocalJson('prefs.json', { signal }), readHookInput(process.stdin)
  ]);
  const conversationId = hookConversationId(input);
  process.stdout.write(JSON.stringify(sessionStartSummary(state, Date.now(), { prefs, conversationId })) + '\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runSessionStart();
