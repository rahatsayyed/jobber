// Validation of a proposed generated provider (plan 8G task 8): (1) schema, (2) fixture replay through the fixed engine,
// (3) no field read from a hidden element. All offline; the fixtures are the pages scout_capture_fixture stored.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractWithSpec, generatedJobShape } from './engine.js';
import { hostAllowed, specSchema, type ProviderSpec } from './spec.js';

export type ValidationCode = 'schema' | 'no_fixture' | 'too_few_jobs' | 'url_outside_hosts' | 'hidden_field' | 'invalid_job';
export interface ValidationResult { ok: boolean; code?: ValidationCode; jobs: number; detail?: string }

const MAX_FIXTURES = 5;
const MAX_FIXTURE_BYTES = 1_000_000;

export function envInt(env: NodeJS.ProcessEnv, key: string, dflt: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '' || !/^\d{1,6}$/.test(raw.trim())) return dflt;
  return Math.min(max, Math.max(min, Number(raw.trim())));
}
export const genMinJobs = (env: NodeJS.ProcessEnv = process.env): number => envInt(env, 'GEN_PROVIDER_MIN_JOBS', 3, 1, 50);
export const genPromoteN = (env: NodeJS.ProcessEnv = process.env): number => envInt(env, 'GEN_PROVIDER_PROMOTE_N', 3, 1, 20);
/** Clean runs also need this many distinct run ids. */
export const PROMOTE_MIN_RUN_IDS = 2;

export function fixtureDir(root: string, id: string): string {
  return path.join(root, 'fixtures', id);
}

export function readFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => /\.(html?|json)$/i.test(n)).sort().slice(0, MAX_FIXTURES);
  const out: string[] = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const st = statSync(f);
      if (!st.isFile() || st.size > MAX_FIXTURE_BYTES) continue;
      out.push(readFileSync(f, 'utf8'));
    } catch { /* skip an unreadable fixture */ }
  }
  return out;
}

export function validateSpecAgainstFixtures(spec: ProviderSpec, fixtures: string[], minJobs: number): ValidationResult {
  const parsed = specSchema.safeParse(spec);
  if (!parsed.success) return { ok: false, code: 'schema', jobs: 0, detail: String(parsed.error.issues[0]?.path.join('.') ?? '') };
  if (fixtures.length === 0) return { ok: false, code: 'no_fixture', jobs: 0 };
  const base = spec.start_urls[0]!;
  const ids = new Set<string>();
  let total = 0;
  for (const text of fixtures) {
    const ex = extractWithSpec(spec, text, base);
    if (ex.hidden > 0) return { ok: false, code: 'hidden_field', jobs: 0 };
    if (ex.outside > 0) return { ok: false, code: 'url_outside_hosts', jobs: 0 };
    for (const j of ex.jobs) {
      if (!generatedJobShape.safeParse(j).success || !hostAllowed(new URL(j.url).hostname, spec.hosts)) return { ok: false, code: 'invalid_job', jobs: 0 };
      if (!ids.has(j.id)) { ids.add(j.id); total++; }
    }
  }
  if (total < minJobs) return { ok: false, code: 'too_few_jobs', jobs: total, detail: `${total}/${minJobs}` };
  return { ok: true, jobs: total };
}

export function validateProviderSpec(spec: ProviderSpec, root: string, minJobs: number): ValidationResult {
  return validateSpecAgainstFixtures(spec, readFixtures(fixtureDir(root, spec.id)), minJobs);
}
