import { createInterface } from 'node:readline';
import { lstat, readdir } from 'node:fs/promises';
import net from 'node:net';
import { BridgeError } from '../shared/errors.mjs';
import { uuidPattern } from '../shared/state.mjs';
import { openSshRelay, relaySocket, sshRelayArgs } from './ssh-relay.mjs';
import { connectDesktopPipe } from './win-pipe.mjs';

// This function is also embedded in the remote Node process.
export async function discoverDesktopSocket(uid, { lstat, readdir, connect }) {
  const directory = '/tmp/codex-app-tools-' + uid;
  const root = await lstat(directory).catch(() => null);
  if (!root?.isDirectory() || root.uid !== uid) return null;

  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isSocket() || !entry.name.endsWith('.sock')) continue;
    const path = directory + '/' + entry.name;
    const info = await lstat(path).catch(() => null);
    if (info?.isSocket() && info.uid === uid) candidates.push({ path, mtime: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));

  for (const { path } of candidates) {
    // Probe the connection before exposing it to the local RPC client.
    const socket = await connect(path).catch(() => null);
    if (socket) return socket;
  }
  return null;
}

function connectSocket(path, dial = value => require('node:net').createConnection(value)) {
  const socket = dial(path);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => socket.destroy(new Error('Socket connection timed out')), 500);
    socket.once('error', reject);
    socket.once('close', () => { clearTimeout(timer); reject(new Error('Socket closed')); });
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
  });
}

export async function discoverCallerThread(home, { readdir, lstat }) {
  const rolloutName = /^rollout-.+-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i;
  let newest = null;
  async function scan(directory, depth) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = directory + '/' + entry.name;
      if (depth < 3 && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) {
        await scan(path, depth + 1);
      }
      const match = entry.isFile() && rolloutName.exec(entry.name);
      if (!match) continue;
      const info = await lstat(path).catch(() => null);
      if (info?.isFile() && (!newest || info.mtimeMs > newest.mtime
          || (info.mtimeMs === newest.mtime && path > newest.path))) {
        newest = { id: match[1], path, mtime: info.mtimeMs };
      }
    }
  }
  if (home) await scan(home + '/.codex/sessions', 0);
  return newest?.id ?? null;
}

async function startDesktopRelay() {
  const { lstat, readdir } = require('node:fs/promises');
  const path = process.argv[1];
  const socket = path ? await connectSocket(path) : await discoverDesktopSocket(
    process.geteuid(), { lstat, readdir, connect: connectSocket }
  );
  if (!socket) throw new Error('No live Codex desktop socket');
  relaySocket(socket);
  if (process.argv[2] !== 'configured-caller') {
    const caller = await discoverCallerThread(process.env.HOME, { lstat, readdir });
    process.stderr.write(caller ? 'AGY_CALLER_THREAD:' + caller + '\n' : 'AGY_CALLER_THREAD_UNAVAILABLE\n');
  }
}

const desktopRelay = [
  relaySocket, discoverDesktopSocket, connectSocket, discoverCallerThread, startDesktopRelay,
  "startDesktopRelay().catch(() => { process.stderr.write('Codex desktop socket unavailable\\n'); process.stdin.destroy(); process.exitCode = 1; });"
].join('\n');
const allowedTools = new Set([
  'list_threads', 'read_thread', 'send_message_to_thread', 'get_usage_limits',
  'list_projects', 'create_thread', 'set_thread_title'
]);

export function desktopSshArgs(config) {
  const args = config.callerThreadId ? [config.socketPath ?? '', 'configured-caller']
    : config.socketPath ? [config.socketPath] : [];
  return sshRelayArgs(config, desktopRelay, args);
}

function reportedCaller(stderr, timeoutMs) {
  if (!stderr) return Promise.resolve(null);
  const lines = createInterface({ input: stderr });
  return new Promise(resolve => {
    const finish = caller => { clearTimeout(timer); resolve(caller); lines.close(); stderr.resume(); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    lines.once('close', () => { clearTimeout(timer); resolve(null); });
    lines.on('line', line => {
      if (line === 'AGY_CALLER_THREAD_UNAVAILABLE') finish(null);
      const caller = /^AGY_CALLER_THREAD:(.+)$/.exec(line)?.[1];
      if (caller && uuidPattern.test(caller)) finish(caller);
    });
  });
}

export async function connectRemoteDesktop(config, spawnProcess) {
  let relay;
  try {
    relay = openSshRelay(desktopSshArgs(config), spawnProcess, !config.callerThreadId);
  } catch {
    throw new BridgeError('SSH_UNREACHABLE', '无法启动 101 Codex 桌面管道的 SSH 短连接。');
  }
  const discovered = reportedCaller(relay.child.stderr, config.requestTimeoutMs);
  try {
    return await connectDesktopPipe(relay.stream, {
      timeoutMs: config.requestTimeoutMs, tools: allowedTools, label: '101 Codex 桌面管道',
      async threadId(args) {
        const id = args.threadId ?? config.callerThreadId ?? await discovered;
        if (!id) throw new BridgeError('CALLER_THREAD_UNAVAILABLE', '101 未找到可用会话 UUID，请配置 remote.callerThreadId。');
        return id;
      },
      closeTransport: relay.close
    });
  } catch (error) {
    if (error.code === 'NATIVE_DISCONNECTED') {
      throw new BridgeError('PIPE_UNAVAILABLE', '无法通过 SSH 打开 101 Codex 桌面管道。');
    }
    throw error;
  }
}

export async function connectLocalDesktopReader(config, sessionId) {
  return connectLocalDesktop(config, sessionId, new Set(['read_thread']));
}

export async function connectLocalRelayDesktop(config, sessionId) {
  return connectLocalDesktop(config, sessionId, new Set(['read_thread', 'send_message_to_thread']));
}

async function connectLocalDesktop(config, sessionId, tools) {
  if (config.transport !== 'desktop-pipe') {
    throw new BridgeError('NATIVE_TOOL_UNAVAILABLE', '此连接仅用于本机 Codex 桌面管道。');
  }
  const connect = socketPath => connectSocket(socketPath, path => net.createConnection(path));
  const socket = config.socketPath ? await connect(config.socketPath)
    : await discoverDesktopSocket(process.geteuid(), { lstat, readdir, connect });
  if (!socket) throw new BridgeError('PIPE_UNAVAILABLE', '无法打开 101 桌面管道。');
  return connectDesktopPipe(socket, {
    timeoutMs: config.requestTimeoutMs, tools, label: '101 桌面管道',
    threadId: () => sessionId, closeTransport: () => socket.destroy()
  });
}
