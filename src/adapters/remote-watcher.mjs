import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sshRelayArgs } from './ssh-relay.mjs';
import { watcherOptions } from './watcher-runtime.mjs';

const project = new URL('../../', import.meta.url);
const wsDirectory = path.dirname(createRequire(import.meta.url).resolve('ws/package.json'));
const watcherFiles = [
  'scripts/101-turn-watcher.mjs', 'src/adapters/watcher-runtime.mjs',
  'src/adapters/ssh-daemon.mjs', 'src/adapters/ssh-desktop.mjs', 'src/adapters/ssh-relay.mjs',
  'src/adapters/win-pipe.mjs', 'src/shared/config.mjs', 'src/shared/errors.mjs',
  'src/shared/rpc.mjs', 'src/shared/state.mjs', 'src/shared/targets.mjs'
];
let archive;

async function readWatcherFiles() {
  const lib = (await readdir(path.join(wsDirectory, 'lib'))).filter(file => file.endsWith('.js')).map(file => 'lib/' + file);
  const base = watcherFiles.map(file => [file, new URL(file, project)]);
  const ws = ['package.json', 'wrapper.mjs', 'index.js', 'LICENSE', ...lib]
    .map(file => ['node_modules/ws/' + file, path.join(wsDirectory, file)]);
  return Promise.all([...base, ...ws].map(async ([file, source]) => [file, await readFile(source, 'utf8')]));
}

// Sent as Node source to the existing SSH account. The bundle arrives on stdin
// so its size does not depend on Windows command-line limits.
async function launchDetached() {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { mkdir, mkdtemp, writeFile, rm } = require('node:fs/promises');
  const path = require('node:path');
  const { homedir } = require('node:os');
  let directory;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Watcher bundle is too large');
      chunks.push(chunk);
    }
    const { files, options } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const root = path.join(homedir(), '.cache', 'agy-native-bridge');
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(path.join(root, 'watch-'));
    for (const [name, source] of files) {
      const segments = name.split('/');
      if (!['scripts', 'src', 'node_modules'].includes(segments[0])
          || segments.some(part => !/^[a-z0-9][a-z0-9_.-]*$/i.test(part)) || typeof source !== 'string') {
        throw new Error('Invalid watcher bundle');
      }
      const file = path.join(directory, ...segments);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, source, { flag: 'wx', mode: 0o600 });
    }
    const script = path.join(directory, 'scripts', '101-turn-watcher.mjs');
    const child = spawn('nohup', [process.execPath, script, JSON.stringify(options), '--staged'], {
      stdio: 'ignore', detached: true, cwd: directory
    });
    await once(child, 'spawn');
    child.unref();
    process.stdout.write('AGY_WATCHER_STARTED\n');
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    process.exitCode = 1;
  }
}

const loader = String(launchDetached) + '\nvoid launchDetached();';
const failed = reason => ({ started: false, reason });

export async function startRemoteWatcher(config, receipt, {
  spawnProcess = spawn, loadFiles = () => archive ??= readWatcherFiles().catch(error => { archive = undefined; throw error; })
} = {}) {
  let options;
  try {
    options = watcherOptions({
      ...receipt, transport: config.transport, socketPath: config.socketPath,
      notifyKeyPath: config.notifyKeyPath, watcherTimeoutMs: config.watcherTimeoutMs
    });
  } catch {
    return failed('watcher_invalid_receipt');
  }
  let child;
  try {
    const input = JSON.stringify({ options, files: await loadFiles() });
    const args = sshRelayArgs(config, loader, []);
    child = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    return await new Promise(resolve => {
      let stdout = '';
      let done = false;
      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish(failed('watcher_launch_timeout'));
        child.kill();
      }, Math.min(config.requestTimeoutMs, 10_000));
      child.on('error', () => finish(failed('watcher_launch_failed')));
      child.stdin.on('error', () => {
        if (!done) child.kill();
        finish(failed('watcher_launch_failed'));
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 1024) {
          finish(failed('watcher_launch_failed'));
          child.kill();
        }
      });
      child.once('close', code => finish(code === 0 && stdout.trim() === 'AGY_WATCHER_STARTED'
        ? { started: true } : failed('watcher_launch_failed')));
      child.stdin.end(input, 'utf8');
    });
  } catch {
    child?.kill();
    return failed('watcher_launch_failed');
  }
}
