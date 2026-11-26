import assert from 'node:assert/strict';
import test from 'node:test';
import { formatConversation, publicMessage, readPublicPage, redact } from '../src/shared/conversation.mjs';

const user = text => ({ type: 'userMessage', id: 'user-message', content: [{ type: 'text', text }, { type: 'image', url: 'private URL' }] });
const assistant = (text, phase) => ({ type: 'agentMessage', text, phase });
const entry = item => ({ turnId: 'turn', item });

test('公开内容仅包含用户文本、commentary 和 final_answer', () => {
  const messages = [
    user('需求'), assistant('处理中', 'commentary'), assistant('完成', 'final_answer'),
    assistant('系统推理', 'analysis'), assistant('未标记阶段'), { type: 'commandExecution', text: 'tool output' },
    { type: 'reasoning', text: 'reasoning' }, user('<environment_context>secret details'), user('# AGENTS.md instructions')
  ].map(item => publicMessage(entry(item))).filter(Boolean);
  assert.deepEqual(messages.map(x => x.text), ['需求', '处理中', '完成']);
  assert.deepEqual(messages.map(x => x.role), ['user', 'assistant', 'assistant']);
  assert.equal(publicMessage(entry({ ...user('请求'), clientId: 'synthetic:op' })).operationId, 'synthetic:op');
  assert.equal(publicMessage(entry(user('[AGY_BRIDGE_OP:windows-op]\n请求'))).operationId, 'windows-op');
});

test('遮盖常见凭据，包括引号内空格、Bearer、Cookie 和私钥', () => {
  const source = [
    'Authorization: Bearer bare.header.token',
    '"api_key": "SYNTH VALUE", password = \'SYNTH PASSWORD\'',
    'git+https://mock-user:mock-credential@example.invalid/repo',
    'Cookie: session=mock-cookie-value; refresh_token: mock-refresh',
    '-----BEGIN PRIVATE KEY-----\ninternal-mock-private-key\n-----END PRIVATE KEY-----',
    'keep this public sentence'
  ].join('\n');
  const output = redact(source);
  assert.doesNotMatch(output, /bare\.header|SYNTH VALUE|SYNTH PASSWORD|mock-credential|mock-cookie-value|mock-refresh|internal-mock/);
  assert.match(output, /\[已遮盖\]/);
  assert.match(output, /keep this public sentence/);
});

test('字符预算优先保留最近消息，使用硬上限且保留游标', () => {
  const messages = [publicMessage(entry(assistant('最新😀结尾', 'final_answer'))), publicMessage(entry(user('旧的问题')))];
  const output = formatConversation({ messages, nextCursor: 'older-page' }, 4);
  assert.deepEqual(output.messages.map(x => x.text), ['最新😀']);
  assert.equal(output.nextCursor, 'older-page');
  assert.equal(output.pageTruncated, true);
  const large = formatConversation({ messages: [publicMessage(entry(user('x'.repeat(25_000))))] }, 50_000);
  assert.equal(large.messages[0].text.length, 24_000);
  assert.equal(large.messages[0].truncated, true);
  assert.equal(formatConversation({ messages: [messages[0]] }, 3).messages[0].text, '最新');
});

test('拆分同一轮公开消息时不漏读，游标绑定目标和历史锚点', async () => {
  const identity = { target: 'win-codex', sessionId: 't', workspacePath: 'C:\\Work' };
  const fetchPage = async () => ({
    kind: 'win-turns', anchor: 'turn', entries: [assistant('结论', 'final_answer'), assistant('进展', 'commentary'), user('问题')].map(entry)
  });
  const first = await readPublicPage(identity, { limit: 1 }, fetchPage);
  assert.deepEqual(first.messages.map(x => x.text), ['结论']);
  assert.ok(first.nextCursor);
  const rest = await readPublicPage(identity, { limit: 2, cursor: first.nextCursor }, fetchPage);
  assert.deepEqual(rest.messages.map(x => x.text), ['问题', '进展']);
  assert.equal(rest.nextCursor, null);
  await assert.rejects(readPublicPage({ ...identity, sessionId: 'another' }, { cursor: first.nextCursor }, fetchPage), { code: 'INVALID_CURSOR' });
  await assert.rejects(readPublicPage(identity, { cursor: first.nextCursor }, async () => ({ ...await fetchPage(), anchor: 'new-turn' })), { code: 'INVALID_CURSOR' });
});
