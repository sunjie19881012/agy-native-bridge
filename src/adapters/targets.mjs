import { DshAdapter } from './dsh.mjs';
import { RemoteCodex } from './remote-codex.mjs';
import { WinCodex } from './win-codex.mjs';
import { dshTargets } from '../shared/targets.mjs';

export function createAdapters(config, env = process.env) {
  return Object.assign(
    { 'win-codex': new WinCodex(config, { env }), '101-codex': new RemoteCodex(config) },
    Object.fromEntries(dshTargets.filter(target => config.dsh?.[target]).map(target => [target, new DshAdapter(target, config)]))
  );
}
