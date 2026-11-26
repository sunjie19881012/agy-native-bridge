import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { BridgeError } from './errors.mjs';
import { uuidPattern } from './state.mjs';
import { dshTargets, toolTargets, windowsTarget } from './targets.mjs';

export const maxWatcherTimeoutMs = 8 * 60 * 60_000;
export const defaultWatcherTimeoutMs = maxWatcherTimeoutMs / 2;
export const defaultMaxAutoReads = 5;
export const isAutoReadLimit = value => Number.isInteger(value) && value >= 1 && value <= 20;

export function stateDirectory(env = process.env) {
  return path.resolve(env.AGY_NATIVE_BRIDGE_HOME || path.join(
    env.USERPROFILE || homedir(), '.gemini', 'config', 'agy-native-bridge'
  ));
}

export async function writeJsonAtomic(file, value, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  await io.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await io.rename(temporary, file);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function timeout(value) {
  return Number.isInteger(value) && value >= 100 && value <= 120_000;
}

function absoluteRemotePath(value) {
  return typeof value === 'string' && path.posix.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
}

function dshEndpoints(raw) {
  if (!object(raw)) throw new BridgeError('INVALID_CONFIG', 'dsh 必须是目标与连接配置的映射。');
  return Object.fromEntries(Object.entries(raw).map(([target, endpoint]) => {
    let url;
    if (object(endpoint) && typeof endpoint.baseUrl === 'string') {
      try { url = new URL(endpoint.baseUrl); } catch { /* handled below */ }
    }
    const nonblank = value => typeof value === 'string' && value.trim().length && !/[\x00-\x1f\x7f]/.test(value);
    if (!dshTargets.includes(target) || !url || !['http:', 'https:'].includes(url.protocol)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || !nonblank(endpoint.id) || !nonblank(endpoint.environmentId) || !nonblank(endpoint.token)
        || endpoint.token.length < 32 || (endpoint.bridgeToken !== undefined && !nonblank(endpoint.bridgeToken))
        || (endpoint.requestTimeoutMs !== undefined && !timeout(endpoint.requestTimeoutMs))) {
      throw new BridgeError('INVALID_CONFIG', 'DSH 需要 Bridge 根地址、主机和环境标识，以及至少 32 字符的协作密钥。');
    }
    return [target, {
      baseUrl: url.origin, id: endpoint.id, environmentId: endpoint.environmentId,
      token: endpoint.token, bridgeToken: endpoint.bridgeToken,
      requestTimeoutMs: endpoint.requestTimeoutMs ?? 15_000
    }];
  }));
}

export function validateConfig(value, env = process.env) {
  if (!object(value)) throw new BridgeError('INVALID_CONFIG', 'config.json 必须是 JSON 对象。');
  const win = {
    sessionsRoot: path.join(env.CODEX_HOME || path.join(env.USERPROFILE || homedir(), '.codex'), 'sessions'),
    requestTimeoutMs: 15_000,
    ...value.win
  };
  const remote = {
    sshTarget: 'codex-101',
    transport: 'desktop-pipe',
    requestTimeoutMs: 15_000,
    watcherTimeoutMs: defaultWatcherTimeoutMs,
    ...value.remote
  };
  if (remote.transport === 'daemon' && remote.socketPath === undefined) {
    remote.socketPath = '/home/user/.codex/app-server-control/app-server-control.sock';
  }
  const workspaces = value.workspaces ?? {};
  const sidecar = { maxAutoReads: defaultMaxAutoReads, ...value.sidecar };
  if ((value.win !== undefined && !object(value.win)) || (value.remote !== undefined && !object(value.remote))
      || typeof win.sessionsRoot !== 'string' || !path.isAbsolute(win.sessionsRoot)
      || !timeout(win.requestTimeoutMs) || !timeout(remote.requestTimeoutMs)
      || (win.callerThreadId !== undefined && (typeof win.callerThreadId !== 'string' || !uuidPattern.test(win.callerThreadId)))
      || typeof remote.sshTarget !== 'string'
      || !/^(?:[a-z0-9_][a-z0-9_.-]*@)?[a-z0-9][a-z0-9_.-]*$/i.test(remote.sshTarget)
      || !['desktop-pipe', 'daemon'].includes(remote.transport)
      || (remote.callerThreadId !== undefined && (typeof remote.callerThreadId !== 'string' || !uuidPattern.test(remote.callerThreadId)))
      || (remote.socketPath !== undefined && !absoluteRemotePath(remote.socketPath))
      || (remote.notifyKeyPath !== undefined && !absoluteRemotePath(remote.notifyKeyPath))
      || !Number.isSafeInteger(remote.watcherTimeoutMs) || remote.watcherTimeoutMs < 1
      || remote.watcherTimeoutMs > maxWatcherTimeoutMs
      || (remote.nodeBin !== undefined && !absoluteRemotePath(remote.nodeBin)) || !object(workspaces)) {
    throw new BridgeError('INVALID_CONFIG', '请核对 win、remote 和 workspaces 配置。');
  }
  if (remote.transport === 'desktop-pipe' && remote.socketPath
      && path.posix.basename(remote.socketPath) === 'app-server-control.sock') {
    throw new BridgeError('INVALID_CONFIG', '桌面模式请移除旧 daemon socketPath，或改填桌面管道路径。');
  }
  if ((value.sidecar !== undefined && !object(value.sidecar)) || !isAutoReadLimit(sidecar.maxAutoReads)) {
    throw new BridgeError('INVALID_CONFIG', 'sidecar.maxAutoReads 必须是 1 到 20 的整数。');
  }
  for (const [target, entries] of Object.entries(workspaces)) {
    const platform = windowsTarget(target) ? path.win32 : path.posix;
    if (!toolTargets.includes(target) || !object(entries)
        || Object.values(entries).some(v => typeof v !== 'string' || !platform.isAbsolute(v))) {
      throw new BridgeError('INVALID_CONFIG', 'workspaces 需要按目标端填写会话与绝对工作区路径。');
    }
  }
  return { win, remote, dsh: dshEndpoints(value.dsh === undefined ? {} : value.dsh), workspaces, sidecar };
}

export async function readConfig(env = process.env) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(path.join(stateDirectory(env), 'config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new BridgeError('INVALID_CONFIG', '无法读取 config.json，请核对文件和 JSON 格式。');
    value = {};
  }
  return validateConfig(value, env);
}

export async function writeConfig(value, env = process.env) {
  validateConfig(value, env);
  await writeJsonAtomic(path.join(stateDirectory(env), 'config.json'), value);
}
