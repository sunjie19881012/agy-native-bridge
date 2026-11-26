import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateDirectory, writeJsonAtomic } from '../shared/config.mjs';
import { pipePattern, uuidPattern } from '../shared/state.mjs';

export async function recordPipe(event, {
  env = process.env, platform = process.platform, io, now = () => new Date()
} = {}) {
  const endpoint = env.CODEX_APP_TOOLS_PIPE_PATH;
  const callerThreadId = event?.session_id;
  if (platform !== 'win32' || !['SessionStart', 'UserPromptSubmit'].includes(event?.hook_event_name)
      || typeof endpoint !== 'string' || !pipePattern.test(endpoint)
      || typeof callerThreadId !== 'string' || !uuidPattern.test(callerThreadId)
      || (env.CODEX_THREAD_ID !== undefined && env.CODEX_THREAD_ID.toLowerCase() !== callerThreadId.toLowerCase())) {
    return false;
  }
  await writeJsonAtomic(path.join(stateDirectory(env), 'win-codex-pipe.json'), {
    endpoint, callerThreadId, updatedAt: now().toISOString()
  }, io);
  return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    let body = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > 1024 * 1024) break;
    }
    if (body.length <= 1024 * 1024) await recordPipe(JSON.parse(body));
  } catch {
    // Discovery must be silent even if hooks run outside the desktop or disk is unavailable.
  }
}
