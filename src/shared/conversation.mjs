import { BridgeError } from './errors.mjs';

const privateContext = /# AGENTS\.md instructions|<(?:environment_context|permissions instructions|system|developer)(?:\s|>)/i;

export function redact(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[已遮盖]')
    .replace(/(^[ \t]*(?:cookie|set-cookie|authorization|proxy-authorization)[ \t]*:)[^\r\n]*/gim, '$1 [已遮盖]')
    .replace(/\b((?:Bearer|Basic)\s+)[a-z0-9._~+\/=-]+/gi, '$1[已遮盖]')
    .replace(/(\b[a-z][a-z+.-]*:\/\/[^/\s:@]+:)[^/\s@]+@/gi, '$1[已遮盖]@')
    .replace(/(["']?\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|token|authorization|password|passwd|secret|cookie|client[_ -]?secret)\b["']?[ \t]*[:=][ \t]*)(?:\[已遮盖\]|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}\]]+)/gim, '$1[已遮盖]')
    .replace(/\b(?:sk-(?:proj-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/gi, '[已遮盖]');
}

export function publicMessage({ turnId, item }) {
  const user = item?.type === 'userMessage';
  const assistant = item?.type === 'agentMessage' && ['commentary', 'final_answer'].includes(item.phase);
  if (!user && !assistant) return null;
  const text = user && Array.isArray(item.content)
    ? item.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
    : assistant ? item.text : null;
  if (typeof text !== 'string' || !text.trim() || privateContext.test(text)) return null;
  const operationId = user && (typeof item.clientId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item.clientId)
    ? item.clientId : /^\[AGY_BRIDGE_OP:([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\](?:\r?\n|$)/.exec(text)?.[1]);
  return {
    id: typeof item.id === 'string' ? item.id : null,
    turnId: typeof turnId === 'string' ? turnId : null,
    role: user ? 'user' : 'assistant',
    ...(assistant && { phase: item.phase }),
    ...(operationId && { operationId }),
    text: redact(text),
    truncated: item.truncated === true || item.content?.some?.(part => part?.truncated === true) === true
  };
}

export function formatConversation({ target, sessionId, workspacePath, messages, nextCursor, pageTruncated }, maxChars) {
  let remaining = Math.min(maxChars, 24_000);
  const selected = [];
  for (const message of messages) {
    if (remaining === 0) {
      pageTruncated = true;
      break;
    }
    let text = message.text.slice(0, remaining);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    const truncated = message.truncated || text.length < message.text.length;
    remaining -= text.length;
    pageTruncated ||= truncated;
    if (text) selected.push({ ...message, text, truncated });
    if (truncated && text.length < message.text.length) break;
  }
  return {
    target, sessionId, workspacePath, sampledAt: new Date().toISOString(),
    messages: selected.reverse(), pageTruncated: Boolean(pageTruncated), nextCursor: nextCursor ?? null
  };
}

function invalidCursor() {
  return new BridgeError('INVALID_CURSOR', '游标与当前会话或历史页不符，请从最新一页重新读取。');
}

// Native APIs page different units. Keep unread public messages in the same
// native page when it exceeds the public message limit.
export async function readPublicPage(identity, { limit = 3, cursor, maxChars = 12_000 } = {}, fetchPage) {
  let position = { native: null, offset: 0, kind: null, anchor: null };
  if (cursor !== undefined) {
    try {
      if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (decoded.target !== identity.target || decoded.sessionId !== identity.sessionId
          || !['win-turns', 'remote-desktop-turns', 'remote-items', 'remote-summary'].includes(decoded.kind)
          || (decoded.native !== null && (typeof decoded.native !== 'string' || !decoded.native.length))
          || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0
          || (decoded.offset > 0 && typeof decoded.anchor !== 'string')) throw invalidCursor();
      position = decoded;
    } catch {
      throw invalidCursor();
    }
  }
  const messages = [];
  let pageTruncated = false;
  let cursorAvailable = false;
  const seen = new Set();
  for (let scan = 0; scan < 20; scan++) {
    const page = await fetchPage(position, limit);
    if (position.kind && page.kind !== position.kind) throw invalidCursor();
    const visible = page.entries.map(publicMessage).filter(Boolean);
    if (position.offset && (position.anchor !== page.anchor || position.offset >= visible.length)) throw invalidCursor();
    pageTruncated ||= page.truncated === true;
    const end = Math.min(visible.length, position.offset + limit - messages.length);
    messages.push(...visible.slice(position.offset, end));
    if (end < visible.length) {
      position = { ...position, offset: end, anchor: page.anchor, kind: page.kind };
      cursorAvailable = true;
      break;
    }
    if (!page.nextCursor || page.nextCursor === position.native || seen.has(page.nextCursor)) {
      pageTruncated ||= Boolean(page.nextCursor);
      cursorAvailable = false;
      break;
    }
    seen.add(page.nextCursor);
    position = { native: page.nextCursor, offset: 0, anchor: null, kind: page.kind };
    cursorAvailable = true;
    if (messages.length === limit) break;
    if (scan === 19) pageTruncated = true;
  }
  const nextCursor = cursorAvailable ? Buffer.from(JSON.stringify({
    ...position, target: identity.target, sessionId: identity.sessionId
  })).toString('base64url') : null;
  return formatConversation({ ...identity, messages, nextCursor, pageTruncated }, maxChars);
}
