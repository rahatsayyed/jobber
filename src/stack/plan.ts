// src/stack/plan.ts
// Pure helpers for `up`: the explicit child environment and window argv. No I/O.
export const CHILD_ENV_NAMES = ['HOME', 'PATH', 'TERM', 'LANG', 'TZ'] as const;
export const DEFAULT_STACK_SESSION = 'jobber-stack';

// `env -i NAME=value ... <cmd>`: only the five names, taken from the current process env.
export function cleanEnvArgv(env: NodeJS.ProcessEnv, cmd: string[]): string[] {
  const pairs: string[] = [];
  for (const n of CHILD_ENV_NAMES) {
    const v = env[n];
    if (v !== undefined && v !== '' && !/[\n\r\0]/.test(v)) pairs.push(`${n}=${v}`);
  }
  return ['env', '-i', ...pairs, ...cmd];
}

export const SCHEDULER_CMD = ['npm', 'run', 'scheduler', '--', '--daemon'];
export const WEB_CMD = ['npm', 'run', 'web'];

export interface UpPlan {
  session: string;
  running: Record<string, boolean>;
  wouldStart: string[];
  notes: string[];
}
