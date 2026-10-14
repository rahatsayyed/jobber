// Pure/injectable parts of the eval judge (no `claude` spawn here), so they can be unit-tested.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseLoose, type Verdict } from './lib.js';
import type { Runner } from './claude.js';

/** Resolve --model: a value must follow the flag and must not look like another flag. Throws a clear message otherwise. */
export function parseModelArg(args: string[], fallback: string): string {
  const i = args.indexOf('--model');
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--') || v.trim() === '') {
    throw new Error('--model requires a value (an alias or model id), e.g. --model sonnet');
  }
  return v;
}

export type JudgeOutcome =
  | { status: 'judged'; verdict: Verdict }
  | { status: 'skipped'; verdict: Verdict }
  | { status: 'failed'; error: string };

export interface JudgeJobOpts {
  jobId: string;
  prompt: string;
  runner: Runner;
  rawPath: string;
  verdictPath: string;
  force?: boolean;
}

function validVerdict(v: any): v is Verdict {
  return !!v && typeof v === 'object' && v.scores && typeof v.scores === 'object' && Array.isArray(v.ranking);
}

/** Judge one job. Resumable (existing verdict is reused unless force), saves raw reply before parsing, retries once, never throws. */
export async function judgeJob(o: JudgeJobOpts): Promise<JudgeOutcome> {
  if (!o.force && existsSync(o.verdictPath)) {
    try {
      const v = JSON.parse(readFileSync(o.verdictPath, 'utf8'));
      if (validVerdict(v)) return { status: 'skipped', verdict: v };
    } catch { /* corrupt verdict file: judge again */ }
  }
  mkdirSync(path.dirname(o.rawPath), { recursive: true });
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await o.runner(o.prompt);
      writeFileSync(o.rawPath, raw);
      const v = parseLoose(raw);
      if (!validVerdict(v)) throw new Error('reply parsed but is missing scores/ranking');
      v.job = o.jobId;
      writeFileSync(o.verdictPath, JSON.stringify(v));
      return { status: 'judged', verdict: v };
    } catch (e) {
      lastError = `attempt ${attempt}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { status: 'failed', error: lastError };
}

/** Merge this run's failures into judge-errors.json, dropping entries for jobs that are now judged. */
export function recordJudgeErrors(file: string, failures: Record<string, string>, nowJudged: string[]): void {
  let prev: Record<string, string> = {};
  try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  for (const id of nowJudged) delete prev[id];
  const merged = { ...prev, ...failures };
  if (Object.keys(merged).length === 0 && !existsSync(file)) return;
  writeFileSync(file, JSON.stringify(merged, null, 2));
}
