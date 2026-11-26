import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyServerChan, readNotifyKey, watcherOptions, watchTurn } from '../src/adapters/watcher-runtime.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const generated = process.argv[3] === '--staged'
  && path.dirname(root) === path.join(homedir(), '.cache', 'agy-native-bridge')
  && /^watch-[a-z0-9]+$/i.test(path.basename(root));
let exitCode = 0;
try {
  const options = watcherOptions(JSON.parse(process.argv[2]));
  const key = await readNotifyKey(options.notifyKeyPath);
  if (key) {
    const result = await watchTurn(options, { notify: (title, body) => notifyServerChan(key, title, body) });
    if (!generated) process.stdout.write(JSON.stringify(result) + '\n');
  } else if (!generated) {
    process.stdout.write('{"result":"skipped","reason":"notify_key_unavailable"}\n');
  }
} catch {
  if (!generated) process.stderr.write('101 轮次守望启动失败。\n');
  exitCode = 1;
} finally {
  if (generated) await rm(root, { recursive: true, force: true }).catch(() => {});
}
// A timed-out native read may still have a socket closing in the background.
if (generated) process.exit(exitCode);
else process.exitCode = exitCode;
