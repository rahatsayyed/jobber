// src/stack/mode.ts
// Read-only view of the run mode. This file only READS the dry-run flags from an env object; nothing in
// src/stack ever writes one (a test greps the directory and allowlists these exact read sites).
import { isDryRun } from '../safety/dryRun.js';

export interface ModeView {
  mode: 'DRY RUN' | 'LIVE';
  flags: Record<string, string>;
  lines: string[];
}

export function currentMode(env: NodeJS.ProcessEnv): ModeView {
  const dry = isDryRun(env, { linkedin: true });
  const flags: Record<string, string> = {
    JOBBER_DRY_RUN: env.JOBBER_DRY_RUN ?? '(unset)',
    SCHEDULER_DRY_RUN: env.SCHEDULER_DRY_RUN ?? '(unset)',
    LINKEDIN_DRY_RUN: env.LINKEDIN_DRY_RUN ?? '(unset)',
  };
  const head = dry
    ? 'MODE: DRY RUN (nothing is sent)'
    : 'MODE: LIVE (real email, LinkedIn and Naukri actions, within caps)';
  const tail = Object.entries(flags).map(([k, v]) => `${k}=${v}`).join('  ');
  return { mode: dry ? 'DRY RUN' : 'LIVE', flags, lines: [head, `  ${tail}`] };
}
