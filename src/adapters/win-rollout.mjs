import path from 'node:path';
import * as fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { redact } from '../shared/conversation.mjs';
import { uuidPattern, workspaceKey } from '../shared/state.mjs';

const maxLine = 8 * 1024 * 1024;

function record(scan, line, sessionId) {
  let event;
  try { event = JSON.parse(line); } catch { return false; }
  if (!event || typeof event !== 'object') return true;
  const value = event?.payload;
  if (!scan.workspace) {
    if (event.type === 'session_meta' && typeof value?.id === 'string' && value.id.toLowerCase() === sessionId.toLowerCase()) {
      scan.workspace = workspaceKey('win-codex', value.cwd);
    }
    scan.invalid = !scan.workspace;
    return true;
  }
  if (event.type === 'event_msg' && value?.type === 'task_started') scan.activeTurn = value.turn_id;
  if (event.type === 'response_item' && value?.type === 'message' && value.role === 'assistant' && value.phase === 'final_answer') {
    const id = value.internal_chat_message_metadata_passthrough?.turn_id || scan.activeTurn;
    if (id && Array.isArray(value.content)) {
      rememberFinal(scan, id, value.content.filter(c => c?.type === 'output_text' && typeof c.text === 'string').map(c => c.text).join('\n'));
    }
  }
  if (event.type === 'event_msg' && value?.type === 'task_complete' && value.turn_id) {
    scan.completed.add(value.turn_id);
    if (typeof value.last_agent_message === 'string') rememberFinal(scan, value.turn_id, value.last_agent_message);
  }
  return true;
}

function rememberFinal(scan, id, text) {
  if (!text.trim()) return;
  const safe = redact(text);
  scan.finals.set(id, { text: safe.slice(0, 24_000), truncated: safe.length > 24_000 });
}

function acceptChunk(scan, chunk, sessionId) {
  const text = scan.fragment + scan.decoder.write(chunk);
  let start = 0;
  for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
    if (!scan.skipLine && end - start <= maxLine) record(scan, text.slice(start, end), sessionId);
    if (scan.invalid) return;
    scan.skipLine = false;
    start = end + 1;
  }
  scan.fragment = text.slice(start);
  if (scan.fragment.length > maxLine) {
    scan.fragment = '';
    scan.skipLine = true;
  }
}

async function sample(handle, start, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

export function createRolloutReader(sessionsRoot, io = fs) {
  const scans = new Map();
  let pending = Promise.resolve();

  async function scanFile(file, sessionId) {
    const handle = await io.open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || !info.size) return null;
      let scan = scans.get(file);
      if (scan && scan.dev === info.dev && scan.ino === info.ino && scan.size === info.size && scan.mtimeMs === info.mtimeMs) return scan;
      if (scan && (scan.dev !== info.dev || scan.ino !== info.ino || scan.size >= info.size
          || !scan.head.equals(await sample(handle, 0, scan.head.length))
          || !scan.tail.equals(await sample(handle, scan.size - scan.tail.length, scan.tail.length)))) scan = null;
      scan ??= {
        dev: info.dev, ino: info.ino, size: 0, fragment: '', decoder: new StringDecoder('utf8'),
        finals: new Map(), completed: new Set(), head: await sample(handle, 0, Math.min(info.size, 512))
      };
      // Keep unfinished JSON and partial UTF-8 characters across appends.
      if (!scan.invalid) {
        const stream = handle.createReadStream({ autoClose: false, start: scan.size, end: info.size - 1, highWaterMark: 64 * 1024 });
        for await (const chunk of stream) {
          acceptChunk(scan, chunk, sessionId);
          if (scan.invalid) break;
        }
        if (!scan.invalid && !scan.skipLine && scan.fragment && record(scan, scan.fragment, sessionId)) {
          scan.fragment = '';
        }
      }
      scan.size = info.size;
      scan.mtimeMs = info.mtimeMs;
      scan.tail = await sample(handle, Math.max(0, info.size - 512), Math.min(info.size, 512));
      scans.delete(file);
      scans.set(file, scan);
      if (scans.size > 6) scans.delete(scans.keys().next().value);
      return scan;
    } catch (error) {
      scans.delete(file);
      throw error;
    } finally {
      await handle.close();
    }
  }

  async function findFinal(sessionId, workspacePath, turnId) {
    const workspace = workspaceKey('win-codex', workspacePath);
    if (!uuidPattern.test(sessionId) || !workspace || !uuidPattern.test(turnId)) return null;
    const root = await io.realpath(sessionsRoot).catch(() => null);
    if (!root) return null;
    let match = null;
    let conflicting = false;
    async function visit(directory, depth) {
      for (const item of await io.readdir(directory, { withFileTypes: true })) {
        if (item.isDirectory() && depth < 3 && /^\d{2,4}$/.test(item.name)) {
          await visit(path.join(directory, item.name), depth + 1);
        }
        const name = item.name.toLowerCase();
        if (!item.isFile() || !name.startsWith('rollout-') || !name.endsWith('-' + sessionId.toLowerCase() + '.jsonl')) continue;
        const file = await io.realpath(path.join(directory, item.name));
        const relative = path.relative(root, file);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
        const scan = await scanFile(file, sessionId);
        const final = scan?.workspace === workspace && scan.completed.has(turnId) && scan.finals.get(turnId);
        if (!final) continue;
        if (match && match.text !== final.text) conflicting = true;
        match = final;
      }
    }
    await visit(root, 0);
    return conflicting ? null : match;
  }

  return (sessionId, workspacePath, turnId) => {
    // Multiple reads in one MCP process share offsets and UTF-8 fragments.
    const result = pending.then(() => findFinal(sessionId, workspacePath, turnId));
    pending = result.catch(() => {});
    return result;
  };
}
