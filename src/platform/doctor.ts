// src/platform/doctor.ts
import type { Run } from './tmux.js';

export type Status = 'pass' | 'warn' | 'fail';
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
}
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

const ICON: Record<Status, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

export function formatReport(results: CheckOutcome[]): string {
  return results
    .map((r) => {
      const fix = r.result.fix ? `\n       fix: ${r.result.fix}` : '';
      return `${ICON[r.result.status]}  ${r.title}: ${r.result.detail}${fix}`;
    })
    .join('\n');
}
