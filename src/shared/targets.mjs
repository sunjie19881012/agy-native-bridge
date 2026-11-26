export const codexTargets = ['win-codex', '101-codex'];
export const dshTargets = ['win-dsh', '101-dsh'];
export const toolTargets = [...codexTargets, ...dshTargets];

export function windowsTarget(target) {
  return target === 'win-codex' || target === 'win-dsh';
}
