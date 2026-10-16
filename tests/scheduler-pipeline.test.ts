import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Job } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import type { PacingConfig } from '../src/outreach/pacing.js';
import type { CeilingStatus, LimitKey } from '../src/outreach/limits.js';
import type { ControlState } from '../src/scheduler/control.js';
import { countDue, SCRIPT_DISCOVER_KEY, type DueCounts } from '../src/scheduler/due.js';
import { planWake, stepOrder, type PlanKnobs, type WakeDecision } from '../src/scheduler/plan.js';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import { runCodePass, statusLines, pipelineLines, targetRegionsLine, type CodePassResult } from '../src/scheduler/pipeline.js';
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
  it('target regions line falls back to defaults for a missing file', () => {
    expect(targetRegionsLine(join(tmpdir(), 'jobber-no-such-dir'))).toMatch(/^Target regions: home=India/);
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
    const d: DriverDeps = {
      db: openDb(':memory:'), now: () => new Date(t), rng: () => 0.5, sleep: async (ms) => { t += ms; },
      cfg: loadOutreachConfig({}), tuning: loadTuning({}), env: {}, lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'),
      runDir: join(dir, 'runs'), projectRoot: dir, launcher, notifier: { notify: async (n) => void notices.push(n.title) },
      newRunId: () => 'runpipe00000001', pollMs: 5000,
      codePass: codePass ? async () => { log.push('code'); return codePass(); } : undefined,
    };
    return { d, log, launcher, notices };
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
