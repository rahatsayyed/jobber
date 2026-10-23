import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, listQueuedOutreach, listUnscoredJobs, saveJob, MANUAL_PRIORITY_PER_WAKE, type Job } from '../src/db.js';
import { classifyManualUrl, validateManualUrl } from '../src/manual/url.js';
import { createManualRequest, getManualRequest, jobIdsOf, listManualRequests, manualRequestsPending, MANUAL_MAX_JOBS_PER_REQUEST } from '../src/manual/requests.js';
import { ingestManualRequests } from '../src/manual/ingest.js';
import { cleanUntrusted, composeManualReport, finalizeManualRequests } from '../src/manual/report.js';
import { countDue, type DueCounts } from '../src/scheduler/due.js';
import { planWake, stepOrder, type PlanKnobs } from '../src/scheduler/plan.js';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import { loadBudget } from '../src/scheduler/budget.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { run as applyRequestCli } from '../scripts/apply-request.js';
import { isApplyBlockedSource } from '../src/lib/discoverOnly.js';
import { classifyApplyUrl } from '../src/apply/registry.js';
import { resolveTaskTarget } from '../src/scout/targets.js';
import { buildHandlers } from '../src/mcp/scout.js';
import { createWebRuntime, type WebRuntime } from '../src/webcore/runtime.js';
import { createScoutBrowser } from './helpers/fakeScoutBrowser.js';
import type { BoardJob } from '../src/sources/boards/greenhouse.js';
import type { PacingConfig } from '../src/outreach/pacing.js';
import type { ControlState } from '../src/scheduler/control.js';
import type { CeilingStatus, LimitKey } from '../src/outreach/limits.js';

const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
const QUIET = new Date('2026-10-14T21:00:00.000Z'); // 02:30 IST
const pacing: PacingConfig = {
  quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330,
  minBurst: 1, maxBurst: 4, minActionGapSec: 120, maxActionGapSec: 360, minWaitMin: 8, maxWaitMin: 40, jitter: 0.25,
};
const knobs: PlanKnobs = { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 };
const ctl = (o: Partial<ControlState> = {}): ControlState => ({ killed: false, killReason: null, halted: { linkedin: null, naukri: null }, allowed: ['linkedin', 'naukri'], readError: null, ...o });
const ceil = (bad: LimitKey[] = []): Record<LimitKey, CeilingStatus> => Object.fromEntries(
  (['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message', 'apply_attempt'] as LimitKey[]).map((k) => [k, bad.includes(k) ? { used: 5, limit: 5, ok: false } : { used: 0, limit: 5, ok: true }]),
) as Record<LimitKey, CeilingStatus>;
const idleDue = (o: Partial<DueCounts> = {}): DueCounts => ({
  followupsDue: 0, newOutreachReady: 0, followupsDueByPlatform: { linkedin: 0, naukri: 0 }, newOutreachReadyByPlatform: { linkedin: 0, naukri: 0 },
  inboxLastCheckedMinAgo: 5, naukriSearchLastHoursAgo: 1, ...o,
});
const plan = (due: DueCounts, over: { now?: Date; control?: ControlState; ceilings?: Record<LimitKey, CeilingStatus> } = {}) =>
  planWake({ now: over.now ?? NOW, rng: () => 0.5, pacing, control: over.control ?? ctl(), ceilings: over.ceilings ?? ceil(), due, knobs });

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, source: 'greenhouse', title: `Engineer ${id}`, company: 'Acme', url: `https://boards.greenhouse.io/acme/jobs/${id}`,
  apply_url: `https://boards.greenhouse.io/acme/jobs/${id}`, description: 'Build things with React.', ...o,
});
const board = (ids: string[]): BoardJob[] => ids.map((id) => ({ ...job(`gh:acme:${id}`, { url: `https://boards.greenhouse.io/acme/jobs/${id}`, apply_url: `https://boards.greenhouse.io/acme/jobs/${id}` }), locations: ['Remote'], remote: true }));

describe('URL validation', () => {
  it('accepts a plain https URL and drops the fragment', () => {
    expect(validateManualUrl('  https://boards.greenhouse.io/acme/jobs/123#apply ')).toEqual({ ok: true, url: 'https://boards.greenhouse.io/acme/jobs/123' });
  });
  it.each([
    ['http://acme.com/jobs', 'https'],
    ['https://user:pw@acme.com/jobs', 'credentials'],
    ['https://acme.com:8443/jobs', 'port'],
    ['https://127.0.0.1/jobs', 'ip'],
    ['https://localhost/jobs', 'public'],
    ['https://evil-greenhouse.io/acme/jobs/1', 'imitates'],
    ['https://acme.com/a b', 'spaces'],
    ['javascript:alert(1)', 'https'],
    ['', 'empty'],
    [`https://acme.com/${'a'.repeat(600)}`, 'longer'],
    ['notaurl', 'valid'],
  ])('rejects %s', (u, why) => {
    const r = validateManualUrl(u);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
  });
  it('rejects a non-string', () => expect(validateManualUrl(42).ok).toBe(false));
});

describe('classification', () => {
  it('reads the board and job of each known ATS host', () => {
    expect(classifyManualUrl('https://boards.greenhouse.io/acme/jobs/4012')).toMatchObject({ kind: 'ats', ats: 'greenhouse', slug: 'acme', jobToken: '4012', requestKind: 'url', sourceKind: 'manual:greenhouse' });
    expect(classifyManualUrl('https://job-boards.greenhouse.io/acme')).toMatchObject({ kind: 'ats', ats: 'greenhouse', jobToken: null, requestKind: 'careers' });
    expect(classifyManualUrl('https://jobs.lever.co/acme/0f9c1e2a-1111-2222-3333-444455556666/apply')).toMatchObject({ ats: 'lever', jobToken: '0f9c1e2a-1111-2222-3333-444455556666' });
    expect(classifyManualUrl('https://jobs.ashbyhq.com/acme')).toMatchObject({ ats: 'ashby', requestKind: 'careers' });
    expect(classifyManualUrl('https://apply.workable.com/acme/j/ABC123/')).toMatchObject({ ats: 'workable', jobToken: 'ABC123' });
    expect(classifyManualUrl('https://acme.recruitee.com/o/react-dev')).toMatchObject({ ats: 'recruitee', slug: 'acme', jobToken: 'react-dev' });
    expect(classifyManualUrl('https://acme.jobs.personio.de/job/778')).toMatchObject({ ats: 'personio', jobToken: '778', domain: 'de' });
    expect(classifyManualUrl('https://jobs.smartrecruiters.com/Acme/7430001-react-dev')).toMatchObject({ ats: 'smartrecruiters', jobToken: '7430001-react-dev' });
    expect(classifyManualUrl('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Pune/React-Dev_R1')).toMatchObject({ ats: 'workday', slug: 'acme', wd: 'wd5', site: 'External', jobToken: 'React-Dev_R1' });
  });
  it('sends unknown hosts to the page reader, guessing single job versus careers page from the path', () => {
    expect(classifyManualUrl('https://careers.acme.test/jobs/48213-senior-react')).toEqual({ kind: 'other', sourceKind: 'manual:other', requestKind: 'url' });
    expect(classifyManualUrl('https://careers.acme.test/careers')).toEqual({ kind: 'other', sourceKind: 'manual:other', requestKind: 'careers' });
  });
  it('refuses LinkedIn and Naukri with a clear reason (not supported yet)', () => {
    expect(classifyManualUrl('https://www.linkedin.com/jobs/view/123')).toMatchObject({ kind: 'unsupported' });
    expect(classifyManualUrl('https://www.naukri.com/job-listings-x-123')).toMatchObject({ kind: 'unsupported' });
  });
  it('a bad vendor slug is unsupported, not fetched', () => {
    expect(classifyManualUrl('https://boards.greenhouse.io/a%20b/jobs/1')).toMatchObject({ kind: 'unsupported' });
  });
});

describe('request lifecycle and CLI', () => {
  it('creates one pending row, dedupes an open identical request and upgrades it to force', () => {
    const db = openDb(':memory:');
    const a = createManualRequest(db, 'https://boards.greenhouse.io/acme/jobs/1', { now: NOW });
    expect(a).toMatchObject({ ok: true, duplicate: false, kind: 'url' });
    const b = createManualRequest(db, 'https://boards.greenhouse.io/acme/jobs/1', { force: true });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(listManualRequests(db, ['pending'])).toHaveLength(1);
    expect(listManualRequests(db, ['pending'])[0]).toMatchObject({ force: 1, status: 'pending', created_at: NOW.toISOString() });
    expect(manualRequestsPending(db)).toBe(1);
  });
  it('rejects invalid and unsupported input without a row', () => {
    const db = openDb(':memory:');
    expect(createManualRequest(db, 'http://x.com/jobs')).toMatchObject({ ok: false });
    expect(createManualRequest(db, 'https://www.linkedin.com/jobs/view/1')).toMatchObject({ ok: false });
    expect(listManualRequests(db, ['pending'])).toHaveLength(0);
  });
  it('the CLI prints the id, the reason on rejection and usage on bad arguments', () => {
    const db = openDb(':memory:');
    const ok = applyRequestCli(['https://jobs.lever.co/acme', '--force'], { db });
    expect(ok.code).toBe(0);
    expect(ok.lines[0]).toContain('request #1');
    expect(ok.lines[0]).toContain('force');
    expect(applyRequestCli(['http://nope.com'], { db })).toMatchObject({ code: 1 });
    expect(applyRequestCli([], { db }).code).toBe(2);
    expect(applyRequestCli(['https://a.com/x', '--bogus'], { db }).code).toBe(2);
  });
});

describe('planWake with a manual request', () => {
  it('plans a run for a pending request even when nothing else is due, manual step first, pipeline, mail and apply pulled in', () => {
    expect(plan(idleDue())).toEqual({ kind: 'skip', reason: 'nothing_due' });
    const d = plan(idleDue({ manualRequestsPending: 1 }));
    expect(d.kind).toBe('run');
    if (d.kind !== 'run') return;
    const order = stepOrder(d);
    expect(order[0]).toMatchObject({ operator: 'code', kind: 'manual', quota: 1 });
    expect(order.map((s) => s.kind)).toEqual(expect.arrayContaining(['manual', 'discover_agent', 'pipeline', 'mail']));
    expect(order.findIndex((s) => s.kind === 'discover_agent')).toBeGreaterThan(0);
  });
  it('still respects the kill switch, halts and quiet hours', () => {
    const due = idleDue({ manualRequestsPending: 2 });
    expect(plan(due, { control: ctl({ killed: true, killReason: 'stop' }) })).toMatchObject({ kind: 'skip', reason: 'killed' });
    expect(plan(due, { control: ctl({ allowed: [], halted: { linkedin: 'x', naukri: 'y' } }) })).toMatchObject({ kind: 'skip', reason: 'halted' });
    expect(plan(due, { now: QUIET })).toMatchObject({ kind: 'skip', reason: 'quiet_hours' });
  });
  it('countDue reports pending requests only', () => {
    const db = openDb(':memory:');
    expect(countDue(db, NOW, TUNING_DEFAULTS, {}).manualRequestsPending).toBe(0);
    createManualRequest(db, 'https://jobs.ashbyhq.com/acme');
    expect(countDue(db, NOW, TUNING_DEFAULTS, {}).manualRequestsPending).toBe(1);
    db.prepare("UPDATE manual_requests SET status = 'running'").run();
    expect(countDue(db, NOW, TUNING_DEFAULTS, {}).manualRequestsPending).toBe(0);
  });
  it('the wake prompt lists the manual step first and the priority rules', () => {
    const d = plan(idleDue({ manualRequestsPending: 1 }));
    if (d.kind !== 'run') throw new Error('expected run');
    const order = stepOrder(d);
    const p = buildWakePrompt({
      runId: 'r1', dryRun: true, burst: d.burst, tasks: d.tasks, budget: loadBudget({}), allowed: ['linkedin'], now: NOW, order,
      pipeline: { matchThreshold: 60, sendLimit: 1, targetRegions: 'Target regions: x', followupsAutonomous: false },
    });
    expect(p.indexOf('1. manual:')).toBeGreaterThan(-1);
    expect(p.indexOf('manual:')).toBeLessThan(p.indexOf('`source-operator`'));
    expect(p).toContain('manual_url');
    expect(p).toContain('force_prepare');
    expect(p).toContain('priority: 1');
  });
});

describe('ingest', () => {
  const fetchers = { greenhouse: async () => board(['4012', '4013', '4014']) };
  const deps = { runId: 'run1', now: () => NOW, fetchers };

  it('a single ATS job URL: fetch the board in code, keep the one job, save it at priority 1 under manual:<ats>, mark the request running', async () => {
    const db = openDb(':memory:');
    const r = createManualRequest(db, 'https://boards.greenhouse.io/acme/jobs/4013');
    if (!r.ok) throw new Error('create');
    const res = await ingestManualRequests(db, deps);
    expect(res).toMatchObject({ requests: 1, failed: 0 });
    const req = getManualRequest(db, r.id)!;
    expect(req).toMatchObject({ status: 'running', run_id: 'run1' });
    expect(jobIdsOf(req)).toEqual(['gh:acme:4013']);
    const j = db.prepare('SELECT source, priority, description FROM jobs WHERE id = ?').get('gh:acme:4013') as { source: string; priority: number; description: string };
    expect(j).toMatchObject({ source: 'manual:greenhouse', priority: 1 });
    expect(j.description.startsWith('Location: Remote (remote)')).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(1);
  });
  it('a careers page on an ATS host keeps every job, capped', async () => {
    const db = openDb(':memory:');
    const many = Array.from({ length: 40 }, (_, i) => String(1000 + i));
    createManualRequest(db, 'https://boards.greenhouse.io/acme');
    await ingestManualRequests(db, { ...deps, fetchers: { greenhouse: async () => board(many) } });
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE priority = 1').get() as { n: number }).n).toBe(MANUAL_MAX_JOBS_PER_REQUEST);
  });
  it('a job that is not on the board fails the request with a reason (never silently dropped)', async () => {
    const db = openDb(':memory:');
    const r = createManualRequest(db, 'https://boards.greenhouse.io/acme/jobs/9999');
    if (!r.ok) throw new Error('create');
    await ingestManualRequests(db, deps);
    expect(getManualRequest(db, r.id)).toMatchObject({ status: 'failed' });
    expect(getManualRequest(db, r.id)!.report).toContain('not found on the board');
  });
  it('a fetch error fails the request', async () => {
    const db = openDub();
    const r = createManualRequest(db, 'https://boards.greenhouse.io/acme');
    if (!r.ok) throw new Error('create');
    await ingestManualRequests(db, { ...deps, fetchers: { greenhouse: async () => { throw new Error('boom'); } } });
    expect(getManualRequest(db, r.id)).toMatchObject({ status: 'failed' });
  });
  it('a job already stored keeps its source and score, gets priority 1 and fresh counters; a veto stays', async () => {
    const db = openDb(':memory:');
    saveJob(db, job('gh:acme:4013'));
    db.prepare("UPDATE jobs SET score = 70, prep_offers = 2, match_fails = 1, excluded_reason = 'hard stop: x' WHERE id = 'gh:acme:4013'").run();
    createManualRequest(db, 'https://boards.greenhouse.io/acme/jobs/4013');
    await ingestManualRequests(db, deps);
    expect(db.prepare("SELECT source, score, priority, prep_offers, match_fails, excluded_reason FROM jobs WHERE id = 'gh:acme:4013'").get())
      .toEqual({ source: 'greenhouse', score: 70, priority: 1, prep_offers: 0, match_fails: 0, excluded_reason: 'hard stop: x' });
  });
  it('an unknown host queues one manual_url source task carrying the url and the request id', async () => {
    const db = openDb(':memory:');
    const r = createManualRequest(db, 'https://careers.acme.test/careers');
    if (!r.ok) throw new Error('create');
    expect(await ingestManualRequests(db, deps)).toMatchObject({ requests: 1, sourceTasks: 1 });
    expect(db.prepare('SELECT platform, company, reason, state, url, request_id FROM source_tasks').all())
      .toEqual([{ platform: 'manual', company: null, reason: 'manual_url', state: 'queued', url: 'https://careers.acme.test/careers', request_id: r.id }]);
    expect(getManualRequest(db, r.id)!.status).toBe('running');
    expect(countDue(db, NOW, TUNING_DEFAULTS, {}).sourceTasksQueued).toBe(1);
  });
  it('a tampered stored url is rejected at ingest time', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO manual_requests (url, kind) VALUES ('http://evil.test/x', 'url')").run();
    await ingestManualRequests(db, deps);
    expect(getManualRequest(db, 1)).toMatchObject({ status: 'failed' });
  });
});
function openDub() { return openDb(':memory:'); }

describe('priority in the pipeline input and the queues', () => {
  function addPrio(db: ReturnType<typeof openDb>, id: string, o: Partial<{ score: number | null; priority: number; at: string; excluded: string }> = {}) {
    saveJob(db, job(id));
    db.prepare('UPDATE jobs SET score = ?, priority = ?, created_at = ?, excluded_reason = ? WHERE id = ?').run(o.score ?? null, o.priority ?? 1, o.at ?? '2026-10-10 10:00:00', o.excluded ?? null, id);
  }
  it('priority jobs come first, ahead of older normal jobs and matched hand-backs, and are flagged', () => {
    const db = openDb(':memory:');
    saveJob(db, job('old')); db.prepare("UPDATE jobs SET created_at = '2026-01-01 00:00:00' WHERE id = 'old'").run();
    saveJob(db, job('pending')); db.prepare("UPDATE jobs SET score = 80 WHERE id = 'pending'").run();
    addPrio(db, 'm1', { at: '2026-10-14 10:00:00' });
    addPrio(db, 'm2', { score: 75, at: '2026-10-13 10:00:00' });
    const rows = listUnscoredJobs(db, { limit: 10, matchThreshold: 60 });
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm1', 'pending', 'old']);
    expect(rows[0]).toMatchObject({ priority: 1, already_matched: true, score: 75 });
    expect(rows[1]).toMatchObject({ priority: 1 });
    expect(rows[1].already_matched).toBeUndefined();
    expect(rows[3].priority).toBeUndefined();
  });
  it('priority jobs bypass the batch cap but never exceed 10 per wake; the rest stay pending', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 14; i++) addPrio(db, `p${String(i).padStart(2, '0')}`, { at: `2026-10-10 10:${String(i).padStart(2, '0')}:00` });
    saveJob(db, job('normal'));
    const first = listUnscoredJobs(db, { limit: 5, matchThreshold: 60 });
    expect(first).toHaveLength(MANUAL_PRIORITY_PER_WAKE);
    expect(first.every((r) => r.priority === 1)).toBe(true);
    // once the first 10 are scored the next wake gets the remaining 4 first
    for (const r of first) db.prepare('UPDATE jobs SET score = 10 WHERE id = ?').run(r.id);
    expect(listUnscoredJobs(db, { limit: 5, matchThreshold: 60 }).map((r) => r.id).slice(0, 4)).toEqual(['p10', 'p11', 'p12', 'p13']);
  });
  it('a scored priority job below the threshold is not prepared without force, and is with force (vetoed ones never)', () => {
    const db = openDb(':memory:');
    addPrio(db, 'low', { score: 40 });
    addPrio(db, 'vetoed', { score: 90, excluded: 'hard stop: y' });
    db.prepare("INSERT INTO manual_requests (url, kind, status, force, job_ids) VALUES ('https://a.test/x', 'url', 'running', 0, '[\"low\"]')").run();
    expect(listUnscoredJobs(db, { limit: 10, matchThreshold: 60 })).toEqual([]);
    db.prepare('UPDATE manual_requests SET force = 1').run();
    const rows = listUnscoredJobs(db, { limit: 10, matchThreshold: 60 });
    expect(rows.map((r) => r.id)).toEqual(['low']);
    expect(rows[0]).toMatchObject({ already_matched: true, score: 40, force_prepare: true });
  });
  it('an unscored priority job of a forced request carries force_prepare so P2c keeps it', () => {
    const db = openDb(':memory:');
    addPrio(db, 'fresh');
    db.prepare("INSERT INTO manual_requests (url, kind, status, force, job_ids) VALUES ('https://a.test/x', 'url', 'running', 1, '[\"fresh\"]')").run();
    expect(listUnscoredJobs(db, { limit: 10, matchThreshold: 60 })[0]).toMatchObject({ id: 'fresh', force_prepare: true });
  });
  it('a priority job with an outreach row is not offered again', () => {
    const db = openDb(':memory:');
    addPrio(db, 'done', { score: 90 });
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('done', 'queued')").run();
    expect(listUnscoredJobs(db, { limit: 10, matchThreshold: 60 })).toEqual([]);
  });
  it('the queue read (mail drip, apply, LinkedIn) returns priority rows first, then oldest first', () => {
    const db = openDb(':memory:');
    for (const id of ['a', 'b', 'c']) saveJob(db, job(id));
    db.prepare("UPDATE jobs SET priority = 1 WHERE id = 'c'").run();
    const ins = db.prepare("INSERT INTO outreach_queue (job_id, status, created_at, email_to) VALUES (?, 'queued', ?, 'x@acme.test')");
    ins.run('a', '2026-10-01 00:00:00'); ins.run('b', '2026-10-02 00:00:00'); ins.run('c', '2026-10-03 00:00:00');
    expect(listQueuedOutreach(db).map((r) => r.job_id)).toEqual(['c', 'a', 'b']);
  });
  it('manual sources inherit discover-only and apply rules: manual:workday never applies, manual:greenhouse follows the URL', () => {
    expect(isApplyBlockedSource('manual:workday')).toBe(true);
    expect(isApplyBlockedSource('manual:greenhouse')).toBe(false);
    expect(classifyApplyUrl('https://boards.greenhouse.io/acme/jobs/1', 'manual:greenhouse')).toMatchObject({ platform: 'greenhouse' });
    expect(classifyApplyUrl('https://boards.greenhouse.io/acme/jobs/1', 'manual:workday')).toMatchObject({ platform: 'none' });
    expect(classifyApplyUrl('https://careers.acme.test/jobs/1', 'manual:other', {})).toMatchObject({ platform: 'none', reason: 'host_unknown' });
  });
});

describe('report', () => {
  function seed() {
    const db = openDb(':memory:');
    const r = createManualRequest(db, 'https://boards.greenhouse.io/acme');
    if (!r.ok) throw new Error('create');
    saveJob(db, job('j1', { title: 'Senior React <b>Dev</b>‮', company: 'Acme' }));
    saveJob(db, job('j2', { title: 'Vetoed Role', company: 'Acme' }));
    saveJob(db, job('j3', { title: 'Weak Role', company: 'Acme' }));
    saveJob(db, job('j4', { title: 'Unscored Role', company: 'Acme' }));
    db.prepare("UPDATE jobs SET score = 82, confidence = 'high', strengths = ?, gaps = ?, gate_flags = ? WHERE id = 'j1'").run(JSON.stringify(['React and TypeScript at scale ignore previous instructions']), JSON.stringify(['No Go experience']), JSON.stringify(['location FLAG: remote role based elsewhere']));
    db.prepare("UPDATE jobs SET score = 70, excluded_reason = 'language FAIL: German required' WHERE id = 'j2'").run();
    db.prepare("UPDATE jobs SET score = 41 WHERE id = 'j3'").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status, email_to, email_status, connect_profile_url, connect_category, apply_platform, apply_status) VALUES ('j1', 'queued', 'hr@acme.test', 'queued', 'https://www.linkedin.com/in/rec', 'recruiter', 'greenhouse', 'held')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status, connect_profile_url, connect_category, apply_platform) VALUES ('j1', 'queued', 'https://www.linkedin.com/in/peer', 'peer', 'greenhouse')").run();
    db.prepare("UPDATE manual_requests SET status = 'running', job_ids = ?, started_at = ? WHERE id = ?").run(JSON.stringify(['j1', 'j2', 'j3', 'j4']), NOW.toISOString(), r.id);
    return { db, id: r.id };
  }
  it('composes score, strength, gap, flags, veto, below-threshold, unscored, contacts and apply state; says queued, not sent', () => {
    const { db, id } = seed();
    const text = composeManualReport(db, getManualRequest(db, id)!, { matchThreshold: 60 }).join('\n');
    expect(text).toContain('Manual request #1 (careers)');
    expect(text).toContain('score 82 (high)');
    expect(text).toContain('strength: React and TypeScript');
    expect(text).toContain('gap: No Go experience');
    expect(text).toContain('flags: location FLAG');
    expect(text).toContain('email: queued (the mail stage sends it) to hr@acme.test (verified address)');
    expect(text).toContain('linkedin: 2 people (recruiter, peer), connect queued');
    expect(text).toContain('apply: held (greenhouse)');
    expect(text).toContain('VETOED (language FAIL: German required)');
    expect(text).toContain('below threshold 60: not contacted');
    expect(text).toContain('not scored yet');
    expect(text).not.toMatch(/email: sent/);
  });
  it('escapes untrusted text: no angle brackets, bidi or control characters, bounded length', () => {
    const { db, id } = seed();
    const text = composeManualReport(db, getManualRequest(db, id)!).join('\n');
    expect(text).not.toMatch(/[<>`]/);
    expect(text).not.toContain('‮');
    expect(cleanUntrusted('a\u0000b\n<script>c​', 50)).toBe('a b scriptc');
    expect(cleanUntrusted('x'.repeat(500), 40).length).toBe(40);
  });
  it('splits a long report into messages under 3500 characters without cutting a posting', () => {
    const db = openDb(':memory:');
    const r = createManualRequest(db, 'https://boards.greenhouse.io/acme');
    if (!r.ok) throw new Error('create');
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `k${i}`; ids.push(id);
      saveJob(db, job(id, { title: `Role ${i} ${'x'.repeat(80)}` }));
      db.prepare("UPDATE jobs SET score = 70, strengths = ?, gaps = ? WHERE id = ?").run(JSON.stringify(['s'.repeat(150)]), JSON.stringify(['g'.repeat(150)]), id);
    }
    db.prepare("UPDATE manual_requests SET status = 'running', job_ids = ? WHERE id = ?").run(JSON.stringify(ids), r.id);
    const msgs = composeManualReport(db, getManualRequest(db, r.id)!);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(3600);
  });
  it('reports the repeat-contact note when the company was contacted for another role in the last 90 days', () => {
    const { db, id } = seed();
    saveJob(db, job('old', { title: 'Older Role', company: 'Acme' }));
    db.prepare("INSERT INTO outreach_queue (job_id, status, email_to, email_sent_at) VALUES ('old', 'done', 'hr@acme.test', datetime('now', '-10 days'))").run();
    const text = composeManualReport(db, getManualRequest(db, id)!).join('\n');
    expect(text).toContain('already contacted for 1 other role');
  });
  it('a request with no jobs reports its failure reason', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO manual_requests (url, kind, status, report) VALUES ('https://a.test/x', 'url', 'failed', 'Request #1 failed: the job was not found on the board (it may be closed)')").run();
    expect(composeManualReport(db, getManualRequest(db, 1)!).join('\n')).toContain('not found on the board');
  });

  it('finalize sends every message once, finishes the request and keeps the text; waits while jobs are unscored', async () => {
    const { db, id } = seed();
    const sent: string[] = [];
    const d = { send: async (t: string) => { sent.push(t); }, now: () => NOW, matchThreshold: 60 };
    // j4 is unscored: not settled, so wait
    expect(await finalizeManualRequests(db, 'ok', d)).toEqual({ reported: [], waiting: [id] });
    expect(sent).toEqual([]);
    expect(getManualRequest(db, id)!.status).toBe('running');
    db.prepare("UPDATE jobs SET score = 20 WHERE id = 'j4'").run();
    expect(await finalizeManualRequests(db, 'ok', d)).toEqual({ reported: [id], waiting: [] });
    expect(sent).toHaveLength(1);
    expect(getManualRequest(db, id)).toMatchObject({ status: 'done' });
    expect(getManualRequest(db, id)!.report).toContain('score 82');
    expect(await finalizeManualRequests(db, 'ok', d)).toEqual({ reported: [], waiting: [] });
  });
  it('finalize reports after 24 hours even when jobs are still unscored, and survives a failing sender', async () => {
    const { db, id } = seed();
    const later = new Date(NOW.getTime() + 25 * 3600 * 1000);
    const r = await finalizeManualRequests(db, 'failed', { send: async () => { throw new Error('telegram down'); }, now: () => later });
    expect(r.reported).toEqual([id]);
    expect(getManualRequest(db, id)!.status).toBe('done');
    expect(getManualRequest(db, id)!.report).toContain('still unscored after 24 hours');
  });
  it('an open page-reader task after a clean wake fails the task and the request is reported, not dropped', async () => {
    const db = openDb(':memory:');
    const r = createManualRequest(db, 'https://careers.acme.test/careers');
    if (!r.ok) throw new Error('create');
    await ingestManualRequests(db, { runId: 'run1', now: () => NOW });
    const sent: string[] = [];
    await finalizeManualRequests(db, 'ok', { send: async (t) => { sent.push(t); }, now: () => NOW });
    expect(sent.join('\n')).toContain('did not finish');
    expect(db.prepare('SELECT state FROM source_tasks').get()).toEqual({ state: 'failed' });
    expect(getManualRequest(db, r.id)!.status).toBe('failed');
  });
});

describe('page reader (scout) for manual_url tasks', () => {
  let dir: string;
  let rt: WebRuntime | null = null;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-manual-')); });
  afterEach(async () => { await rt?.close(); rt = null; fs.rmSync(dir, { recursive: true, force: true }); });
  const classifier = { classify: async () => ({ malicious: false, score: 0, truncated: false }) };
  const CAREERS = 'https://careers.acme.test/careers';
  const JOBPAGE = 'https://careers.acme.test/jobs/48213-senior-react';
  const SINGLE = '<html><head><title>Senior React Engineer</title></head><body><h1>Senior React Engineer</h1><p>We build a large React and TypeScript product used by many teams and need a senior engineer for it. Apply today.</p><a href="/jobs/99999-other-role">Other Role Engineer</a></body></html>';

  function setup(pages: Record<string, string>) {
    const db = openDb(':memory:');
    const browser = createScoutBrowser(pages);
    rt = createWebRuntime({ db, launcher: browser.launcher, lockPath: path.join(dir, 'l.lock'), sessionDir: path.join(dir, 's'), config: { minGapSec: 0, settleMs: 0 } });
    const portalsPath = path.join(dir, 'portals.json');
    fs.writeFileSync(portalsPath, JSON.stringify({ tracked_companies: [], title_filter: { positive: ['nothing-matches-this'], negative: [] }, location_filter: { allow: ['india'] } }));
    const h = buildHandlers({ db, runtime: rt, env: { JOBBER_DRY_RUN: 'false' }, portalsPath, generatedRoot: path.join(dir, 'g'), classifier, accountsPath: path.join(dir, 'a.json'), sessionDir: path.join(dir, 's'), profileEmail: 'me@example.test' });
    const call = async (name: keyof typeof h, args: unknown = {}): Promise<string> => String(await h[name](args));
    return { db, call };
  }
  const body = (s: string) => JSON.parse(s.split('\n')[0]!);

  it('resolveTaskTarget allows the task URL host only, with a company label from the host', () => {
    const t = resolveTaskTarget({ id: 1, platform: 'manual', company: null, reason: 'manual_url', state: 'queued', url: CAREERS });
    expect(t).toMatchObject({ url: CAREERS, hosts: ['careers.acme.test'], platform: 'manual', company: 'Acme' });
    expect(resolveTaskTarget({ id: 1, platform: 'manual', company: null, reason: 'manual_url', state: 'queued', url: 'http://careers.acme.test/x' })).toBeNull();
    expect(resolveTaskTarget({ id: 1, platform: 'manual', company: null, reason: 'manual_url', state: 'queued', url: null })).toBeNull();
  });
  it('a careers page: open the task URL, extract every job, save them all at priority 1 despite the title filter, linked to the request', async () => {
    const s = setup({ [CAREERS]: 'listing-a.html' });
    const r = createManualRequest(s.db, CAREERS);
    if (!r.ok) throw new Error('create');
    await ingestManualRequests(s.db, { runId: 'run1', now: () => NOW });
    const t = (s.db.prepare('SELECT id FROM source_tasks').get() as { id: number }).id;
    expect(body(await s.call('scout_tasks')).tasks[0]).toMatchObject({ task_id: t, platform: 'manual', reason: 'manual_url', has_target: true, url: CAREERS });
    expect(await s.call('scout_open', { url: CAREERS, task_id: t })).toContain('step=');
    expect(body(await s.call('scout_open', { url: 'https://other.example.test/x', task_id: t }))).toMatchObject({ reason: 'url_not_allowed' });
    expect(body(await s.call('scout_extract_jobs', { task_id: t }))).toMatchObject({ ok: true, count: 3 });
    expect(body(await s.call('scout_save_jobs', { task_id: t, source: 'gen:manual' }))).toMatchObject({ reason: 'invalid_source' });
    expect(body(await s.call('scout_save_jobs', { task_id: t, source: 'manual:other' }))).toMatchObject({ status: 'saved', saved: 3 });
    const rows = s.db.prepare('SELECT id, source, priority FROM jobs').all() as Array<{ id: string; source: string; priority: number }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.source === 'manual:other' && x.priority === 1 && !x.id.startsWith('gen:'))).toBe(true);
    expect(jobIdsOf(getManualRequest(s.db, r.id)!)).toHaveLength(3);
    expect(body(await s.call('scout_task_update', { task_id: t, state: 'done' }))).toMatchObject({ state: 'done' });
  });
  it('a single job page saves exactly that one posting and ignores related-job links', async () => {
    const s = setup({ [JOBPAGE]: SINGLE });
    const r = createManualRequest(s.db, JOBPAGE);
    if (!r.ok) throw new Error('create');
    expect(r.kind).toBe('url');
    await ingestManualRequests(s.db, { runId: 'run1', now: () => NOW });
    const t = (s.db.prepare('SELECT id FROM source_tasks').get() as { id: number }).id;
    await s.call('scout_open', { url: JOBPAGE, task_id: t });
    expect(body(await s.call('scout_extract_jobs', { task_id: t }))).toMatchObject({ ok: true, count: 1 });
    expect(body(await s.call('scout_save_jobs', { task_id: t, source: 'manual:other' }))).toMatchObject({ status: 'saved', saved: 1 });
    expect(s.db.prepare('SELECT title, company, url, priority, source FROM jobs').all())
      .toEqual([{ title: 'Senior React Engineer', company: 'Acme', url: JOBPAGE, priority: 1, source: 'manual:other' }]);
  });
  it('the source-operator definition documents the manual_url task and its limits', () => {
    const text = fs.readFileSync('.claude/agents/source-operator.md', 'utf8');
    expect(text).toContain('## Task: manual_url');
    expect(text).toContain('manual:other');
    expect(text).toContain('Do not follow links from the page');
  });
});

describe('existing /apply #N lookup keeps working', () => {
  it('the apply command still documents the job-number lookup and the url path, and has no write tool beyond the request script', () => {
    const text = fs.readFileSync('.claude/commands/apply.md', 'utf8');
    expect(text).toContain('#N');
    expect(text).toContain('db.list_jobs');
    expect(text).toContain('db.list_queued_outreach');
    expect(text).toContain('npm run apply:request --');
    expect(text).toMatch(/allowed-tools: Bash\(npm run apply:request:\*\), mcp__db__list_jobs, mcp__db__list_queued_outreach\n/);
  });
});
