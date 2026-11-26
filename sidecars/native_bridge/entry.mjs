import { runSidecar } from '../../src/sidecar/server.mjs';

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', error => {
    if (error.code !== 'EPIPE') throw error;
  });
}

try { await runSidecar(); }
catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
