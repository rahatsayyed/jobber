// src/stack/mode.ts
// Read-only view of the run mode. This file only READS the dry-run flags from an env object; nothing in
// src/stack ever writes one (a test greps the directory and allowlists these exact read sites).
import { isDryRun } from '../safety/dryRun.js';

export interface ModeView {
  mode: 'DRY RUN' | 'LIVE';
  flags: Record<string, string>;
  lines: string[];
}

const FLAG_NAMES = ['JOBBER_DRY_RUN'] as const;

// The flags the children see: only the parsed .env file (they run under `env -i`).
export function fileFlags(fileEnv: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const n of FLAG_NAMES) if (fileEnv[n] !== undefined) out[n] = fileEnv[n];
  return out;
}

// Warning lines where the shell exports a flag that differs from .env (which the children use).
export function shellDivergence(fileEnv: Record<string, string>, procEnv: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const n of FLAG_NAMES) {
    const sv = procEnv[n];
    if (sv === undefined || sv === fileEnv[n]) continue;
    out.push(
      `warning: shell exports ${n}=${sv}; the scheduler and dashboard ignore it and use .env (${fileEnv[n] ?? 'unset'}); other windows may inherit the shell/tmux environment`,
    );
  }
  return out;
}

export function currentMode(env: NodeJS.ProcessEnv): ModeView {
  const dry = isDryRun(env);
  const flags: Record<string, string> = {
    JOBBER_DRY_RUN: env.JOBBER_DRY_RUN ?? '(unset, runs LIVE)',
  };
  const head = dry
    ? 'MODE: DRY RUN (nothing is sent)'
    : 'MODE: LIVE (real email, LinkedIn and Naukri actions, within caps)';
  const tail = Object.entries(flags).map(([k, v]) => `${k}=${v}`).join('  ');
  return { mode: dry ? 'DRY RUN' : 'LIVE', flags, lines: [head, `  ${tail}`] };
}
