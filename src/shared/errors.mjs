export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function errorDetails(error) {
  if (error instanceof BridgeError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: '桥接调用失败。' };
}

export function notSent(reason, code) {
  return { result: 'not_sent', reason, ...(code && { code }) };
}

export function unknownOutcome(operationId) {
  return {
    result: 'unknown',
    code: 'UNKNOWN_OUTCOME',
    reason: 'native_response_lost',
    ...(operationId && { operationId }),
    message: '请先用 bridge_read 核对原会话。101 显式 daemon 模式也可用 reconcile 核对 operationId，未查到记录时仍需确认，请勿重发。'
  };
}

export function writeFailure(error, operationId) {
  if (error instanceof BridgeError && error.code === 'NATIVE_REJECTED') {
    return notSent('native_rejected', error.code);
  }
  return unknownOutcome(operationId);
}

export function preflightFailure(error, operationId) {
  if (error instanceof BridgeError && error.code === 'SESSION_IDENTITY_MISMATCH') {
    return notSent('session_identity_mismatch', error.code);
  }
  if (error instanceof BridgeError && ['NATIVE_TIMEOUT', 'NATIVE_DISCONNECTED'].includes(error.code)) {
    return unknownOutcome(operationId);
  }
  return notSent('preflight_failed', errorDetails(error).code);
}
