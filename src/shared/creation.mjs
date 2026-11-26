import { notSent } from './errors.mjs';
import { workspaceKey } from './state.mjs';

const reminder = '请在原窗口核对新会话的模型、思考强度与审批策略。';

export function createdSession(target, sessionId, workspacePath, title) {
  return { result: 'created', target, sessionId, workspacePath, title, reminder };
}

export function creationFailure(error) {
  if (error?.code === 'NATIVE_TOOL_UNAVAILABLE') return notSent('delivery_mode_unsupported', error.code);
  return {
    result: 'unknown', code: 'UNKNOWN_OUTCOME', reason: 'creation_receipt_unavailable',
    message: '请先用 bridge_list（fresh=true）或在原窗口核对新会话，确认之前请勿重新创建。'
  };
}

export function matchesWorkspace(target, left, right) {
  const wanted = workspaceKey(target, right);
  return Boolean(wanted && wanted === workspaceKey(target, left));
}
