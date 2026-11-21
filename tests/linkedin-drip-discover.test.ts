// LinkedIn discovery inside the drip lane (src/scheduler/linkedinDrip.ts): picker order and gates, the prompt line, state after a tick, the status
// line, and the planner (a wake plans no LinkedIn discover while the lane is on). Fake clock and launcher, in-memory db. Nothing touches LinkedIn.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveJob } from '../src/db.js';
import { FULL_JD } from './helpers/jdFixtures.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { ceilings, recordEvent } from '../src/outreach/limits.js';
import { markSearchTried } from '../src/linkedin/discoverRotation.js';
import { LAST_KEY, NEXT_KEY } from '../src/scheduler/discoverNext.js';
import { getState, setState } from '../src/scheduler/runLog.js';
import { planWake, type DiscoverSearches } from '../src/scheduler/plan.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import { launcherAsWindows, type LaunchHandle, type LaunchPlan, type Launcher, type PollResult } from './helpers/fakeWindows.js';
import {
  buildLinkedinDripPrompt, describeItem, itemKey, linkedinDripStatus, linkedinDripTick, loadLinkedinDripConfig, pickLinkedinItem,
  renderLinkedinDripLines, LI_STATE_INBOX_AT, type LiItem,
} from '../src/scheduler/linkedinDrip.js';
import { loadBudget } from '../src/scheduler/budget.js';
import type { ControlState } from '../src/scheduler/control.js';
import type { QuietConfig } from '../src/outreach/quiet.js';
import type { DueCounts } from '../src/scheduler/due.js';

const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST, inside the active hours
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

class FakeLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    return { runId: plan.runId, session: plan.session, window: `w-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> { return { exited: true, exitCode: 0, newOutput: '' }; }
  async kill(): Promise<void> {}
}

const NAMES: DiscoverSearches = { jobs: ['jobs-a', 'jobs-b'], posts: ['posts-a', 'posts-b'] };

function setup(env: NodeJS.ProcessEnv = {}, names: DiscoverSearches | null = NAMES) {
  const dir = mkdtempSync(join(tmpdir(), 'li-disc-'));
  dirs.push(dir);
  let t = NOW.getTime();
  const db = openDb(':memory:');
  const launcher = new FakeLauncher();
  const d: DriverDeps = {
    db, now: () => new Date(t), rng: () => 0, sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), projectRoot: dir,
    windows: launcherAsWindows(launcher, () => d), notifier: { notify: async () => undefined },
    newRunId: (() => { let i = 0; return () => `lidc${String(++i).padStart(6, '0')}`; })(),
    ...(names ? { discoverSearches: names } : {}),
  };
  return { d, db, launcher, now: () => new Date(t) };
}
type S = ReturnType<typeof setup>;

const inboxRead = (s: S): void => setState(s.db, LI_STATE_INBOX_AT, new Date(s.now().getTime() - 5 * 60_000).toISOString(), s.now());
const pickR = (s: S, exclude: ReadonlySet<string> = new Set()) => pickLinkedinItem(s.d, s.now(), loadLinkedinDripConfig(s.d.env), exclude);
const pick = async (s: S) => (await pickR(s)).item;
const notDue = (s: S): void => setState(s.db, NEXT_KEY, new Date(s.now().getTime() + 40 * 60_000).toISOString(), s.now());

function easyJob(s: S, n: string): void {
  const id = `li-job:${n}`;
  const u = `https://www.linkedin.com/jobs/view/${n}/`;
  saveJob(s.db, { id, source: 'linkedin-jobs', title: `Dev ${n}`, company: 'Acme', url: u, apply_url: u, description: FULL_JD });
  s.db.prepare("INSERT INTO outreach_queue (job_id, resume_pdf_path, apply_platform, apply_tier, apply_url, status) VALUES (?,?,?,?,?,'queued')")
    .run(id, 'renderer/automation/x/resume.pdf', 'none', 'never', u);
}
function jdJob(s: S, n: string): void {
  saveJob(s.db, { id: `li-jd:${n}`, source: 'linkedin-jobs', title: `Dev ${n}`, company: 'Acme', url: `https://www.linkedin.com/jobs/view/${n}/`, apply_url: '', description: 'short' });
}

describe('picker', () => {
  it('picks discovery when the cadence is due, posts first, with a name chosen by the rotation', async () => {
    const s = setup();
    inboxRead(s);
    expect(await pick(s)).toEqual({ kind: 'discover_posts', search: 'posts-a' });
    // posts-a was tried before: the rotation moves to posts-b
    markSearchTried(s.db, 'search_posts', 'posts-a', new Date(NOW.getTime() - 3600_000));
    expect(await pick(s)).toEqual({ kind: 'discover_jobs', search: 'jobs-a' }); // posts ran last, so jobs now
  });

  it('alternates posts and jobs by the most recent attempt', async () => {
    const s = setup();
    inboxRead(s);
    markSearchTried(s.db, 'search_jobs', 'jobs-a', new Date(NOW.getTime() - 2 * 3600_000));
    markSearchTried(s.db, 'search_posts', 'posts-a', new Date(NOW.getTime() - 3600_000));
    expect(await pick(s)).toEqual({ kind: 'discover_jobs', search: 'jobs-b' });
    markSearchTried(s.db, 'search_jobs', 'jobs-b', new Date(NOW.getTime() - 1800_000));
    expect(await pick(s)).toEqual({ kind: 'discover_posts', search: 'posts-b' });
  });

  it('picks nothing when the cadence is not due', async () => {
    const s = setup();
    inboxRead(s);
    notDue(s);
    expect(await pick(s)).toBeNull();
  });

  it('picks nothing without searches, or when the linkedin_discover ceiling is used up', async () => {
    const none = setup({}, { jobs: [], posts: [] });
    inboxRead(none);
    expect(await pick(none)).toBeNull();
    const absent = setup({}, null);
    inboxRead(absent);
    expect(await pick(absent)).toBeNull();
    const full = setup();
    inboxRead(full);
    const lim = ceilings(full.db, loadOutreachConfig({}), NOW).linkedin_discover.limit;
    for (let i = 0; i < lim; i++) recordEvent(full.db, 'linkedin_discover', new Date(NOW.getTime() - 60_000));
    expect(await pick(full)).toBeNull();
  });

  it('picks nothing when the daily search ceiling is used up', async () => {
    const s = setup({ MAX_LINKEDIN_SEARCHES_PER_DAY: '2' });
    inboxRead(s);
    s.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'linkedin_search', 2)").run();
    expect(await pick(s)).toBeNull();
    const ok = setup({ MAX_LINKEDIN_SEARCHES_PER_DAY: '3' });
    inboxRead(ok);
    ok.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'linkedin_search', 2)").run();
    expect(await pick(ok)).toMatchObject({ kind: 'discover_posts' });
  });

  it('skips a name tried recently and falls to the other kind, then to nothing', async () => {
    const s = setup({}, { jobs: ['jobs-a'], posts: ['posts-a'] });
    inboxRead(s);
    const r1 = await pickR(s, new Set(['discover_posts:posts-a']));
    expect(r1.item).toEqual({ kind: 'discover_jobs', search: 'jobs-a' });
    const r2 = await pickR(s, new Set(['discover_posts:posts-a', 'discover_jobs:jobs-a']));
    expect(r2.item).toBeNull();
  });

  it('keeps LiItem keys distinct per search', () => {
    expect(itemKey({ kind: 'discover_posts', search: 'x' })).toBe('discover_posts:x');
    expect(itemKey({ kind: 'discover_jobs', search: 'x' })).toBe('discover_jobs:x');
  });

  it('comes after Easy Apply and before a JD read', async () => {
    const s = setup({ APPLY_LINKEDIN_EASY: 'true' });
    inboxRead(s);
    jdJob(s, '4033333333');
    expect(await pick(s)).toMatchObject({ kind: 'discover_posts' }); // discovery before jd_fetch
    easyJob(s, '4011111111');
    expect(await pick(s)).toMatchObject({ kind: 'easy_apply' }); // easy apply before discovery
    notDue(s);
    const q = setup({ APPLY_LINKEDIN_EASY: 'true' });
    inboxRead(q);
    jdJob(q, '4033333333');
    notDue(q);
    expect(await pick(q)).toMatchObject({ kind: 'jd_fetch' });
  });
});

describe('prompt', () => {
  it('names the typed tool once and the code-chosen search, and nothing else to open', () => {
    const posts = describeItem({ kind: 'discover_posts', search: 'react-hiring' } as LiItem);
    expect(posts.task).toBe('discover quota 1');
    expect(posts.line).toContain('`linkedin_search_posts`');
    expect(posts.line).toContain('{search: "react-hiring"}');
    expect(posts.line).toContain('ONCE');
    const jobs = describeItem({ kind: 'discover_jobs', search: 'full-stack' } as LiItem);
    expect(jobs.line).toContain('`linkedin_search_jobs`');
    expect(jobs.line).toContain('{search: "full-stack"}');
    expect(jobs.line).not.toMatch(/https?:\/\//);
    const p = buildLinkedinDripPrompt({ runId: 'r1', dryRun: false, now: NOW, budget: loadBudget({}), item: { kind: 'discover_jobs', search: 'full-stack' } });
    expect(p).toContain('Task: discover quota 1');
    expect(p).toContain('DRIP MODE');
  });

  it('cleans a hostile name', () => {
    const l = describeItem({ kind: 'discover_jobs', search: 'a"b<script>`x' } as LiItem).line;
    expect(l).not.toContain('<script>');
  });
});

describe('tick', () => {
  it('types the discovery item, then advances the cadence and the rotation so it is not re-offered', async () => {
    const s = setup();
    inboxRead(s);
    expect(getState(s.db, NEXT_KEY)).toBeNull();
    const r = await linkedinDripTick(s.d);
    expect(r).toMatchObject({ status: 'ran', item: 'discover_posts:posts-a' });
    expect(s.launcher.starts[0].prompt).toContain('linkedin_search_posts');
    // the tool never ran in this fake: the lane still advanced the cadence and the rotation
    expect(getState(s.db, LAST_KEY)).toBeTruthy();
    expect(Date.parse(getState(s.db, NEXT_KEY) as string)).toBeGreaterThan(s.now().getTime());
    expect(getState(s.db, 'linkedin_discover_try:search_posts:posts-a')).toBeTruthy();
    expect(await pick(s)).toBeNull(); // not due again for 45+ minutes
  });
});

describe('status', () => {
  it('shows discovery in the waiting line', () => {
    const s = setup();
    const st = linkedinDripStatus(s.db, {}, { now: NOW, tuning: loadTuning({}) });
    expect(typeof st.waiting.discover_due).toBe('boolean');
    expect(renderLinkedinDripLines(st, NOW).join('\n')).toMatch(/waiting: discovery /);
  });
});

describe('planner', () => {
  const quiet: QuietConfig = { quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330 };
  const ctl: ControlState = { killed: false, killReason: null, halted: { linkedin: null, naukri: null, wellfound: null }, allowed: ['linkedin', 'naukri'], readError: null };
  const plan = (liDrip: boolean | undefined) => {
    const s = setup();
    const cfg = loadOutreachConfig({});
    const due = { followupsDue: 0, newOutreachReady: 0, followupsDueByPlatform: {}, newOutreachReadyByPlatform: {}, inboxLastCheckedMinAgo: 5, naukriSearchLastHoursAgo: 1, linkedinDiscoverLastHoursAgo: null } as unknown as DueCounts;
    const d = planWake({
      now: NOW, quiet, control: ctl, ceilings: ceilings(s.db, cfg, NOW), due, knobs: { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 },
      discoverSearches: NAMES, linkedinActive: true, ...(liDrip === undefined ? {} : { linkedinDrip: liDrip }),
    });
    return d.kind === 'run' ? d.tasks.flatMap((a) => a.tasks.map((t) => ({ ...t, platform: a.platform }))).filter((t) => t.kind === 'discover' && t.platform === 'linkedin') : [];
  };
  it('plans no LinkedIn discover task while the drip lane is on', () => {
    expect(plan(true)).toEqual([]);
  });
  it('still plans it with LINKEDIN_DRIP=false (old wake behaviour)', () => {
    expect(plan(false)).toHaveLength(1);
    expect(plan(undefined)).toHaveLength(1);
  });
});
