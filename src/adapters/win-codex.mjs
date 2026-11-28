import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRolloutReader } from './win-rollout.mjs';
import { connectPipe } from './win-pipe.mjs';
import { stateDirectory } from '../shared/config.mjs';
import { BridgeError } from '../shared/errors.mjs';
import { pipePattern, uuidPattern } from '../shared/state.mjs';
import { DesktopCodex } from './desktop-codex.mjs';

const rolloutName = /^rollout-.+-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i;
const retryPipeCodes = new Set(['PIPE_UNAVAILABLE', 'NATIVE_DISCONNECTED', 'NATIVE_TIMEOUT']);
const writeTools = new Set(['send_message_to_thread', 'create_thread', 'set_thread_title']);
const unhealthyCooldownMs = 60_000;
const failoverProbeTimeoutMs = 3_000;

export async function discoverWinPipes(io = fs, platform = process.platform) {
  if (platform !== 'win32') return [];
  try {
    const entries = await io.readdir('\\\\.\\pipe\\');
    return entries
      .map(entry => '\\\\.\\pipe\\' + (typeof entry === 'string' ? entry : entry?.name ?? ''))
      .filter(endpoint => pipePattern.test(endpoint))
      .sort();
  } catch { return []; }
}

async function isSubagentRollout(filePath, io) {
  try {
    let prefix;
    if (typeof io.open === 'function') {
      const file = await io.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        prefix = buffer.toString('utf8', 0, bytesRead);
      } finally { await file.close(); }
    } else {
      prefix = String(await io.readFile(filePath, 'utf8'));
    }
    const firstLine = JSON.parse(prefix.split('\n', 1)[0]);
    return firstLine?.type === 'session_meta' && Boolean(firstLine.payload?.source?.subagent);
  } catch { return false; }
}

export async function discoverWinCallerThread(sessionsRoot, io = fs) {
  const candidates = [];
  async function scan(directory, depth) {
    const entries = await io.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const filePath = path.join(directory, name);
      const isDir = typeof entry === 'string' ? false : entry.isDirectory?.();
      const isFile = typeof entry === 'string' ? true : entry.isFile?.();
      if (depth < 3 && isDir && /^\d{2,4}$/.test(name)) {
        await scan(filePath, depth + 1);
      }
      const match = isFile && rolloutName.exec(name);
      if (!match) continue;
      const info = await io.lstat(filePath).catch(() => null);
      if (info?.isFile?.()) {
        candidates.push({ id: match[1], path: filePath, mtime: info.mtimeMs });
      }
    }
  }
  if (sessionsRoot) await scan(sessionsRoot, 0);
  candidates.sort((a, b) => {
    if (a.mtime !== b.mtime) return b.mtime - a.mtime;
    if (a.path === b.path) return 0;
    return a.path > b.path ? -1 : 1;
  });
  for (const candidate of candidates) {
    if (!await isSubagentRollout(candidate.path, io)) return candidate.id;
  }
  return candidates[0]?.id ?? null;
}

async function readPipeBinding(env, io) {
  try {
    const binding = JSON.parse(await io.readFile(path.join(stateDirectory(env), 'win-codex-pipe.json'), 'utf8'));
    return {
      endpoint: typeof binding?.endpoint === 'string' && pipePattern.test(binding.endpoint) ? binding.endpoint : null,
      callerThreadId: typeof binding?.callerThreadId === 'string' && uuidPattern.test(binding.callerThreadId) ? binding.callerThreadId : null
    };
  } catch { return { endpoint: null, callerThreadId: null }; }
}

export async function resolveWinBindings(config, { env = process.env, io = fs, platform = process.platform } = {}) {
  const fileBinding = await readPipeBinding(env, io);
  const livePipes = await discoverWinPipes(io, platform);
  const endpoints = [];
  if (fileBinding.endpoint && (livePipes.length === 0 || livePipes.includes(fileBinding.endpoint))) {
    endpoints.push(fileBinding.endpoint);
  }
  for (const endpoint of livePipes) {
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  const callerThreadId = fileBinding.callerThreadId
    ?? config.win?.callerThreadId
    ?? await discoverWinCallerThread(config.win?.sessionsRoot, io);
  if (!endpoints.length || !callerThreadId) {
    throw new BridgeError('PIPE_UNAVAILABLE', '找不到有效的 Windows Codex 管道，请确认 Windows Codex 桌面端已打开。');
  }
  return endpoints.map(endpoint => ({ endpoint, callerThreadId }));
}

export class WinCodex extends DesktopCodex {
  constructor(config, {
    env = process.env, binding, createSocket, rollout, io = fs, platform = process.platform, clock = Date.now
  } = {}) {
    super({
      target: 'win-codex',
      connect: async () => connectPipe(await binding(), config.win.requestTimeoutMs, createSocket),
      workspaces: config.workspaces,
      rollout: rollout ?? createRolloutReader(config.win.sessionsRoot)
    });
    this.hasExplicitBinding = Boolean(binding);
    this.discovery = { config, env, io, platform, createSocket };
    this.clock = clock;
    this.lastHealthyEndpoint = null;
    this.unhealthyUntil = new Map();
  }

  orderCandidates(candidates, now) {
    const preferred = [];
    const fresh = [];
    const cooling = [];
    for (const candidate of candidates) {
      const until = this.unhealthyUntil.get(candidate.endpoint) ?? 0;
      if (until > now) cooling.push({ candidate, until });
      else {
        this.unhealthyUntil.delete(candidate.endpoint);
        if (candidate.endpoint === this.lastHealthyEndpoint) preferred.push(candidate);
        else fresh.push(candidate);
      }
    }
    cooling.sort((a, b) => a.until - b.until);
    return [...preferred, ...fresh, ...cooling.map(item => item.candidate)];
  }

  async withPipe(action) {
    if (this.hasExplicitBinding) return super.withPipe(action);
    const { config, env, io, platform, createSocket } = this.discovery;
    const candidates = await resolveWinBindings(config, { env, io, platform });
    const ordered = this.orderCandidates(candidates, this.clock());
    let lastError;
    for (let index = 0; index < ordered.length; index++) {
      const candidate = ordered[index];
      const hasFallback = index < ordered.length - 1;
      const attemptTimeout = hasFallback ? Math.min(config.win.requestTimeoutMs, failoverProbeTimeoutMs)
        : config.win.requestTimeoutMs;
      let client;
      let wrote = false;
      let transportError = null;
      const optionalErrors = new Set();
      try {
        client = await connectPipe(candidate, attemptTimeout, createSocket);
        const tracked = {
          close: () => client.close(),
          requiresInput: (...args) => client.requiresInput(...args),
          supportsInput: (...args) => client.supportsInput(...args),
          call: async (name, args, options) => {
            if (writeTools.has(name)) wrote = true;
            try {
              return await client.call(name, args, options);
            } catch (error) {
              if (options?.optional === true || name === 'get_usage_limits') {
                optionalErrors.add(error);
              } else if (!wrote && hasFallback && retryPipeCodes.has(error.code)) {
                transportError = error;
                client.close();
              }
              throw error;
            }
          }
        };
        const result = await action(tracked);
        if (transportError) throw transportError;
        this.lastHealthyEndpoint = candidate.endpoint;
        this.unhealthyUntil.delete(candidate.endpoint);
        return result;
      } catch (error) {
        lastError = error;
        if (wrote || optionalErrors.has(error) || !retryPipeCodes.has(error.code)) throw error;
        if (this.lastHealthyEndpoint === candidate.endpoint) this.lastHealthyEndpoint = null;
        this.unhealthyUntil.set(candidate.endpoint, this.clock() + unhealthyCooldownMs);
      } finally {
        client?.close();
      }
    }
    throw lastError;
  }
}
