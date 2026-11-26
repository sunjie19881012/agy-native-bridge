import net from 'node:net';
import WebSocket from 'ws';
import { BridgeError } from '../shared/errors.mjs';
import { nativeRpc } from '../shared/rpc.mjs';
import { openSshRelay, relaySocket, sshRelayArgs } from './ssh-relay.mjs';

// This fixed command runs only for the lifetime of SSH. All protocol bytes travel
// through its stdio to the existing Unix socket. No remote files are installed.
const daemonRelay = String(relaySocket) + "\nrelaySocket(require('node:net').createConnection(process.argv[1]));";

export function daemonSshArgs(config) {
  return sshRelayArgs(config, daemonRelay, [config.socketPath]);
}

const allowed = new Set([
  'thread/list', 'thread/loaded/list', 'thread/read', 'thread/turns/list', 'thread/items/list',
  'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'account/rateLimits/read',
  'thread/start', 'thread/name/set'
]);

const approvalMethods = /(?:requestApproval|requestUserInput|elicitation\/create|\/approve(?:Command|FileChange)|\/approval\/request)$/i;

export function connectDaemon(config, spawnProcess) {
  return connectDaemonTransport(config, allowed, () => openSshRelay(daemonSshArgs(config), spawnProcess));
}

const readOnly = new Set(['thread/read', 'thread/turns/list']);

export function connectLocalDaemon(config) {
  return connectDaemonTransport(config, readOnly, () => {
    const stream = net.createConnection(config.socketPath);
    stream.on('error', () => {});
    return { stream, close: () => stream.destroy() };
  });
}

async function connectDaemonTransport(config, methods, connect) {
  if (config.transport !== 'daemon') {
    throw new BridgeError('NATIVE_TOOL_UNAVAILABLE', '101 只在显式配置 daemon 时使用 Daemon 连接。');
  }
  let relay;
  let ws;
  let rpc;
  let stopped = false;
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    rpc?.disconnect();
    ws?.terminate();
    relay?.close();
  };
  try {
    relay = connect();
    const { child, stream } = relay;
    // Keep the child exit and stream error contained to this call.
    child?.on('exit', () => { if (!ws || ws.readyState === WebSocket.CONNECTING) stream.destroy(); });
    ws = new WebSocket('ws://localhost', {
      perMessageDeflate: false, maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: config.requestTimeoutMs, createConnection: () => stream
    });
    const approvals = new Map();
    rpc = nativeRpc((message, callback) => ws.send(JSON.stringify(message), callback), config.requestTimeoutMs, message => {
      const { id, method, params } = message;
      const threadId = params?.threadId;
      if (!threadId) return;
      const pending = approvals.get(threadId);
      if (id != null && approvalMethods.test(method)) {
        if (!pending) approvals.set(threadId, new Set());
        approvals.get(threadId).add(String(id));
      } else if (method === 'serverRequest/resolved') {
        pending?.delete(String(params.requestId));
      } else if (method === 'turn/completed') {
        approvals.delete(threadId);
      }
    });
    ws.on('message', raw => {
      try { rpc.receive(JSON.parse(raw.toString('utf8'))); } catch { cleanup(); }
    });
    ws.on('error', rpc.disconnect);
    ws.on('close', rpc.disconnect);
    await new Promise((resolve, reject) => {
      const opened = () => finish();
      const failed = () => finish(new BridgeError('SSH_UNREACHABLE', '无法通过 SSH 打开 101 Codex Daemon。'));
      const timer = setTimeout(() => finish(new BridgeError('NATIVE_TIMEOUT', '等待 101 Codex Daemon 连接超时。')), config.requestTimeoutMs);
      function finish(error) {
        clearTimeout(timer);
        ws.off('open', opened);
        ws.off('error', failed);
        ws.off('close', failed);
        if (error) reject(error);
        else resolve();
      }
      ws.once('open', opened);
      ws.once('error', failed);
      ws.once('close', failed);
    });
    await rpc.request('initialize', {
      clientInfo: { name: 'agy_native_bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    rpc.notify('initialized');
    return {
      request(method, params) {
        if (!methods.has(method)) throw new BridgeError('NATIVE_TOOL_UNAVAILABLE', '101 路径不允许此原生操作。');
        return rpc.request(method, params);
      },
      approvalPending: id => (approvals.get(id)?.size ?? 0) > 0,
      close: cleanup
    };
  } catch (error) {
    cleanup();
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('SSH_UNREACHABLE', '无法启动 101 Codex 的 SSH 短连接。');
  }
}
