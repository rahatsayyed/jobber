// src/platform/interactive.ts
// Small pure helpers for the interactive launcher path in scripts/run-claude.ts.
import type { spawn as nodeSpawn } from 'node:child_process';
import type { ResolvedProfile } from './runner.js';

export const CLASSIFIER_SKIP_LINE = 'run-claude: classifier check skipped (profile has no MCP tools and no untrusted-text surface)';

// Returns an error message (launcher exits 2) or null. Pure.
export function checkInteractiveUse(profile: ResolvedProfile, flagGiven: boolean, isTty: boolean): string | null {
  if (profile.interactive === true && !flagGiven) return 'this profile is interactive: pass --interactive';
  if (profile.interactive !== true && flagGiven) return '--interactive is not allowed for a non-interactive profile';
  if (profile.interactive === true && !isTty) return 'interactive profile needs a terminal (stdin and stdout must be a TTY)';
  return null;
}

// argv and env key NAMES only, never values.
export function formatPrintArgs(args: string[], env: Record<string, string>): string {
  return `${JSON.stringify(['claude', ...args])}\nenv keys: ${Object.keys(env).sort().join(',')}\n`;
}

type Spawner = typeof nodeSpawn;

export function spawnInteractive(spawner: Spawner, args: string[], env: Record<string, string>, cwd: string) {
  return spawner('claude', args, { env, stdio: 'inherit', cwd });
}
