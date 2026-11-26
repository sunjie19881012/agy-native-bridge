import { redact } from './conversation.mjs';

export const validHostId = value => typeof value === 'string' && /^(?!-)[0-9a-zA-Z_-]{1,128}$/.test(value);

export function cleanPairText(value, limit) {
  if (typeof value !== 'string') return null;
  const text = redact(redact(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ')).replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, limit).join('') || null;
}

export function pairConversation(preference, conversationId, now) {
  const { pairManualUnbound, ...current } = preference;
  return {
    ...current,
    ...(conversationId === null && { pairManualUnbound: true }),
    pairedConversationId: conversationId,
    pairedConversationTitle: conversationId === preference.pairedConversationId
      ? cleanPairText(preference.pairedConversationTitle, 80) : null,
    pairedAt: conversationId ? new Date(now).toISOString() : null
  };
}
