// Command-line parsing for scripts/scheduler.ts, kept pure so it can be tested without reading .env.
export type SchedulerMode = 'status' | 'dry-run-plan' | 'daemon' | 'once' | 'usage';

export interface SchedulerArgs {
  mode: SchedulerMode;
  /** `--now`: run one wake immediately (the /runhunt shim). Alone it implies `--once`. */
  now: boolean;
  help: boolean;
}

export function parseSchedulerArgs(argv: string[]): SchedulerArgs {
  const a = new Set(argv);
  const now = a.has('--now');
  const help = a.has('--help');
  let mode: SchedulerMode = 'usage';
  if (a.has('--status')) mode = 'status';
  else if (a.has('--dry-run-plan')) mode = 'dry-run-plan';
  else if (a.has('--daemon')) mode = 'daemon';
  else if (a.has('--once') || now) mode = 'once';
  return { mode, now, help };
}
