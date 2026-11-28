import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../shared/errors.mjs';
import { nativeRpc } from '../shared/rpc.mjs';

const allowedTools = new Set([
  'list_threads', 'read_thread', 'send_message_to_thread', 'get_usage_limits',
  'list_projects', 'create_thread', 'set_thread_title'
]);
const maxFrame = 8 * 1024 * 1024;

export async function connectPipe(binding, timeoutMs, createSocket = endpoint => net.createConnection(endpoint)) {
  let socket;
  try {
    socket = createSocket(binding.endpoint);
  } catch {
    throw new BridgeError('PIPE_UNAVAILABLE', '无法打开 Windows Codex 命名管道。');
  }
  return connectDesktopPipe(socket, {
    timeoutMs, tools: allowedTools, label: 'Windows Codex',
    threadId: () => binding.callerThreadId, closeTransport: () => socket.destroy(),
    ready: () => new Promise((resolve, reject) => {
      const failed = () => finish(new BridgeError('PIPE_UNAVAILABLE', '无法打开 Windows Codex 命名管道。'));
      const connected = () => finish();
      const timer = setTimeout(() => finish(new BridgeError('NATIVE_TIMEOUT', '打开 Windows Codex 命名管道超时。')), timeoutMs);
      function finish(error) {
        clearTimeout(timer);
        socket.off('error', failed);
        socket.off('close', failed);
        socket.off('connect', connected);
        if (error) reject(error);
        else resolve();
      }
      socket.once('connect', connected);
      socket.once('error', failed);
      socket.once('close', failed);
    })
  });
}

export async function connectDesktopPipe(socket, { timeoutMs, tools, label, threadId, closeTransport, ready }) {
  const rpc = nativeRpc((message, callback) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > maxFrame) throw new Error('Frame too large');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    socket.write(Buffer.concat([header, body]), callback);
  }, timeoutMs);
  const close = () => { rpc.disconnect(); closeTransport(); };
  socket.on('close', rpc.disconnect);
  socket.on('error', rpc.disconnect);

  let frame = Buffer.alloc(4);
  let offset = 0;
  let isHeader = true;
  socket.on('data', chunk => {
    try {
      for (let start = 0; start < chunk.length;) {
        const end = Math.min(chunk.length, start + frame.length - offset);
        offset += chunk.copy(frame, offset, start, end);
        start = end;
        if (offset !== frame.length) continue;
        if (isHeader) {
          const size = frame.readUInt32LE();
          if (size === 0 || size > maxFrame) throw new Error('Invalid frame size');
          frame = Buffer.allocUnsafe(size);
        } else {
          rpc.receive(JSON.parse(frame.toString('utf8')));
          frame = Buffer.alloc(4);
        }
        offset = 0;
        isHeader = !isHeader;
      }
    } catch {
      close();
    }
  });

  try {
    if (ready) await ready();
    const listing = await rpc.request('tools/list', { threadStartKind: 'all' });
    if (!Array.isArray(listing?.tools)) throw new BridgeError('INVALID_NATIVE_RESPONSE', label + ' 工具清单格式有误。');
    return {
      close,
      requiresInput(name, property) {
        const required = listing.tools.find(tool => tool?.name === name)?.inputSchema?.required;
        return tools.has(name) && Array.isArray(required) && required.includes(property);
      },
      supportsInput(name, property) {
        const properties = listing.tools.find(tool => tool?.name === name)?.inputSchema?.properties;
        return tools.has(name) && properties != null && typeof properties === 'object' && Object.hasOwn(properties, property);
      },
      async call(name, args, options) {
        const tool = tools.has(name) && listing.tools.find(item => item?.name === name && typeof item.namespace === 'string');
        if (!tool) throw new BridgeError('NATIVE_TOOL_UNAVAILABLE', label + ' 未提供此操作。');
        const result = await rpc.request('tools/call', {
          tool: name,
          namespace: tool.namespace,
          callerSource: 'codex',
          threadId: await threadId(args),
          callId: 'agy-bridge-' + randomUUID(),
          turnId: 'agy-bridge-' + randomUUID(),
          arguments: args
        }, { timeoutMs: Math.min(timeoutMs, options?.timeoutMs ?? timeoutMs) });
        if (result?.success === false) throw new BridgeError('NATIVE_TOOL_FAILED', label + ' 返回工具调用失败。');
        if (result?.success === true && Array.isArray(result.contentItems)) {
          const text = result.contentItems.filter(i => i?.type === 'inputText').map(i => i.text).join('\n');
          try { return JSON.parse(text); } catch { /* report the protocol error below */ }
        }
        throw new BridgeError('INVALID_NATIVE_RESPONSE', label + ' 工具回执格式有误。');
      }
    };
  } catch (error) {
    close();
    throw error;
  }
}
