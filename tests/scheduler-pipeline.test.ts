import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, listUnscoredJobs, saveMatchResultsChecked, MATCH_FAIL_LIMIT, PREP_OFFER_LIMIT, UNSCORED_DESCRIPTION_CHARS, unscoredDescriptionCap, type Job } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import type { PacingConfig } from '../src/outreach/pacing.js';
import type { CeilingStatus, LimitKey } from '../src/outreach/limits.js';
import type { ControlState } from '../src/scheduler/control.js';
import { countDue, SCRIPT_DISCOVER_KEY, type DueCounts } from '../src/scheduler/due.js';
import { planWake, stepOrder, PIPELINE_MAX_JOBS_PER_WAKE_CEILING, PIPELINE_WINDOW_HOURS, PIPELINE_MAX_PREPARE_PER_WAKE, PIPELINE_LIST_PAGE, type PlanKnobs, type WakeDecision } from '../src/scheduler/plan.js';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import { runCodePass, statusLines, pipelineLines, targetRegionsLine, loadHuntPreferences, DEFAULT_HUNT_ROLE, DEFAULT_HUNT_LOCATION, type CodePassResult } from '../src/scheduler/pipeline.js';
import { wakeOnce, type DriverDeps } from '../src/scheduler/driver.js';
import type { LaunchHandle, LaunchPlan, Launcher, PollResult } from '../src/scheduler/launch.js';
import { getState } from '../src/scheduler/runLog.js';
import { resetSourceStatusForTests } from '../src/sources/status.js';

const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
const pacing: PacingConfig = {
  quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330,
  minBurst: 1, maxBurst: 4, minActionGapSec: 120, maxActionGapSec: 360,
  minWaitMin: 8, maxWaitMin: 40, jitter: 0.25,
};
const knobs: PlanKnobs = { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 };
const ctl = (): ControlState => ({
  killed: false, killReason: null, halted: { linkedin: null, naukri: null, wellfound: null }, allowed: ['linkedin', 'naukri'], readError: null,
});
const ceil = (): Record<LimitKey, CeilingStatus> =>
  Object.fromEntries(
    ['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message', 'linkedin_discover'].map((k) => [k, { used: 0, limit: 5, ok: true }]),
  ) as Record<LimitKey, CeilingStatus>;
const due = (o: Partial<DueCounts> = {}): DueCounts => ({
  followupsDue: 0, newOutreachReady: 0,
  followupsDueByPlatform: { linkedin: 0, naukri: 0 }, newOutreachReadyByPlatform: { linkedin: 0, naukri: 0 },
  inboxLastCheckedMinAgo: 5, naukriSearchLastHoursAgo: 1, ...o,
});
const NAMES = { jobs: ['react'], posts: [], naukri: ['react-india'] };
const plan = (o: Partial<Parameters<typeof planWake>[0]> = {}): WakeDecision =>
  planWake({ now: NOW, rng: () => 0.99, pacing, control: ctl(), ceilings: ceil(), due: due(), knobs, discoverSearches: NAMES, codePassEnabled: true, ...o });
const run = (d: WakeDecision): Extract<WakeDecision, { kind: 'run' }> => {
  if (d.kind !== 'run') throw new Error(`expected run, got ${JSON.stringify(d)}`);
  return d;
};
const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, source: 'greenhouse', title: 'React Developer', company: `Co ${id}`, url: `https://example.test/${id}`, apply_url: `https://boards.greenhouse.io/x/jobs/${id}`, description: 'd', ...o,
});

describe('planner emits the wake in order', () => {
  it('code pass, source-operator, discover, pipeline, then the platform operators (no mail stage)', () => {
    const d = run(plan({
      due: due({
        scriptDiscoverLastHoursAgo: null, sourceTasksQueued: 3, unmatchedJobs: 4, emailQueued: 2, emailFollowupsReady: 1,
        linkedinDiscoverLastHoursAgo: null, naukriSearchLastHoursAgo: null,
        newOutreachReady: 1, newOutreachReadyByPlatform: { linkedin: 1, naukri: 0 }, inboxLastCheckedMinAgo: null,
      }),
    }));
    const order = stepOrder(d).map((s) => `${s.operator}:${s.kind}`);
    expect(order).toEqual([
      'code:discover_scripts',
      'source-operator:discover_agent',
      'linkedin-operator:discover',
      'naukri-operator:discover',
      'pipeline:pipeline',
      'linkedin-operator:inbox',
      'linkedin-operator:new_outreach',
      'naukri-operator:inbox',
    ]);
    expect(d.stages?.find((s) => s.kind === 'discover_agent')?.quota).toBe(3);
    expect(d.stages?.some((s) => s.kind === 'mail')).toBe(false);
  });

  it('a script pass alone plans no agent task except the pipeline-pulled linkedin new_outreach, then the pipeline stage', () => {
    const d = run(plan({ due: due({ scriptDiscoverLastHoursAgo: 7, inboxLastCheckedMinAgo: 1 }) }));
    expect(d.tasks.map((a) => [a.platform, a.tasks.map((t) => t.kind)])).toEqual([['linkedin', ['new_outreach']]]);
    expect(d.stages?.map((s) => s.kind)).toEqual(['discover_scripts', 'pipeline']);
    expect(d.stages?.[0].operator).toBe('code');
  });

  it('nothing is planned from fields that are not tracked, and a recent code pass is not due', () => {
    expect(plan({ due: due({ inboxLastCheckedMinAgo: 1 }) })).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
    expect(plan({ due: due({ scriptDiscoverLastHoursAgo: 2, inboxLastCheckedMinAgo: 1 }) })).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
  });

  it('without the code pass seam no discover_scripts stage is planned', () => {
    const d = plan({ codePassEnabled: false, due: due({ scriptDiscoverLastHoursAgo: null, inboxLastCheckedMinAgo: 1 }) });
    expect(d).toMatchObject({ kind: 'skip' });
  });

  it('unscored jobs pull in the pipeline only, queued email alone plans nothing (the drip lane sends it)', () => {
    const a = run(plan({ due: due({ unmatchedJobs: 2, inboxLastCheckedMinAgo: 1 }) }));
    expect(a.stages?.map((s) => s.kind)).toEqual(['pipeline']);
    expect(plan({ due: due({ emailQueued: 2, inboxLastCheckedMinAgo: 1 }) })).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
  });

  it('email follow-ups pull in the pipeline stage so the reply check runs first', () => {
    const d = run(plan({ due: due({ emailFollowupsReady: 1, inboxLastCheckedMinAgo: 1 }) }));
    expect(d.stages?.map((s) => s.kind)).toEqual(['pipeline']);
  });

  it('a halted platform still gets the code pass only when something is allowed', () => {
    const c: ControlState = { ...ctl(), allowed: [], halted: { linkedin: 'x', naukri: 'y', wellfound: null } };
    expect(plan({ control: c, due: due({ scriptDiscoverLastHoursAgo: null }) })).toMatchObject({ kind: 'skip', reason: 'halted' });
  });
});

describe('countDue new fields', () => {
  it('counts unscored jobs, queued emails and source tasks, ignoring the daily dead-slug error rows', () => {
    const db = openDb(':memory:');
    const t = NOW.toISOString();
    db.prepare("INSERT INTO jobs (id, source, title, company, created_at) VALUES ('a','greenhouse','t','c','2026-10-15 07:00:00'), ('b','greenhouse','t','c','2026-10-15 07:00:00')").run();
    db.prepare("UPDATE jobs SET score = 70 WHERE id = 'b'").run();
    db.prepare("INSERT INTO outreach_queue (job_id, email_to, status) VALUES ('a','x@co.test','queued')").run();
    db.prepare("INSERT INTO source_tasks (platform, company, reason, state, created_at, updated_at) VALUES ('greenhouse','deadco','error','queued',?,?), ('greenhouse',NULL,'shape','queued',?,?), ('naukri',NULL,'error','queued',?,?)").run(t, t, t, t, t, t);
    const c = countDue(db, NOW, loadTuning({}), {});
    expect(c.unmatchedJobs).toBe(1);
    expect(c.emailQueued).toBe(1);
    expect(c.sourceTasksQueued).toBe(2); // the per-company error row is noise
    expect(c.scriptDiscoverLastHoursAgo).toBeNull();
    expect(c.emailFollowupsReady).toBe(0);
  });
});

describe('matched backlog makes the pipeline due', () => {
  const addScored = (db: ReturnType<typeof openDb>, id: string, score: number, o: { offers?: number; excluded?: string } = {}) => {
    db.prepare("INSERT INTO jobs (id, source, title, company, created_at, score, prep_offers, excluded_reason, company_key, title_key) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, 'greenhouse', `T${id}`, `C${id}`, '2026-09-01 00:00:00', score, o.offers ?? 0, o.excluded ?? null, `c${id}`, `t${id}`);
  };
  it('countDue counts matched jobs without an outreach row, not exhausted, not excluded, with the threshold from env', () => {
    const db = openDb(':memory:');
    addScored(db, 'ok', 80);
    addScored(db, 'low', 40);
    addScored(db, 'spent', 80, { offers: PREP_OFFER_LIMIT });
    addScored(db, 'vetoed', 80, { excluded: 'x' });
    addScored(db, 'queued', 80);
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('queued','queued')").run();
    const c = countDue(db, NOW, loadTuning({}), {});
    expect(c.matchedAwaitingPrepare).toBe(1);
    expect(c.unmatchedJobs).toBe(0);
    expect(countDue(db, NOW, loadTuning({}), { MATCH_THRESHOLD: '30' }).matchedAwaitingPrepare).toBe(2);
  });
  it('a planner with only a matched backlog plans the pipeline; none or exhausted does not', () => {
    const d = run(plan({ due: due({ matchedAwaitingPrepare: 9, inboxLastCheckedMinAgo: 1 }) }));
    expect(d.stages?.find((s) => s.kind === 'pipeline')?.quota).toBe(9);
    expect(plan({ due: due({ matchedAwaitingPrepare: 0, inboxLastCheckedMinAgo: 1 }) })).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
    const db = openDb(':memory:');
    addScored(db, 'spent', 80, { offers: PREP_OFFER_LIMIT });
    const c = countDue(db, NOW, loadTuning({}), {});
    expect(c.matchedAwaitingPrepare).toBe(0);
    expect(plan({ due: { ...c, scriptDiscoverLastHoursAgo: 1, inboxLastCheckedMinAgo: 1, naukriSearchLastHoursAgo: 1, linkedinDiscoverLastHoursAgo: 1 } })).toMatchObject({ kind: 'skip' });
  });
  it('the quota adds both kinds and stays capped', () => {
    const d = run(plan({ due: due({ unmatchedJobs: 3, matchedAwaitingPrepare: 4, inboxLastCheckedMinAgo: 1 }) }));
    expect(d.stages?.find((s) => s.kind === 'pipeline')?.quota).toBe(7);
    const big = run(plan({ due: due({ unmatchedJobs: 300, matchedAwaitingPrepare: 300, inboxLastCheckedMinAgo: 1 }) }));
    expect(big.stages?.find((s) => s.kind === 'pipeline')?.quota).toBe(PIPELINE_MAX_JOBS_PER_WAKE_CEILING);
  });
  it('the P1 prompt says to run the matched call first even with 0 unscored jobs', () => {
    const t = pipelineLines({ matchThreshold: 60, sendLimit: 1, targetRegions: 'T', followupsAutonomous: false }).join('\n');
    expect(t).toMatch(/even when there are 0 unscored/i);
  });
});

describe('runCodePass', () => {
  it('saves new jobs, records the run with finishRun (streak advances) and stamps the state', async () => {
    resetSourceStatusForTests();
    const db = openDb(':memory:');
    let calls = 0;
    const fake = async () => {
      calls++;
      return {
        jobs: [job('j1'), job('j2')], rows: [],
        outcomes: [
          { id: 'greenhouse', fetched: 2, kept: 2, shape_hash: 'h1' },
          { id: 'remotive', fetched: 0, kept: 0, error: 'timeout', fallback_used: true },
        ],
      };
    };
    const r1 = await runCodePass({ db, now: () => NOW, run: fake });
    expect(r1.ok).toBe(true);
    expect(r1.newJobs).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT new_count, streak_fail, shape_hash FROM platform_status WHERE id = 'greenhouse'").get()).toEqual({ new_count: 2, streak_fail: 0, shape_hash: 'h1' });
    expect(db.prepare("SELECT streak_fail, fallback_used FROM platform_status WHERE id = 'remotive'").get()).toEqual({ streak_fail: 1, fallback_used: 1 });
    expect(getState(db, SCRIPT_DISCOVER_KEY)).toBe(NOW.toISOString());
    expect(r1.sourceStatusLine).toMatch(/^SOURCE_STATUS: \{/);
    expect(r1.sourceStatusLine).toContain('remotive');
    const r2 = await runCodePass({ db, now: () => NOW, run: fake });
    expect(calls).toBe(2);
    expect(r2.newJobs).toBe(0); // already seen
    expect(db.prepare("SELECT streak_fail FROM platform_status WHERE id = 'remotive'").get()).toEqual({ streak_fail: 2 });
  });

  it('never throws: a failing runner is a redacted error and the state is not stamped', async () => {
    const db = openDb(':memory:');
    const r = await runCodePass({ db, now: () => NOW, run: async () => { throw new Error('boom https://x.test/?api_key=SECRET123'); } });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('SECRET123');
    expect(getState(db, SCRIPT_DISCOVER_KEY)).toBeNull();
  });

  it('statusLines is empty before any run', () => {
    resetSourceStatusForTests();
    expect(statusLines(openDb(':memory:')).sourceStatusLine).toBe('');
  });
});

describe('prompt', () => {
  const pipe = { matchThreshold: 60, sendLimit: 1, targetRegions: 'Target regions: home=India; targets=UAE', followupsAutonomous: false };
  it('lists the wake order and the pipeline instructions; the wake only enqueues email', () => {
    const d = run(plan({ due: due({ scriptDiscoverLastHoursAgo: null, sourceTasksQueued: 1, inboxLastCheckedMinAgo: null }) }));
    const p = buildWakePrompt({
      runId: 'r1', dryRun: true, burst: d.burst, tasks: d.tasks, budget: { maxWallSec: 900, maxTokensApprox: 150000 },
      allowed: ['linkedin', 'naukri'], now: NOW, order: stepOrder(d), pipeline: pipe,
    });
    expect(p).toContain('Wake order');
    expect(p.indexOf('discover_scripts')).toBeLessThan(p.indexOf('`source-operator`'));
    expect(p.indexOf('`source-operator`')).toBeLessThan(p.indexOf('Pipeline stage'));
    expect(p).toContain('Do NOT dispatch `mail-operator`');
    expect(p).not.toContain('Dispatch `mail-operator`');
    expect(p).toContain('SOURCE_STATUS:');
    expect(p).toContain('BOARD_STATUS:');
    expect(p).toContain('Target regions: home=India');
    expect(p).not.toContain('SEND_LIMIT_PER_RUN=1');
  });
  it('names the discover searches in the ordered wake prompt', () => {
    const d = run(plan({ due: due({ linkedinDiscoverLastHoursAgo: null, naukriSearchLastHoursAgo: null }) }));
    const p = buildWakePrompt({
      runId: 'r1', dryRun: true, burst: d.burst, tasks: d.tasks, budget: { maxWallSec: 900, maxTokensApprox: 150000 },
      allowed: ['linkedin', 'naukri'], now: NOW, order: stepOrder(d), pipeline: pipe,
    });
    expect(p).toContain('job searches: react; post searches: none');
    expect(p).toContain('searches: react-india; quota is the job pages you may open for descriptions');
  });
  it('the pipeline keeps the veto-gate stop rule and the threshold', () => {
    const t = pipelineLines(pipe).join('\n');
    expect(t).toContain('at least 60');
    expect(t).toContain('STOP the pipeline');
    expect(t).toContain('batches of at most 5');
    expect(t).toContain('contact-finder');
    expect(t).toContain('outreach-preparer');
    expect(t).toContain('legacy mode');
    expect(pipelineLines({ ...pipe, followupsAutonomous: true }).join('\n')).toContain('followup-drafter');
  });
  it('target regions line says so for a missing file', () => {
    expect(targetRegionsLine(join(tmpdir(), 'jobber-no-such-dir'))).toContain('missing or invalid');
  });
});

describe('list_unscored_jobs', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
  const add =(db: ReturnType<typeof openDb>, id: string, o: Record<string, unknown> = {}) => {
    db.prepare("INSERT INTO jobs (id, source, title, company, url, apply_url, description, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, o.source ?? 'greenhouse', 'React Dev', o.company ?? 'Acme', 'https://x.test/u', o.apply_url ?? 'https://boards.greenhouse.io/a/jobs/1', 'Location: Remote\n\nbody', o.at ?? '2026-10-14 10:00:00');
  };
  it('returns full rows oldest first, skipping scored, excluded and given-up jobs', () => {
    const db = openDb(':memory:');
    add(db, 'new', { at: '2026-10-15 02:00:00' });
    add(db, 'old', { at: '2026-10-14 10:00:00' });
    add(db, 'scored'); db.prepare("UPDATE jobs SET score = 70 WHERE id = 'scored'").run();
    add(db, 'vetoed'); db.prepare("UPDATE jobs SET excluded_reason = 'x' WHERE id = 'vetoed'").run();
    add(db, 'gaveup');
    for (let i = 0; i < MATCH_FAIL_LIMIT; i++) saveMatchResultsChecked(db, [{ job_id: 'gaveup', error: 'overflow' } as never]);
    const rows = listUnscoredJobs(db, { limit: 25 });
    expect(rows.map((r) => r.id)).toEqual(['old', 'new']);
    expect(rows[0]).toMatchObject({ source: 'greenhouse', company: 'Acme', apply_url: 'https://boards.greenhouse.io/a/jobs/1', description: 'Location: Remote\n\nbody', url: 'https://x.test/u' });
    expect(countDue(db, NOW, loadTuning({}), {}).unmatchedJobs).toBe(2);
    expect(listUnscoredJobs(db, { limit: 1 })).toHaveLength(1);
  });
  it('offers matched jobs without an outreach row first, marked already_matched, at most PREP_OFFER_LIMIT times', () => {
    const db = openDb(':memory:');
    add(db, 'fresh', { at: '2026-10-14 10:00:00' });
    add(db, 'pending', { at: '2026-10-15 01:00:00' }); db.prepare("UPDATE jobs SET score = 74 WHERE id = 'pending'").run();
    add(db, 'low'); db.prepare("UPDATE jobs SET score = 59 WHERE id = 'low'").run();
    add(db, 'queued'); db.prepare("UPDATE jobs SET score = 80 WHERE id = 'queued'").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('queued', 'queued')").run();
    add(db, 'vetoed'); db.prepare("UPDATE jobs SET score = 80, excluded_reason = 'x' WHERE id = 'vetoed'").run();
    const first = listUnscoredJobs(db, { limit: 10, matchThreshold: 60 });
    expect(first.map((r) => r.id)).toEqual(['pending', 'fresh']);
    expect(first[0]).toMatchObject({ already_matched: true, score: 74 });
    expect(first[1].already_matched).toBeUndefined();
    for (let n = 1; n < PREP_OFFER_LIMIT; n++) expect(listUnscoredJobs(db, { limit: 10, matchThreshold: 60 }).map((r) => r.id)).toEqual(['pending', 'fresh']);
    expect(listUnscoredJobs(db, { limit: 10, matchThreshold: 60 }).map((r) => r.id)).toEqual(['fresh']);
    expect(listUnscoredJobs(db, { limit: 10 }).map((r) => r.id)).toEqual(['fresh']);
  });
  it('hands back at most half the batch as already matched so new jobs are still matched', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 6; i++) { add(db, `m${i}`); db.prepare('UPDATE jobs SET score = 70 WHERE id = ?').run(`m${i}`); }
    add(db, 'fresh');
    const rows = listUnscoredJobs(db, { limit: 4, matchThreshold: 60 });
    expect(rows.filter((r) => r.already_matched)).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain('fresh');
  });
  it('does not let one source starve the others: unscored jobs are taken round-robin by source, oldest first within a source', () => {
    const db = openDb(':memory:');
    add(db, 'g1', { at: '2026-10-14 10:00:00' });
    add(db, 'g2', { at: '2026-10-14 11:00:00' });
    add(db, 'g3', { at: '2026-10-14 12:00:00' });
    add(db, 'n1', { source: 'naukri', apply_url: 'https://www.naukri.com/job-listings-x', at: '2026-10-15 03:00:00' });
    expect(listUnscoredJobs(db, { limit: 2 }).map((r) => r.id)).toEqual(['g1', 'n1']);
    expect(listUnscoredJobs(db, { limit: 4 }).map((r) => r.id)).toEqual(['g1', 'n1', 'g2', 'g3']);
  });
  it('one rejection is not enough to give up', () => {
    const db = openDb(':memory:');
    add(db, 'a');
    saveMatchResultsChecked(db, [{ job_id: 'a', error: 'overflow' } as never]);
    expect(listUnscoredJobs(db)).toHaveLength(1);
  });
  it('caps the description handed to the wake so 25 jobs fit one tool result, and leaves the stored text alone', () => {
    const db = openDb(':memory:');
    add(db, 'big');
    add(db, 'small');
    db.prepare("UPDATE jobs SET description = ? WHERE id = 'big'").run('x'.repeat(30000));
    db.prepare("UPDATE jobs SET description = ? WHERE id = 'small'").run('short body');
    const rows = Object.fromEntries(listUnscoredJobs(db).map((r) => [r.id, r]));
    expect(rows.big.description.length).toBeLessThanOrEqual(UNSCORED_DESCRIPTION_CHARS);
    expect(rows.big.description_truncated).toBe(true);
    expect(rows.small.description).toBe('short body');
    expect(rows.small.description_truncated).toBeUndefined();
    expect((db.prepare("SELECT length(description) AS n FROM jobs WHERE id = 'big'").get() as { n: number }).n).toBe(30000);
    expect(JSON.stringify(listUnscoredJobs(db, { limit: 25 })).length).toBeLessThan(25 * (UNSCORED_DESCRIPTION_CHARS + 1500));
  });
  it('a full wake batch of oversized postings serializes under 30000 characters (one tool result: 22KB passed, 54KB did not)', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < PIPELINE_LIST_PAGE; i++) {
      add(db, `j${i}`);
      db.prepare('UPDATE jobs SET description = ? WHERE id = ?').run('y'.repeat(50000), `j${i}`);
    }
    expect(JSON.stringify(listUnscoredJobs(db, { limit: PIPELINE_LIST_PAGE, kind: 'unscored' })).length).toBeLessThan(30000);
    expect(PIPELINE_MAX_PREPARE_PER_WAKE).toBe(15);
    expect(PIPELINE_LIST_PAGE * Math.ceil(PIPELINE_MAX_JOBS_PER_WAKE_CEILING / PIPELINE_LIST_PAGE)).toBe(PIPELINE_MAX_JOBS_PER_WAKE_CEILING);
  });
  it('the description cap shrinks with the batch size and never exceeds the maximum or drops below the floor', () => {
    expect(unscoredDescriptionCap(10)).toBe(UNSCORED_DESCRIPTION_CHARS);
    expect(unscoredDescriptionCap(1)).toBe(UNSCORED_DESCRIPTION_CHARS);
    expect(unscoredDescriptionCap(25)).toBeLessThan(UNSCORED_DESCRIPTION_CHARS);
    expect(unscoredDescriptionCap(25)).toBeGreaterThanOrEqual(500);
    expect(unscoredDescriptionCap(100)).toBe(500);
  });
  it('a full 25-job wake batch keeps small postings whole and still serializes under 30000 characters', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 25; i++) { add(db, `k${i}`); db.prepare('UPDATE jobs SET description = ? WHERE id = ?').run('z'.repeat(400), `k${i}`); }
    const rows = listUnscoredJobs(db, { limit: 25 });
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => r.description.length === 400 && !r.description_truncated)).toBe(true);
  });
  it('at most half of a 25-job batch is already_matched; the rest is round-robin by source', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 20; i++) { add(db, `m${i}`); db.prepare('UPDATE jobs SET score = 80 WHERE id = ?').run(`m${i}`); }
    for (let i = 0; i < 20; i++) add(db, `u${i}`);
    const rows = listUnscoredJobs(db, { limit: 25, matchThreshold: 60 });
    expect(rows).toHaveLength(25);
    expect(rows.filter((r) => r.already_matched)).toHaveLength(12);
    expect(rows.filter((r) => !r.already_matched)).toHaveLength(13);
  });
  it('kind matched returns only already-matched jobs up to the full limit; kind unscored pages through the round-robin order', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 20; i++) { add(db, `m${i}`, { at: `2026-10-14 10:${String(i).padStart(2, '0')}:00` }); db.prepare('UPDATE jobs SET score = ? WHERE id = ?').run(60 + i, `m${i}`); }
    for (let i = 0; i < 7; i++) add(db, `g${i}`, { at: `2026-10-15 01:0${i}:00` });
    for (let i = 0; i < 3; i++) add(db, `n${i}`, { source: 'naukri', apply_url: 'https://www.naukri.com/job-listings-x', at: `2026-10-15 02:0${i}:00` });
    const m = listUnscoredJobs(db, { kind: 'matched', limit: 15, matchThreshold: 60 });
    expect(m).toHaveLength(15);
    expect(m.every((r) => r.already_matched)).toBe(true);
    expect(m[0].id).toBe('m19');
    const p0 = listUnscoredJobs(db, { kind: 'unscored', limit: 4, offset: 0, matchThreshold: 60 }).map((r) => r.id);
    const p1 = listUnscoredJobs(db, { kind: 'unscored', limit: 4, offset: 4 }).map((r) => r.id);
    const p2 = listUnscoredJobs(db, { kind: 'unscored', limit: 4, offset: 8 }).map((r) => r.id);
    expect(p0).toEqual(['g0', 'n0', 'g1', 'n1']);
    expect([...p0, ...p1, ...p2]).toEqual(listUnscoredJobs(db, { kind: 'unscored', limit: 12 }).map((r) => r.id));
    expect(new Set([...p0, ...p1, ...p2]).size).toBe(10);
    expect(p2).toHaveLength(2);
  });
  it('matched jobs deferred past the prepare cap stay offered for PREP_OFFER_LIMIT wakes, highest score first', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 30; i++) { add(db, `d${i}`); db.prepare('UPDATE jobs SET score = ? WHERE id = ?').run(60 + i, `d${i}`); }
    const w1 = listUnscoredJobs(db, { kind: 'matched', limit: 15, matchThreshold: 60 }).map((r) => r.id);
    const w2 = listUnscoredJobs(db, { kind: 'matched', limit: 15, matchThreshold: 60 }).map((r) => r.id);
    expect(w1).toEqual(w2);
    expect(w1[0]).toBe('d29');
  });
  it('apply_class is deterministic from channelsFor', () => {
    const db = openDb(':memory:');
    add(db, 'gh');
    add(db, 'wd', { source: 'workday', apply_url: 'https://t.myworkdayjobs.com/x' });
    add(db, 'odd', { source: 'remotive', apply_url: 'https://acme.example/j' });
    const by = Object.fromEntries(listUnscoredJobs(db).map((r) => [r.id, r.apply_class]));
    expect(by).toEqual({ gh: 'apply_capable', wd: 'discover_only_source', odd: 'apply_tier:unknown_host' });
    expect(listUnscoredJobs(db)[0].channels.map((c) => c.channel)).toEqual(['email', 'linkedin', 'naukri', 'apply']);
  });
  it('the pipeline quota is every unscored job of the window, capped only by the safety ceiling', () => {
    const d = run(plan({ due: due({ unmatchedJobs: 250, inboxLastCheckedMinAgo: 1 }) }));
    expect(d.stages?.find((s) => s.kind === 'pipeline')?.quota).toBe(250);
    const big = run(plan({ due: due({ unmatchedJobs: 5000, inboxLastCheckedMinAgo: 1 }) }));
    expect(big.stages?.find((s) => s.kind === 'pipeline')?.quota).toBe(PIPELINE_MAX_JOBS_PER_WAKE_CEILING);
    expect(PIPELINE_MAX_JOBS_PER_WAKE_CEILING).toBe(400);
    expect(PIPELINE_WINDOW_HOURS).toBe(24);
  });
  it('P1 names the tool, the cap and apply_class; the direct-call list names every tool used', () => {
    const t = pipelineLines({ matchThreshold: 60, sendLimit: 1, targetRegions: 'T', followupsAutonomous: false }).join('\n');
    expect(t).toContain('`db.list_unscored_jobs({kind: "matched", limit: 15, match_threshold: 60})`');
    expect(t).toContain('`db.list_unscored_jobs({kind: "unscored", limit: 20, offset: 0})`');
    expect(t).toContain('already_matched');
    expect(t).toContain('apply_class');
    expect(t).toContain('EVERY unscored job saved in the last 24 hours');
    expect(t).toContain('KEEP PAGING');
    expect(t).toContain('fewer than 20 rows');
    expect(t).toContain('never reading more than 400 jobs');
    expect(t).toContain('running low on wall time or tokens');
    expect(t).toContain('the unscored jobs simply wait for the next wake');
    expect(t).toContain('never skip the veto step (P2b) for the jobs you did score');
    expect(t).toContain('duplicates of a job already considered');
    expect(t).not.toContain('at most 100 per wake');
    expect(t).toContain('WAVES of at most 6 matchers');
    expect(t).toContain('wait for the whole wave');
    expect(t).toContain('batches of at most 5');
    expect(t).toContain('not windowed');
    expect(t).toContain('never uses a slot');
    expect(t).toContain('only the first 15');
    expect(t).toContain('offered again next wake as already_matched');
    for (const c of ['db.sweep_deadlines', 'db.list_unscored_jobs', 'db.save_match_result', 'gates.apply_vetoes', 'db.mark_excluded', 'job-fetch.source_status', 'job-fetch.board_status']) {
      expect(t.split('\n')[0]).toContain(`\`${c}\``);
    }
  });
});

describe('preferences and target regions from files', () => {
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'pipe-pref-')); return d; };
  it('reads Role and Location from the CLAUDE.md bullets, constants otherwise', () => {
    const d = tmp();
    try {
      expect(loadHuntPreferences(d)).toEqual({ role: DEFAULT_HUNT_ROLE, location: DEFAULT_HUNT_LOCATION });
      writeFileSync(join(d, 'CLAUDE.md'), '- **Role**: `backend engineer`\n- **Location**: `germany`\n');
      expect(loadHuntPreferences(d)).toEqual({ role: 'backend engineer', location: 'germany' });
      writeFileSync(join(d, 'CLAUDE.md'), '- **Role**: `staff dev`\n');
      expect(loadHuntPreferences(d)).toEqual({ role: 'staff dev', location: DEFAULT_HUNT_LOCATION });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('the code pass hands the file preferences to the runner', async () => {
    const d = tmp();
    try {
      writeFileSync(join(d, 'CLAUDE.md'), '- **Role**: `qa lead`\n- **Location**: `spain`\n');
      let seen: { role?: string; location?: string } = {};
      await runCodePass({ db: openDb(':memory:'), projectRoot: d, run: async (_db, o) => { seen = o; return { jobs: [], rows: [], outcomes: [] }; } });
      expect(seen).toMatchObject({ role: 'qa lead', location: 'spain' });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('target regions come from config/target-regions.json, with no hidden default list', () => {
    const d = tmp();
    try {
      expect(targetRegionsLine(d)).toContain('missing or invalid');
      mkdirSync(join(d, 'config'));
      writeFileSync(join(d, 'config', 'target-regions.json'), JSON.stringify({ home: ['Peru'], targets: ['Lima'], remote: true, remote_anywhere: false }));
      expect(targetRegionsLine(d)).toBe('Target regions: home=Peru; targets=Lima; remote OK=true; remote anywhere=false');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('driver runs the code pass before the model session', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  class Fake implements Launcher {
    starts: LaunchPlan[] = [];
    log: string[];
    constructor(log: string[]) { this.log = log; }
    async start(plan: LaunchPlan): Promise<LaunchHandle> {
      this.log.push('launch');
      this.starts.push(plan);
      return { runId: plan.runId, session: plan.session, window: `wake-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
    }
    async poll(): Promise<PollResult> { return { exited: true, exitCode: 0, newOutput: '' }; }
    async kill(): Promise<void> {}
  }
  function harness(codePass?: DriverDeps['codePass']) {
    const dir = mkdtempSync(join(tmpdir(), 'sched-pipe-'));
    dirs.push(dir);
    const log: string[] = [];
    const launcher = new Fake(log);
    const notices: string[] = [];
    let t = NOW.getTime();
    const advance = (ms: number): void => { t += ms; };
    const d: DriverDeps = {
      db: openDb(':memory:'), now: () => new Date(t), rng: () => 0.5, sleep: async (ms) => { t += ms; },
      cfg: loadOutreachConfig({}), tuning: loadTuning({}), env: {}, lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'),
      runDir: join(dir, 'runs'), projectRoot: dir, launcher, notifier: { notify: async (n) => void notices.push(n.title) },
      newRunId: () => 'runpipe00000001', pollMs: 5000, verifyCompletion: false, // these fakes write no stream-json

      codePass: codePass ? async () => { log.push('code'); return codePass(); } : undefined,
    };
    return { d, log, launcher, notices, advance };
  }
  const okPass = async (): Promise<CodePassResult> => ({ ok: true, fetched: 3, newJobs: 2, outcomes: [], boardStatusLine: 'BOARD_STATUS: {"x":1}', sourceStatusLine: 'SOURCE_STATUS: {"y":2}' });

  it('code pass first, then launch, with the result in the prompt', async () => {
    const h = harness(okPass);
    const r = await wakeOnce(h.d);
    expect(r.status).toBe('ok');
    expect(h.log).toEqual(['code', 'launch']);
    const prompt = h.launcher.starts[0].prompt;
    expect(prompt).toContain('Wake order');
    expect(prompt).toContain('Code pass result: ok=true, fetched 3, new 2');
    expect(prompt).toContain('SOURCE_STATUS: {"y":2}');
  });
  it('the wall budget starts after the code pass', async () => {
    const h = harness(async () => { h.advance(3 * 3600_000); return okPass(); });
    const r = await wakeOnce(h.d);
    expect(r.status).toBe('ok');
  });
  it('a failing or throwing code pass is noticed and the wake still runs', async () => {
    const h = harness(async () => { throw new Error('nope'); });
    const r = await wakeOnce(h.d);
    expect(r.status).toBe('ok');
    expect(h.log).toEqual(['code', 'launch']);
    expect(h.notices).toContain('scheduler code pass failed');
  });
  it('no code pass seam: the legacy prompt, no stage', async () => {
    const h = harness();
    await wakeOnce(h.d);
    expect(h.launcher.starts[0].prompt).not.toContain('Wake order');
  });
});
