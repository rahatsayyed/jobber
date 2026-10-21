import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, listUnscoredJobs, saveMatchResultsChecked, MATCH_FAIL_LIMIT, UNSCORED_DESCRIPTION_CHARS, type Job } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import type { PacingConfig } from '../src/outreach/pacing.js';
import type { CeilingStatus, LimitKey } from '../src/outreach/limits.js';
import type { ControlState } from '../src/scheduler/control.js';
import { countDue, SCRIPT_DISCOVER_KEY, type DueCounts } from '../src/scheduler/due.js';
import { planWake, stepOrder, PIPELINE_MAX_JOBS_PER_WAKE, type PlanKnobs, type WakeDecision } from '../src/scheduler/plan.js';
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
  killed: false, killReason: null, halted: { linkedin: null, naukri: null }, allowed: ['linkedin', 'naukri'], readError: null,
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
  it('code pass, source-operator, discover, pipeline, mail, then the platform operators', () => {
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
      'mail-operator:mail',
      'linkedin-operator:inbox',
      'linkedin-operator:new_outreach',
      'naukri-operator:inbox',
    ]);
    expect(d.stages?.find((s) => s.kind === 'discover_agent')?.quota).toBe(3);
    expect(d.stages?.find((s) => s.kind === 'mail')?.quota).toBe(3);
  });

  it('a script pass alone plans no agent task, then the pipeline and mail stages', () => {
    const d = run(plan({ due: due({ scriptDiscoverLastHoursAgo: 7, inboxLastCheckedMinAgo: 1 }) }));
    expect(d.tasks).toEqual([]);
    expect(d.stages?.map((s) => s.kind)).toEqual(['discover_scripts', 'pipeline', 'mail']);
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

  it('unscored jobs pull in the pipeline and mail, queued email alone plans only mail', () => {
    const a = run(plan({ due: due({ unmatchedJobs: 2, inboxLastCheckedMinAgo: 1 }) }));
    expect(a.stages?.map((s) => s.kind)).toEqual(['pipeline', 'mail']);
    const b = run(plan({ due: due({ emailQueued: 2, inboxLastCheckedMinAgo: 1 }) }));
    expect(b.stages?.map((s) => s.kind)).toEqual(['mail']);
  });

  it('email follow-ups pull in the pipeline stage so the reply check runs first', () => {
    const d = run(plan({ due: due({ emailFollowupsReady: 1, inboxLastCheckedMinAgo: 1 }) }));
    expect(d.stages?.map((s) => s.kind)).toEqual(['pipeline', 'mail']);
  });

  it('a halted platform still gets the code pass only when something is allowed', () => {
    const c: ControlState = { ...ctl(), allowed: [], halted: { linkedin: 'x', naukri: 'y' } };
    expect(plan({ control: c, due: due({ scriptDiscoverLastHoursAgo: null }) })).toMatchObject({ kind: 'skip', reason: 'halted' });
  });
});

describe('countDue new fields', () => {
  it('counts unscored jobs, queued emails and source tasks, ignoring the daily dead-slug error rows', () => {
    const db = openDb(':memory:');
    const t = NOW.toISOString();
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('a','greenhouse','t','c'), ('b','greenhouse','t','c')").run();
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
          { id: 'adzuna', fetched: 0, kept: 0, error: 'timeout', fallback_used: true },
        ],
      };
    };
    const r1 = await runCodePass({ db, now: () => NOW, run: fake });
    expect(r1.ok).toBe(true);
    expect(r1.newJobs).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT new_count, streak_fail, shape_hash FROM platform_status WHERE id = 'greenhouse'").get()).toEqual({ new_count: 2, streak_fail: 0, shape_hash: 'h1' });
    expect(db.prepare("SELECT streak_fail, fallback_used FROM platform_status WHERE id = 'adzuna'").get()).toEqual({ streak_fail: 1, fallback_used: 1 });
    expect(getState(db, SCRIPT_DISCOVER_KEY)).toBe(NOW.toISOString());
    expect(r1.sourceStatusLine).toMatch(/^SOURCE_STATUS: \{/);
    expect(r1.sourceStatusLine).toContain('adzuna');
    const r2 = await runCodePass({ db, now: () => NOW, run: fake });
    expect(calls).toBe(2);
    expect(r2.newJobs).toBe(0); // already seen
    expect(db.prepare("SELECT streak_fail FROM platform_status WHERE id = 'adzuna'").get()).toEqual({ streak_fail: 2 });
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
  it('lists the wake order and the pipeline and mail instructions', () => {
    const d = run(plan({ due: due({ scriptDiscoverLastHoursAgo: null, sourceTasksQueued: 1, inboxLastCheckedMinAgo: null }) }));
    const p = buildWakePrompt({
      runId: 'r1', dryRun: true, burst: d.burst, tasks: d.tasks, budget: { maxToolCalls: 60, maxWallSec: 900, maxTokensApprox: 150000 },
      allowed: ['linkedin', 'naukri'], now: NOW, order: stepOrder(d), pipeline: pipe,
    });
    expect(p).toContain('Wake order');
    expect(p.indexOf('discover_scripts')).toBeLessThan(p.indexOf('`source-operator`'));
    expect(p.indexOf('`source-operator`')).toBeLessThan(p.indexOf('Pipeline stage'));
    expect(p.indexOf('Pipeline stage')).toBeLessThan(p.indexOf('`mail-operator`'));
    expect(p).toContain('SOURCE_STATUS:');
    expect(p).toContain('BOARD_STATUS:');
    expect(p).toContain('Target regions: home=India');
    expect(p).toContain('SEND_LIMIT_PER_RUN=1');
    expect(p).toContain('pre-send reply check completed with no errors');
  });
  it('names the discover searches in the ordered wake prompt', () => {
    const d = run(plan({ due: due({ linkedinDiscoverLastHoursAgo: null, naukriSearchLastHoursAgo: null }) }));
    const p = buildWakePrompt({
      runId: 'r1', dryRun: true, burst: d.burst, tasks: d.tasks, budget: { maxToolCalls: 60, maxWallSec: 900, maxTokensApprox: 150000 },
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
  const add = (db: ReturnType<typeof openDb>, id: string, o: Record<string, unknown> = {}) => {
    db.prepare("INSERT INTO jobs (id, source, title, company, url, apply_url, description, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, o.source ?? 'greenhouse', 'React Dev', o.company ?? 'Acme', 'https://x.test/u', o.apply_url ?? 'https://boards.greenhouse.io/a/jobs/1', 'Location: Remote\n\nbody', o.at ?? '2026-10-01 10:00:00');
  };
  it('returns full rows oldest first, skipping scored, excluded and given-up jobs', () => {
    const db = openDb(':memory:');
    add(db, 'new', { at: '2026-10-03 10:00:00' });
    add(db, 'old', { at: '2026-10-01 10:00:00' });
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
  it('offers matched jobs without an outreach row first, marked already_matched, at most twice', () => {
    const db = openDb(':memory:');
    add(db, 'fresh', { at: '2026-10-01 10:00:00' });
    add(db, 'pending', { at: '2026-10-02 10:00:00' }); db.prepare("UPDATE jobs SET score = 74 WHERE id = 'pending'").run();
    add(db, 'low'); db.prepare("UPDATE jobs SET score = 59 WHERE id = 'low'").run();
    add(db, 'queued'); db.prepare("UPDATE jobs SET score = 80 WHERE id = 'queued'").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('queued', 'queued')").run();
    add(db, 'vetoed'); db.prepare("UPDATE jobs SET score = 80, excluded_reason = 'x' WHERE id = 'vetoed'").run();
    const first = listUnscoredJobs(db, { limit: 10, matchThreshold: 60 });
    expect(first.map((r) => r.id)).toEqual(['pending', 'fresh']);
    expect(first[0]).toMatchObject({ already_matched: true, score: 74 });
    expect(first[1].already_matched).toBeUndefined();
    expect(listUnscoredJobs(db, { limit: 10, matchThreshold: 60 }).map((r) => r.id)).toEqual(['pending', 'fresh']);
    expect(listUnscoredJobs(db, { limit: 10, matchThreshold: 60 }).map((r) => r.id)).toEqual(['fresh']);
    expect(listUnscoredJobs(db, { limit: 10 }).map((r) => r.id)).toEqual(['fresh']);
  });
  it('does not let one source starve the others: unscored jobs are taken round-robin by source, oldest first within a source', () => {
    const db = openDb(':memory:');
    add(db, 'g1', { at: '2026-10-01 10:00:00' });
    add(db, 'g2', { at: '2026-10-01 11:00:00' });
    add(db, 'g3', { at: '2026-10-01 12:00:00' });
    add(db, 'n1', { source: 'naukri', apply_url: 'https://www.naukri.com/job-listings-x', at: '2026-10-05 10:00:00' });
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
    for (let i = 0; i < PIPELINE_MAX_JOBS_PER_WAKE; i++) {
      add(db, `j${i}`);
      db.prepare('UPDATE jobs SET description = ? WHERE id = ?').run('y'.repeat(50000), `j${i}`);
    }
    expect(JSON.stringify(listUnscoredJobs(db, { limit: PIPELINE_MAX_JOBS_PER_WAKE })).length).toBeLessThan(30000);
  });
  it('apply_class is deterministic from channelsFor', () => {
    const db = openDb(':memory:');
    add(db, 'gh');
    add(db, 'wd', { source: 'workday', apply_url: 'https://t.myworkdayjobs.com/x' });
    add(db, 'odd', { source: 'adzuna', apply_url: 'https://acme.example/j' });
    const by = Object.fromEntries(listUnscoredJobs(db).map((r) => [r.id, r.apply_class]));
    expect(by).toEqual({ gh: 'apply_capable', wd: 'discover_only_source', odd: 'apply_tier:unknown_host' });
    expect(listUnscoredJobs(db)[0].channels.map((c) => c.channel)).toEqual(['email', 'linkedin', 'naukri', 'apply']);
  });
  it('the pipeline quota is capped per wake', () => {
    const d = run(plan({ due: due({ unmatchedJobs: 400, inboxLastCheckedMinAgo: 1 }) }));
    expect(d.stages?.find((s) => s.kind === 'pipeline')?.quota).toBe(PIPELINE_MAX_JOBS_PER_WAKE);
    expect(PIPELINE_MAX_JOBS_PER_WAKE).toBe(10);
  });
  it('P1 names the tool, the cap and apply_class; the direct-call list names every tool used', () => {
    const t = pipelineLines({ matchThreshold: 60, sendLimit: 1, targetRegions: 'T', followupsAutonomous: false }).join('\n');
    expect(t).toContain(`\`db.list_unscored_jobs({limit: ${PIPELINE_MAX_JOBS_PER_WAKE}, match_threshold: 60})\``);
    expect(t).toContain('already_matched');
    expect(t).toContain('apply_class');
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
      newRunId: () => 'runpipe00000001', pollMs: 5000,
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
