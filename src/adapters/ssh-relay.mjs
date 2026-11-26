import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

export function relaySocket(socket) {
  socket.on('error', () => { process.exitCode = 1; });
  socket.on('close', () => { process.stdin.unpipe(socket); process.stdin.destroy(); });
  process.stdin.on('end', () => socket.destroy());
  process.stdout.on('error', () => socket.destroy());
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

const findNode = [
  'if command -v node >/dev/null 2>&1 && node --version >/dev/null 2>&1; then',
  '  node_bin=node;',
  'else',
  '  node_bin=$(printf "%s\\n" "$HOME"/.nvm/versions/node/*/bin/node | LC_ALL=C sort -Vr |',
  '    while IFS= read -r candidate; do',
  '      if [ -f "$candidate" ] && [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then',
  '        printf "%s\\n" "$candidate"; break;',
  '      fi;',
  '    done);',
  'fi;',
  'if [ -z "$node_bin" ]; then printf "%s\\n" "Node not found. Configure remote.nodeBin." >&2; exit 127; fi;'
].join(' ');

// Run a single Node process on the target with stdio reserved for the wire protocol.
export function sshRelayArgs({ sshTarget, requestTimeoutMs, nodeBin }, script, args) {
  const relayArgs = ['-e', script, '--', ...args].map(quote).join(' ');
  const command = nodeBin === undefined
    ? findNode + ' exec "$node_bin" ' + relayArgs
    : 'exec ' + quote(nodeBin) + ' ' + relayArgs;
  return [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=' + Math.max(1, Math.ceil(requestTimeoutMs / 1000)),
    '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '--', sshTarget, command
  ];
}

export function openSshRelay(args, spawnProcess = spawn, captureStderr = false) {
  const child = spawnProcess('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'] });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.on('error', () => stream.destroy());
  stream.on('error', () => {});
  return {
    child, stream,
    close() {
      stream.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  };
}
