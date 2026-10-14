// src/platform/doctor.ts
import type { Run } from './tmux.js';

export type Status = 'pass' | 'warn' | 'fail' | 'skip';
export interface CheckResult {
  status: Status;
  detail: string;
  fix?: string;
}
export interface DoctorContext {
  root: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  fs: {
    exists(path: string): boolean;
    read(path: string): string;
    mode(path: string): number | null;
    list?(path: string): string[];
  };
  /** Injected network call; absent means "offline" and network checks report skip. */
  fetch?: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Names of tables in the SQLite file at `path`, or null if it cannot be opened (read-only). */
  sqliteTables?: (path: string) => string[] | null;
  now?: () => Date;
  // Offline read of the dashboard allowed-account row (email and whether a sub is pinned). Optional.
  authAccount?(path: string): { email: string; pinned: boolean } | null;
}

// A check that cannot run yet ("skipped until installed"); never affects the exit code.
export const skip = (detail: string, fix?: string): CheckResult => ({ status: 'skip', detail, fix });
export interface Check {
  id: string;
  title: string;
  run(ctx: DoctorContext): Promise<CheckResult>;
}
export interface CheckOutcome {
  id: string;
  title: string;
  result: CheckResult;
}

export async function runChecks(checks: Check[], ctx: DoctorContext): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const check of checks) {
    try {
      out.push({ id: check.id, title: check.title, result: await check.run(ctx) });
    } catch {
      out.push({
        id: check.id,
        title: check.title,
        result: { status: 'fail', detail: `check ${check.id} crashed (details withheld)` },
      });
    }
  }
  return out;
}

export function exitCode(results: CheckOutcome[]): number {
  return results.some((r) => r.result.status === 'fail') ? 1 : 0;
}

const ICON: Record<Status, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };

export function formatReport(results: CheckOutcome[]): string {
  return results
    .map((r) => {
      const fix = r.result.fix ? `\n       fix: ${r.result.fix}` : '';
      return `${ICON[r.result.status]}  ${r.title}: ${r.result.detail}${fix}`;
    })
    .join('\n');
}
