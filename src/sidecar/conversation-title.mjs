import { cleanPairText, validHostId } from '../shared/pairing.mjs';

export async function readConversationTitle(conversationId, { env = process.env, fetch = globalThis.fetch } = {}) {
  const { ANTIGRAVITY_LS_ADDRESS: address, ANTIGRAVITY_CSRF_TOKEN: csrf } = env;
  if (!address || !csrf || !validHostId(conversationId)) return null;
  try {
    const base = new URL('http://' + address);
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
        || base.username || base.password || base.pathname !== '/' || base.hash || base.search) return null;
    const response = await fetch(new URL('/product.v1.ConversationService/GetConversation', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-antigravity-csrf-token': csrf },
      body: JSON.stringify({ conversationId })
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const conversation = payload?.conversation ?? payload;
    const clean = value => cleanPairText(typeof value === 'string' ? value.replaceAll(csrf, '[已遮盖]') : value, 80);
    return clean(conversation?.annotations?.title) ?? clean(conversation?.state?.summary);
  } catch { return null; }
}
