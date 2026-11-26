import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapters } from '../adapters/targets.mjs';
import { bridgeTargets, quotaPeriodMs, readLocalJson } from '../shared/bridge-cache.mjs';
import { defaultMaxAutoReads, isAutoReadLimit, readConfig, stateDirectory, writeJsonAtomic } from '../shared/config.mjs';
import { errorDetails } from '../shared/errors.mjs';
import { dshTargets } from '../shared/targets.mjs';
import { cleanPairText, pairConversation, validHostId } from '../shared/pairing.mjs';
import { createAutoRead, enableAutoRead, findBinding, missingBinding, sendHostMessage } from './auto-read.mjs';
import { readConversationTitle } from './conversation-title.mjs';
import { createHeartbeat } from './heartbeat.mjs';
import { applySamples, initialSnapshot, latestQuota, recordDispatch, watchIds } from './snapshot.mjs';

const uiPath = new URL('./ui.html', import.meta.url);
const runtimeName = 'sidecar-runtime.json';
const activeConversationMs = 10 * 60_000;
const themeModes = new Set(['auto', 'dark', 'light']);
const isSession = value => typeof value === 'string' && value.trim() && value.length <= 200;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalidHostIds = body => ['conversationId', 'projectId'].some(key =>
  body[key] !== undefined && body[key] !== '' && !validHostId(body[key]));
const isLoopbackHostname = name => name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name.endsWith('.localhost');
function isLoopbackHost(host) {
  if (typeof host !== 'string' || !host || /[\s/@\\?#]/.test(host)) return false;
  try { return isLoopbackHostname(new URL('http://' + host).hostname); } catch { return false; }
}
function isLoopbackOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && isLoopbackHostname(parsed.hostname);
  } catch { return false; }
}
const tokenMatches = (given, expected) => typeof given === 'string' && given.length === expected.length
  && Buffer.byteLength(given) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

function notifyWindows(events) {
  if (process.platform !== 'win32') return;
  const action = {
    waiting_approval: '等待原窗口审批',
    completed: '已完成',
    failed: '执行失败',
    interrupted: '已中断'
  };
  const message = events.map(event => event.target + ' ' + action[event.kind]).slice(0, 4).join('\n');
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$notice=[System.Windows.Forms.NotifyIcon]::new()',
    'try { $notice.Icon=[System.Drawing.SystemIcons]::Information; $notice.Visible=$true',
    '$notice.ShowBalloonTip(4500, "Codex 会话", $env:AGY_BRIDGE_NOTIFICATION, "Info")',
    'Start-Sleep -Seconds 5 } finally { $notice.Dispose() }'
  ].join('; ');
  const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, AGY_BRIDGE_NOTIFICATION: message }
  });
  child.on('error', () => {});
  child.unref();
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function bodyJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return null;
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function asPrefs(value, now) {
  const migrated = [];
  const sessions = Object.fromEntries(Object.entries(object(value?.sessions) ? value.sessions : {}).map(([key, pref]) => {
    if (pref?.pairedConversationId === null && pref.pairManualUnbound !== true) {
      migrated.push([key, null]);
      return [key, pairConversation(pref, null, now)];
    }
    if (validHostId(pref?.autoReadConversationId) && pref.pairedConversationId === undefined && pref.pairManualUnbound !== true) {
      migrated.push([key, pref.autoReadConversationId]);
      return [key, pairConversation(pref, pref.autoReadConversationId, now)];
    }
    return [key, pref];
  }));
  return {
    prefs: { paused: value?.paused === true, notifications: value?.notifications === true,
      theme: themeModes.has(value?.theme) ? value.theme : 'auto', sessions },
    migrated
  };
}

function sessionPreference(body) {
  return Object.fromEntries(['starred', 'hidden'].filter(key => typeof body[key] === 'boolean').map(key => [key, body[key]]));
}

export async function startSidecar({
  config, adapters, directory = stateDirectory(), port = 0, uiToken = '', clock = Date.now,
  timers = globalThis, notify = notifyWindows, read = readLocalJson, write = writeJsonAtomic,
  env = process.env, sendMessage = (id, message, options) => sendHostMessage(id, message, { ...options, env }),
  lookupTitle = id => readConversationTitle(id, { env }),
  remove = unlink, listen = server => server.listen({ host: '127.0.0.1', port })
} = {}) {
  const load = name => read(name, { directory });
  const [previous, savedPrefs, ui] = await Promise.all([
    load('state.json'), load('prefs.json'), readFile(uiPath, 'utf8')
  ]);
  const targets = [...bridgeTargets, ...dshTargets.filter(target => adapters[target])];
  const isTarget = value => targets.includes(value);
  let state = initialSnapshot(previous, targets);
  const { prefs: normalizedPrefs, migrated } = asPrefs(savedPrefs, clock());
  let prefs = normalizedPrefs;
  let activeConversation;
  let writes = Promise.resolve();
  let closing = false;
  const titleLookups = new Map();
  const nudgeToken = randomBytes(32).toString('hex');
  const maxAutoReads = config.sidecar?.maxAutoReads ?? defaultMaxAutoReads;

  function save(name, value) {
    const pending = writes.catch(() => {}).then(() => write(path.join(directory, name), value));
    writes = pending;
    return pending;
  }

  const commit = next => { state = next; return save('state.json', next); };

  function markRead({ target, sessionId, turnId }, expectedUnread) {
    const row = state.targets[target];
    const session = row.sessions.find(item => item.sessionId === sessionId);
    const unread = session?.unread;
    if (!unread || unread.kind === 'waiting_approval' || (expectedUnread && unread !== expectedUnread)
        || (unread.turnId && turnId && unread.turnId !== turnId)) return;
    const sessions = row.sessions.map(item => item === session ? { ...item, unread: null } : item);
    return commit({ ...state, targets: { ...state.targets, [target]: { ...row, sessions } } });
  }

  const preference = key => prefs.sessions[key] ?? {};
  function updatePreference(key, change) {
    const previous = preference(key);
    const next = change(previous);
    if (next === previous) return Promise.resolve();
    prefs = { ...prefs, sessions: { ...prefs.sessions, [key]: next } };
    return save('prefs.json', prefs);
  }
  function applyGlobalPreferences(body) {
    const paused = typeof body.paused === 'boolean' ? body.paused : prefs.paused;
    if (paused !== prefs.paused) {
      heartbeat.setPaused(paused);
      prefs = { ...prefs, paused };
      if (!paused) autoRead.resume();
    }
    prefs = { ...prefs, theme: body.theme ?? prefs.theme,
      notifications: typeof body.notifications === 'boolean' ? body.notifications : prefs.notifications };
  }

  function nudgeConversation(body) {
    if (validHostId(body.conversationId)) return { conversationId: body.conversationId, projectId: body.projectId };
    const age = activeConversation ? clock() - activeConversation.at : Infinity;
    if (age >= 0 && age < activeConversationMs) return { conversationId: activeConversation.id };
    return validHostId(env.ANTIGRAVITY_CONVERSATION_ID)
      ? { conversationId: env.ANTIGRAVITY_CONVERSATION_ID, projectId: env.ANTIGRAVITY_PROJECT_ID } : {};
  }
  function fillPairTitle(key, conversationId) {
    if (!conversationId || closing) return;
    let lookup = titleLookups.get(conversationId);
    if (!lookup) {
      lookup = Promise.resolve().then(() => lookupTitle(conversationId)).finally(() => titleLookups.delete(conversationId));
      titleLookups.set(conversationId, lookup);
    }
    void lookup.then(title => {
      if (closing || !title) return;
      const clean = cleanPairText(title, 80);
      if (!clean) return;
      return updatePreference(key, prior => prior.pairedConversationId === conversationId && prior.pairedConversationTitle !== clean
        ? { ...prior, pairedConversationTitle: clean } : prior);
    }).catch(() => {});
  }
  const autoRead = createAutoRead({
    getPreference: preference, updatePreference,
    read: (target, id, options) => adapters[target].read(id, options), sendMessage, markRead,
    max: maxAutoReads, clock, timers, paused: () => prefs.paused
  });

  const heartbeat = createHeartbeat({
    clock, timers, paused: prefs.paused,
    async probe({ reason, target: forcedTarget }) {
      const now = clock();
      const snapshots = await Promise.all(targets.map(async target => {
        const row = state.targets[target];
        if (row.retryAt > now && reason !== 'manual' && !(reason === 'action' && target === forcedTarget)) return null;
        const includeQuota = !Number.isFinite(row.quotaCheckedAt) || now - row.quotaCheckedAt >= quotaPeriodMs;
        try {
          const sample = await adapters[target].heartbeat({
            sessionIds: watchIds(row, config.workspaces?.[target], { target, preferences: prefs.sessions }), includeQuota
          });
          return [target, { ...sample, quotaChecked: includeQuota }];
        } catch (error) {
          return [target, { error: errorDetails(error) }];
        }
      }));
      const next = applySamples(state, snapshots.filter(Boolean), clock());
      await commit(next.state);
      autoRead.offer(next.transitions);
      if (prefs.notifications && next.transitions.length) {
        try { notify(next.transitions); } catch { /* notifications are optional */ }
      }
      return { intervalMs: next.state.intervalMs };
    }
  });

  const view = () => ({
    ...state, prefs, maxAutoReads,
    targets: Object.fromEntries(targets.map(target => [
      target, { ...state.targets[target], rateLimits: latestQuota(state, target, clock()) }
    ]))
  });

  function mergeCatalog(body) {
    const at = Date.parse(body.sampledAt);
    if (!object(body.targets) || !Number.isFinite(at) || at > clock()) return null;
    const nextTargets = { ...state.targets };
    for (const target of targets) {
      const value = body.targets[target];
      if (!object(value) || value.reachable !== true || !Array.isArray(value.sessions)
          || at < (Date.parse(nextTargets[target].catalog?.sampledAt) || 0)) continue;
      nextTargets[target] = {
        ...nextTargets[target],
        catalog: { reachable: true, sampledAt: body.sampledAt, sessions: value.sessions.slice(0, 100) }
      };
    }
    return commit({ ...state, targets: nextTargets });
  }

  let selectedPort;
  const server = http.createServer(async (request, response) => {
    const answer = (status, data) => sendJson(response, status, data);
    try {
      const host = request.headers.host;
      if (!isLoopbackHost(host)) return answer(403, { error: 'invalid_host' });
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && ['/', '/ui.html'].includes(url.pathname)) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff' });
        return response.end(ui);
      }
      if (!url.pathname.startsWith('/api/')) return answer(404, { error: 'not_found' });
      const internal = ['/api/nudge', '/api/catalog'].includes(url.pathname);
      if (internal && !tokenMatches(request.headers['x-bridge-token'], nudgeToken)) return answer(401, { error: 'invalid_token' });
      if (!internal && uiToken && !tokenMatches(request.headers['x-sidecar-token'], uiToken)) return answer(401, { error: 'invalid_token' });
      if (!internal && !uiToken && request.headers.origin && !isLoopbackOrigin(request.headers.origin)) {
        return answer(403, { error: 'invalid_origin' });
      }
      const fromUi = (request.method === 'GET' && ['/api/state', '/api/summary'].includes(url.pathname))
        || (request.method === 'POST' && ['/api/refresh', '/api/prefs'].includes(url.pathname));
      const uiConversationId = request.headers['x-agy-conversation-id'];
      if (fromUi && validHostId(uiConversationId)) activeConversation = { id: uiConversationId, at: clock() };
      if (request.method === 'GET' && url.pathname === '/api/state') return answer(200, view());
      if (request.method === 'GET' && url.pathname === '/api/summary') {
        const target = url.searchParams.get('target');
        const id = url.searchParams.get('sessionId');
        if (!isTarget(target) || !isSession(id)) return answer(404, { error: 'session_not_found' });
        const row = state.targets[target];
        const matches = session => session.sessionId === id;
        const selected = row.sessions.find(matches) ?? row.catalog?.sessions?.find(matches);
        if (!selected) return answer(404, { error: 'session_not_found' });
        const event = selected.unread;
        const page = await adapters[target].read(id, { limit: 6, maxChars: 1600 });
        const turnId = selected.latestTurn?.id ?? page.messages.at(-1)?.turnId;
        const messages = page.messages.filter(message => message.turnId === turnId);
        if (event && messages.length) await markRead({ target, sessionId: id, turnId }, event);
        return answer(200, { messages, truncated: page.pageTruncated });
      }
      if (request.method !== 'POST') return answer(404, { error: 'not_found' });
      const body = await bodyJson(request);
      if (!object(body)) return answer(400, { error: 'invalid_json' });
      if (url.pathname === '/api/refresh') {
        const result = await heartbeat.refresh(url.searchParams.get('reason') === 'focus' ? 'focus' : 'manual');
        return answer(200, { ...view(), ...result });
      }
      if (url.pathname === '/api/prefs') {
        const hasTheme = Object.hasOwn(body, 'theme');
        if (hasTheme && !themeModes.has(body.theme)) return answer(400, { error: 'invalid_preferences' });
        if (isTarget(body.target) && isSession(body.sessionId)) {
          const key = body.target + ':' + body.sessionId;
          if (invalidHostIds(body)) return answer(400, { error: 'invalid_host_id', message: 'Antigravity 对话或项目 ID 格式无效' });
          if ((body.pairCurrent !== undefined && typeof body.pairCurrent !== 'boolean')
              || (body.pairedConversationId != null && !validHostId(body.pairedConversationId))
              || (body.pairLabel !== undefined && typeof body.pairLabel !== 'string')) {
            return answer(400, { error: 'invalid_pairing', message: '对话 ID 或配对标签格式无效' });
          }
          if (body.autoReadLimit !== undefined && !isAutoReadLimit(body.autoReadLimit)) {
            return answer(400, { error: 'invalid_auto_read_limit', message: '跟进轮数上限必须是 1 到 20 的整数' });
          }
          const current = preference(key);
          const uiBinding = validHostId(body.conversationId) ? body
            : { conversationId: validHostId(uiConversationId) ? uiConversationId : undefined };
          let pairId = body.pairedConversationId;
          if (body.pairCurrent === true) {
            if (!uiBinding.conversationId) {
              return answer(400, { error: 'missing_conversation_id', message: '请先打开要绑定的 Antigravity 对话' });
            }
            pairId = uiBinding.conversationId;
          } else if (body.pairCurrent === false) pairId = null;
          let automatic = {};
          if (body.autoRead === true) {
            const destination = findBinding(uiBinding, current, env);
            if (!destination && current.autoRead !== true) return answer(400, { error: 'missing_conversation_id', message: missingBinding });
            if (current.autoRead !== true) automatic = enableAutoRead(current, destination);
            if (pairId === undefined) pairId = destination?.conversationId;
          } else if (body.autoRead === false) {
            automatic = { autoRead: false, autoReadRunId: null, autoReadError: null };
          }
          if (body.autoReadLimit !== undefined) {
            automatic.autoReadLimit = body.autoReadLimit;
            if (body.autoRead !== true && current.autoRead && current.autoReadCount >= body.autoReadLimit) {
              Object.assign(automatic, { autoRead: false, autoReadRunId: null, autoReadLimitReached: true,
                autoReadError: '跟进轮数已达到新上限，自动读取已关闭' });
            }
          }
          applyGlobalPreferences(body);
          await updatePreference(key, prior => {
            const changed = { ...prior, ...automatic, ...sessionPreference(body) };
            if (body.pairLabel !== undefined) changed.pairLabel = cleanPairText(body.pairLabel, 32);
            return pairId === undefined ? changed : pairConversation(changed, pairId, clock());
          });
          fillPairTitle(key, pairId);
          autoRead.changed(key);
        } else {
          if (!hasTheme && typeof body.paused !== 'boolean' && typeof body.notifications !== 'boolean') {
            return answer(400, { error: 'invalid_preferences' });
          }
          applyGlobalPreferences(body);
          await save('prefs.json', prefs);
        }
        return answer(200, view());
      }
      if (url.pathname === '/api/nudge') {
        if (!isTarget(body.target) || !isSession(body.sessionId) || !['send', 'interrupt', 'create', 'read'].includes(body.action)) {
          return answer(400, { error: 'invalid_action' });
        }
        if (invalidHostIds(body)) return answer(400, { error: 'invalid_host_id' });
        const destination = nudgeConversation(body);
        const key = body.target + ':' + body.sessionId;
        if (body.action === 'read') {
          await markRead(body);
          const current = preference(key);
          if (destination.conversationId && !current.pairedConversationId && current.pairManualUnbound !== true) {
            await updatePreference(key, prior => pairConversation(prior, destination.conversationId, clock()));
            fillPairTitle(key, destination.conversationId);
          }
          return answer(202, { ok: true });
        }
        let missingConversation = false;
        if ((body.action === 'send' || body.action === 'create') && (destination.conversationId || body.autoReadOnFinish === true)) {
          const pairId = destination.conversationId;
          await updatePreference(key, prior => {
            let next = pairId ? { ...prior, lastDispatchConversationId: pairId,
              lastDispatchProjectId: validHostId(destination.projectId) ? destination.projectId : null } : prior;
            if (body.action === 'send' && body.autoReadOnFinish === true && !next.autoRead && !next.autoReadLimitReached) {
              const binding = findBinding(destination, next, env);
              missingConversation = !binding;
              next = binding ? enableAutoRead(next, binding) : { ...next, autoReadError: missingBinding };
            }
            return pairId ? pairConversation(next, pairId, clock()) : next;
          });
          fillPairTitle(key, pairId);
        }
        if (body.action === 'send' || (body.action === 'create' && body.tracking === true)) {
          await commit(recordDispatch(state, body, clock()));
        }
        heartbeat.nudge(body.target);
        if (missingConversation) return answer(400, { error: 'missing_conversation_id', message: missingBinding });
        return answer(202, { ok: true });
      }
      if (url.pathname === '/api/catalog') {
        const updated = mergeCatalog(body);
        if (!updated) return answer(400, { error: 'invalid_catalog' });
        await updated;
        return answer(202, { ok: true });
      }
      return answer(404, { error: 'not_found' });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) answer(503, { error: errorDetails(error) });
    }
  });

  const listening = once(server, 'listening');
  listen(server);
  await listening;
  const address = server.address();
  selectedPort = typeof address === 'object' ? address.port : port;
  try {
    if (migrated.length) await save('prefs.json', prefs);
    await save(runtimeName, { port: selectedPort, pid: process.pid, updatedAt: new Date(clock()).toISOString(), nudgeToken });
  } catch (error) {
    server.close();
    throw error;
  }
  for (const [key, conversationId] of migrated) fillPairTitle(key, conversationId);
  heartbeat.start();
  let closePromise;
  return {
    port: selectedPort, server,
    close() {
      return closePromise ??= (async () => {
        closing = true;
        autoRead.stop();
        const stopped = heartbeat.stop();
        const httpClosed = new Promise(resolve => server.close(resolve));
        const runtime = await load(runtimeName);
        if (runtime?.nudgeToken === nudgeToken) await remove(path.join(directory, runtimeName)).catch(() => {});
        await Promise.allSettled([stopped, httpClosed, writes]);
      })();
    }
  };
}

export async function runSidecar(env = process.env) {
  const config = await readConfig(env);
  const port = Number(env.ANTIGRAVITY_SIDECAR_WEB_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Antigravity Sidecar 端口无效。');
  const app = await startSidecar({
    config, env, adapters: createAdapters(config, env),
    directory: stateDirectory(env), port, uiToken: env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? ''
  });
  const shutdown = () => { void app.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return app;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await runSidecar(); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
