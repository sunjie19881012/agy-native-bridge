import { BridgeError } from './errors.mjs';

export function nativeRpc(send, timeoutMs, onEvent = () => {}) {
  const pending = new Map();
  let sequence = 0;
  let closed = false;

  function disconnect() {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new BridgeError('NATIVE_DISCONNECTED', '原生连接已断开。'));
    }
    pending.clear();
  }

  return {
    receive(message) {
      if (message?.method) {
        onEvent(message);
        return;
      }
      const request = pending.get(message?.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) {
        const error = new BridgeError('NATIVE_REJECTED', '原生接口拒绝了请求。');
        error.nativeMessage = message.error.message;
        request.reject(error);
      } else if (!Object.hasOwn(message, 'result')) {
        request.reject(new BridgeError('INVALID_NATIVE_RESPONSE', '原生接口回执格式有误。'));
      } else {
        request.resolve(message.result);
      }
    },
    request(method, params) {
      if (closed) return Promise.reject(new BridgeError('NATIVE_DISCONNECTED', '原生连接已断开。'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BridgeError('NATIVE_TIMEOUT', '等待原生接口回执超时。'));
        }, timeoutMs);
        pending.set(id, { timer, resolve, reject });
        try {
          send({ jsonrpc: '2.0', id, method, params }, error => { if (error) disconnect(); });
        } catch {
          disconnect();
        }
      });
    },
    notify(method) {
      if (closed) throw new BridgeError('NATIVE_DISCONNECTED', '原生连接已断开。');
      send({ jsonrpc: '2.0', method }, error => { if (error) disconnect(); });
    },
    disconnect
  };
}
