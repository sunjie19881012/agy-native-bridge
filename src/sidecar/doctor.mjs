import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DshAdapter } from '../adapters/dsh.mjs';
import { RemoteCodex } from '../adapters/remote-codex.mjs';
import { WinCodex } from '../adapters/win-codex.mjs';
import { readConfig } from '../shared/config.mjs';
import { redact } from '../shared/conversation.mjs';
import { dshTargets, windowsTarget } from '../shared/targets.mjs';

const mcpPath = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));

export function checkMcp(env = process.env) {
  const version = '2025-11-25';
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: version, capabilities: {}, clientInfo: { name: 'agy-native-bridge-doctor', version: '1' }
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' }
  ];
  const child = spawnSync(process.execPath, [mcpPath], {
    env, windowsHide: true, encoding: 'utf8', timeout: 8000,
    input: messages.map(message => JSON.stringify(message)).join('\n') + '\n'
  });
  if (child.error || child.status !== 0) throw new Error('MCP 进程没有完成握手。');
  const reply = child.stdout.trim().split('\n').map(line => JSON.parse(line)).find(line => line.id === 1);
  if (reply?.jsonrpc !== '2.0' || reply.result?.protocolVersion !== version || !reply.result?.capabilities?.tools) {
    throw new Error('MCP initialize 回执不符合协议。');
  }
  return 'stdio JSON-RPC ' + version;
}

function dshErrorMessage(error, { token, bridgeToken }) {
  let message = typeof error?.message === 'string' ? error.message : '无法读取会话列表。';
  const credentials = [token, bridgeToken].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const credential of credentials) message = message.replaceAll(credential, '[已遮盖]');
  return redact(message
    .replace(/\b((?:set-)?cookie|x-collab-token)\s*:[^\r\n]*/gi, '$1: [已遮盖]')
    .replace(/\bdsh_bridge_auth=[^;\s,]+/gi, 'dsh_bridge_auth=[已遮盖]'))
    .replace(/[\x00-\x1f\x7f]/g, ' ');
}

export async function runDoctor(env = process.env, {
  readConfig: loadConfig = readConfig,
  adapters = { WinCodex, RemoteCodex, DshAdapter },
  checkMcp: handshake = checkMcp,
  write = line => process.stdout.write(line)
} = {}) {
  const config = await loadConfig(env);
  const checks = [
    ['Node.js', async () => {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 13)) throw new Error('需要 Node.js 22.13 或更高版本。');
      return process.versions.node;
    }],
    ['Windows Codex 管道', async () => {
      await new adapters.WinCodex(config, { env }).list(1);
      return '桌面管道可读';
    }],
    ['101 SSH 与 Codex Socket', async () => {
      const remote = { ...config.remote, requestTimeoutMs: Math.min(8000, config.remote.requestTimeoutMs) };
      await new adapters.RemoteCodex({ ...config, remote }).list(1);
      return remote.transport + ' 会话列表可读';
    }],
    ['MCP 握手', async () => handshake(env)]
  ];
  for (const target of dshTargets) {
    const endpoint = config.dsh?.[target];
    if (!endpoint) continue;
    const label = windowsTarget(target) ? 'Windows DSH Bridge' : '101 DSH Bridge';
    checks.push([label, async () => {
      const dsh = { ...config.dsh, [target]: { ...endpoint, requestTimeoutMs: Math.min(8000, endpoint.requestTimeoutMs) } };
      await new adapters.DshAdapter(target, { ...config, dsh }).list(1);
      return '会话列表可读';
    }, error => dshErrorMessage(error, endpoint)]);
  }
  let failed = false;
  for (const [label, check, formatError = error => error.message] of checks) {
    try { write('[通过] ' + label + ' · ' + await check() + '\n'); }
    catch (error) { failed = true; write('[失败] ' + label + ' · ' + formatError(error) + '\n'); }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { if (await runDoctor()) process.exitCode = 1; }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
