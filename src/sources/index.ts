import type BetterSqlite3 from 'better-sqlite3';
import type { Job } from '../db.js';
import { runScriptSources } from './runner.js';
import type { SourceOutcome } from './status.js';

export interface FetchParams {
  role: string;
  location?: string;
  isKnown?: (id: string) => boolean;
  /** When given, the runner also compares against the stored per-source state and queues agent fallback tasks (source_tasks). */
  db?: BetterSqlite3.Database;
}

/**
 * Runs every source through the script-first runner (src/sources/runner.ts). One failing source contributes no jobs and an error
 * outcome (redacted, logged to stderr) instead of losing every other source. `outcomes` feeds the per-source status (src/sources/status.ts).
 * Boards ignore role/location on purpose: only the filters in config/portals.json apply to them.
 */
export async function fetchAllJobsDetailed(params: FetchParams): Promise<{ jobs: Job[]; outcomes: SourceOutcome[] }> {
  const { jobs, outcomes } = await runScriptSources(params.db ?? null, { role: params.role, location: params.location, isKnown: params.isKnown });
  return { jobs, outcomes };
}

export async function fetchAllJobs(params: FetchParams): Promise<Job[]> {
  return (await fetchAllJobsDetailed(params)).jobs;
}
