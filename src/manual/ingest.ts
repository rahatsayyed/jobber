// Stage "manual" of a wake, run by the scheduler in code before the claude session starts: each pending manual request is classified
// (never by the model) and either fetched deterministically (known ATS host, the same board providers the code pass uses) or turned
// into a `manual_url` source task for the source-operator. Jobs are saved at priority 1; the pipeline stage then takes them first.
import type BetterSqlite3 from 'better-sqlite3';
import { loadPortals, titlePasses, type Ats, type TrackedCompany } from '../sources/boards/filters.js';
import { locationLine } from '../sources/boards/index.js';
import { FETCHERS } from '../sources/boards/registry.js';
import type { BoardFetcher, BoardJob } from '../sources/boards/greenhouse.js';
import { redactError } from '../sources/status.js';
import { finishManualRequest, listManualRequests, markRunning, MANUAL_MAX_JOBS_PER_REQUEST, saveManualJobs, type ManualRequest } from './requests.js';
import { classifyManualUrl, validateManualUrl, type ManualClass } from './url.js';

type Db = BetterSqlite3.Database;

export interface IngestDeps {
  runId: string;
  now: () => Date;
  /** Seam for tests (no network in tests); default is the production board fetchers. */
  fetchers?: Partial<Record<Ats, BoardFetcher>>;
  portalsPath?: string;
}
export interface IngestResult { requests: number; jobs: number; sourceTasks: number; failed: number }

const titleCase = (s: string): string => s.split(/[-_.]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ').slice(0, 100) || s;

function trackedFor(c: Extract<ManualClass, { kind: 'ats' }>): TrackedCompany {
  return {
    name: titleCase(c.slug), ats: c.ats, slug: c.slug, enabled: true,
    ...(c.region ? { region: c.region } : {}), ...(c.domain ? { domain: c.domain } : {}),
    ...(c.wd ? { wd: c.wd } : {}), ...(c.site ? { site: c.site } : {}),
  };
}

/** The jobs of one ATS URL: the whole board for a careers URL (capped, title-filter matches first), the one matching job for a job URL. */
export async function fetchAtsForManual(c: Extract<ManualClass, { kind: 'ats' }>, deps: Pick<IngestDeps, 'fetchers' | 'portalsPath'> = {}): Promise<{ jobs: BoardJob[]; note?: string }> {
  const fetcher = deps.fetchers?.[c.ats] ?? FETCHERS[c.ats];
  const board = await fetcher(trackedFor(c));
  const withLocation = board.map((j) => ({ ...j, description: `${locationLine(j.locations, j.remote)}${j.description}`.slice(0, 8000) }));
  if (c.jobToken) {
    const t = c.jobToken.toLowerCase();
    const hit = withLocation.filter((j) => [j.id, j.url, j.apply_url].some((x) => typeof x === 'string' && x.toLowerCase().includes(t)));
    return { jobs: hit.slice(0, 1) };
  }
  let ordered = withLocation;
  try {
    const cfg = loadPortals(deps.portalsPath).config;
    if (cfg) ordered = [...withLocation.filter((j) => titlePasses(j.title, cfg.title_filter)), ...withLocation.filter((j) => !titlePasses(j.title, cfg.title_filter))];
  } catch {
    // order is advisory
  }
  const over = ordered.length - MANUAL_MAX_JOBS_PER_REQUEST;
  return { jobs: ordered.slice(0, MANUAL_MAX_JOBS_PER_REQUEST), ...(over > 0 ? { note: `board has ${ordered.length} postings, kept ${MANUAL_MAX_JOBS_PER_REQUEST}` } : {}) };
}

async function ingestOne(db: Db, r: ManualRequest, d: IngestDeps): Promise<'jobs' | 'task' | 'failed'> {
  const fail = (why: string): 'failed' => { finishManualRequest(db, r.id, 'failed', `Request #${r.id} failed: ${why}`, d.now()); return 'failed'; };
  const v = validateManualUrl(r.url);
  if (!v.ok) return fail(v.reason);
  const cls = classifyManualUrl(v.url);
  if (cls.kind === 'unsupported') return fail(cls.reason);
  if (cls.kind === 'other') {
    const at = d.now().toISOString();
    db.transaction(() => {
      markRunning(db, r.id, d.runId, d.now());
      db.prepare("INSERT INTO source_tasks (platform, company, reason, state, created_at, updated_at, url, request_id) VALUES ('manual', NULL, 'manual_url', 'queued', ?, ?, ?, ?)").run(at, at, v.url, r.id);
    })();
    return 'task';
  }
  let found: { jobs: BoardJob[]; note?: string };
  try {
    found = await fetchAtsForManual(cls, d);
  } catch (e) {
    return fail(`could not fetch the ${cls.ats} board (${redactError(e)})`);
  }
  if (found.jobs.length === 0) return fail(cls.jobToken ? 'the job was not found on the board (it may be closed)' : 'the board returned no postings');
  markRunning(db, r.id, d.runId, d.now());
  saveManualJobs(db, r.id, found.jobs, cls.sourceKind);
  return 'jobs';
}

export async function ingestManualRequests(db: Db, deps: IngestDeps): Promise<IngestResult> {
  const out: IngestResult = { requests: 0, jobs: 0, sourceTasks: 0, failed: 0 };
  for (const r of listManualRequests(db, ['pending'])) {
    out.requests++;
    let res: 'jobs' | 'task' | 'failed';
    try {
      res = await ingestOne(db, r, deps);
    } catch (e) {
      finishManualRequest(db, r.id, 'failed', `Request #${r.id} failed: ${redactError(e)}`, deps.now());
      res = 'failed';
    }
    if (res === 'failed') out.failed++;
    else if (res === 'task') out.sourceTasks++;
    else out.jobs++;
  }
  return out;
}
