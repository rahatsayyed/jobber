// LinkedIn Easy Apply in the drip lane (src/scheduler/linkedinDrip.ts): the picker, the prompt line, the run environment, and the hand-over between
// the manual apply queue (Easy Apply off) and the lane (on). Fake clock, fake launcher, in-memory db. Nothing touches LinkedIn.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveJob } from '../src/db.js';
import { FULL_JD } from './helpers/jdFixtures.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { recordEvent } from '../src/outreach/limits.js';
import { upsertPerson } from '../src/outreach/people.js';
import { buildManualQueue } from '../src/manual/manualApply.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import { launcherAsWindows, type LaunchHandle, type LaunchPlan, type Launcher, type PollResult } from './helpers/fakeWindows.js';
import { setState } from '../src/scheduler/runLog.js';
import {
  buildLinkedinDripPrompt, describeItem, easyApplyRows, itemKey, linkedinDripStatus, linkedinDripTick, loadLinkedinDripConfig, pickLinkedinItem,
  renderLinkedinDripLines, LI_STATE_INBOX_AT, type LiItem,
} from '../src/scheduler/linkedinDrip.js';
import { loadBudget } from '../src/scheduler/budget.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST, inside the active hours
const DAY = 86400_000;
const URL_ = (n: string): string => `https://www.linkedin.com/jobs/view/${n}/`;
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

function setup(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'li-ea-'));
  dirs.push(dir);
  let t = NOON_IST.getTime();
  const db = openDb(':memory:');
  const launcher = new FakeLauncher();
  const d: DriverDeps = {
    db, now: () => new Date(t), rng: () => 0, sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), projectRoot: dir,
    windows: launcherAsWindows(launcher, () => d), notifier: { notify: async () => undefined },
    newRunId: (() => { let i = 0; return () => `liea${String(++i).padStart(6, '0')}`; })(),
  };
  return { d, db, launcher, now: () => new Date(t) };
}
type S = ReturnType<typeof setup>;

/** A LinkedIn job with a queue row stored the way enqueue stored it while Easy Apply was off (class none). */
function easyJob(s: S, n: string, o: { status?: string | null; note?: string | null; resume?: string | null; external?: string; source?: string; excluded?: string } = {}): string {
  const id = `li-job:${n}`;
  saveJob(s.db, { id, source: o.source ?? 'linkedin-jobs', title: `Dev ${n}`, company: 'Acme', url: URL_(n), apply_url: URL_(n), description: FULL_JD });
  if (o.external) s.db.prepare('UPDATE jobs SET external_apply_url = ? WHERE id = ?').run(o.external, id);
  if (o.excluded) s.db.prepare('UPDATE jobs SET excluded_reason = ? WHERE id = ?').run(o.excluded, id);
  s.db.prepare("INSERT INTO outreach_queue (job_id, resume_pdf_path, apply_platform, apply_tier, apply_url, apply_status, apply_note, status) VALUES (?,?,?,?,?,?,?,'queued')")
    .run(id, o.resume === undefined ? 'renderer/automation/x/resume.pdf' : o.resume, 'none', 'never', URL_(n), o.status ?? null, o.note ?? null);
  return id;
}
const inboxRead = (s: S): void => setState(s.db, LI_STATE_INBOX_AT, new Date(s.now().getTime() - 5 * 60_000).toISOString(), s.now());
const pick = async (s: S) => (await pickLinkedinItem(s.d, s.now(), loadLinkedinDripConfig(s.d.env))).item;
const ON = { APPLY_LINKEDIN_EASY: 'true' };
const OFF = { APPLY_LINKEDIN_EASY: 'false' };

describe('picker', () => {
  it('picks an Easy Apply job unless APPLY_LINKEDIN_EASY is false (on by default)', async () => {
    const off = setup(OFF);
    easyJob(off, '4011111111');
    inboxRead(off);
    expect(await pick(off)).toBeNull();
    const on = setup(ON);
    easyJob(on, '4011111111');
    inboxRead(on);
    expect(await pick(on)).toMatchObject({ kind: 'easy_apply', job_id: 'li-job:4011111111' });
  });

  it('takes the oldest queue row first and skips a tried item', async () => {
    const s = setup(ON);
    easyJob(s, '4011111111');
    easyJob(s, '4022222222');
    inboxRead(s);
    expect(itemKey((await pick(s)) as LiItem)).toBe('easy_apply:li-job:4011111111');
    const r = await pickLinkedinItem(s.d, s.now(), loadLinkedinDripConfig(s.d.env), new Set(['easy_apply:li-job:4011111111']));
    expect(r.item).toMatchObject({ kind: 'easy_apply', job_id: 'li-job:4022222222' });
  });

  it('comes after a due DM and before a new invite', async () => {
    const s = setup(ON);
    inboxRead(s);
    easyJob(s, '4011111111');
    // a queued invite for a new person
    saveJob(s.db, { id: 'jinv', source: 'naukri', title: 'React Dev', company: 'Globex', url: 'u', apply_url: 'u', description: 'd' });
    s.db.prepare('UPDATE jobs SET score = 4 WHERE id = ?').run('jinv');
    upsertPerson(s.db, { platform: 'linkedin', profileKey: 'linkedin.com/in/new1', name: 'New One', headline: 'Recruiter at Globex', company: 'Globex', category: 'recruiter' });
    s.db.prepare("INSERT INTO outreach_queue (job_id, connect_note, connect_profile_url, connect_category, connect_company, status, created_at) VALUES ('jinv', 'note', 'https://www.linkedin.com/in/new1', 'recruiter', 'Globex', 'queued', '2026-10-14 01:00:00')").run();
    expect(await pick(s)).toMatchObject({ kind: 'easy_apply' });
    // a connected person whose first DM is due wins over the application
    const id = upsertPerson(s.db, { platform: 'linkedin', profileKey: 'linkedin.com/in/dm1', name: 'Dee Em', headline: 'Recruiter at Acme', company: 'Acme', category: 'recruiter' });
    s.db.prepare('UPDATE contact_state SET stage = ?, cycle_started_at = ? WHERE person_id = ?').run('active', new Date(s.now().getTime() - 30 * DAY).toISOString(), id);
    s.db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'connect', 'c-dm1', 'sent', ?)").run(id, new Date(s.now().getTime() - 10 * DAY).toISOString());
    s.db.prepare("INSERT INTO connections (profile_url, status) VALUES ('https://www.linkedin.com/in/dm1', 'connected')").run();
    expect(await pick(s)).toMatchObject({ kind: 'dm' });
  });

  it('skips vetoed, applied, handed-back, resume-less, resolved-external and already-handled rows', async () => {
    const s = setup(ON);
    inboxRead(s);
    easyJob(s, '4011111111', { excluded: 'location FAIL' });
    easyJob(s, '4022222222', { note: 'easy_apply:not_easy_apply' });
    easyJob(s, '4033333333', { resume: null });
    easyJob(s, '4044444444', { external: 'https://boards.greenhouse.io/acme/jobs/1' });
    easyJob(s, '4055555555', { status: 'needs_owner' });
    const applied = easyJob(s, '4077777777');
    s.db.prepare("INSERT INTO applications (job_id, platform, status) VALUES (?, 'linkedin', 'submitted')").run(applied);
    expect(easyApplyRows(s.db, ON)).toEqual([]);
    expect(await pick(s)).toBeNull();
  });

  it('waits when the Easy Apply ceiling, the shared apply room or the profile-view ceiling is spent', async () => {
    const a = setup({ ...ON, LINKEDIN_MAX_EASY_APPLIES_PER_DAY: '1' });
    easyJob(a, '4011111111');
    inboxRead(a);
    recordEvent(a.db, 'linkedin_easy_apply', new Date(a.now().getTime() - 1000));
    expect(await pick(a)).toBeNull();
    const b = setup({ ...ON, MAX_APPLIES_PER_DAY: '1' });
    easyJob(b, '4011111111');
    inboxRead(b);
    b.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'easy_apply', 1)").run();
    expect(await pick(b)).toBeNull();
    const c = setup({ ...ON, LINKEDIN_MAX_PROFILE_VIEWS_PER_DAY: '0' });
    easyJob(c, '4011111111');
    inboxRead(c);
    expect(await pick(c)).toBeNull();
  });
});

describe('manual queue <-> drip lane hand-over', () => {
  it('turning APPLY_LINKEDIN_EASY on moves the rows from the manual queue to the lane without losing any', async () => {
    const s = setup(OFF);
    const ids = ['4011111111', '4022222222', '4033333333'].map((n) => easyJob(s, n));
    const offList = buildManualQueue(s.db, OFF);
    expect(offList.items.map((i) => i.job_id).sort()).toEqual([...ids].sort());
    expect(offList.items.every((i) => i.reason === 'easy_apply_off')).toBe(true);
    expect(easyApplyRows(s.db, OFF)).toEqual([]); // flag off: the lane owns none of them
    const lane = easyApplyRows(s.db, ON).map((r) => r.job_id);
    const onList = buildManualQueue(s.db, ON).items.map((i) => i.job_id);
    expect(onList).toEqual([]); // the owner list no longer holds them
    expect([...lane, ...onList].sort()).toEqual([...ids].sort()); // nothing lost: every job is in exactly one of the two
    // and back
    expect(buildManualQueue(s.db, OFF).items.map((i) => i.job_id).sort()).toEqual([...ids].sort());
  });

  it('a row the lane gave up on (needs_owner) shows in the manual queue whatever the flag says', () => {
    const s = setup(ON);
    easyJob(s, '4011111111', { status: 'needs_owner', note: 'easy_apply:unknown_button' });
    expect(easyApplyRows(s.db, ON)).toEqual([]);
    expect(buildManualQueue(s.db, ON).items).toMatchObject([{ job_id: 'li-job:4011111111', reason: 'easy_apply_failed' }]);
  });
});

describe('prompt, run environment and status', () => {
  const item: LiItem = { kind: 'easy_apply', job_id: 'li-job:4011111111', queue_id: 1, title: 'Dev <b>1</b>', company: 'Acme "x"' };
  it('the item line names the job id and the steps, carries no URL and cleans the title', () => {
    const { task, line } = describeItem(item);
    expect(task).toBe('easy_apply quota 1');
    expect(line).toContain('job_id li-job:4011111111');
    expect(line).toContain('linkedin_arm_send');
    expect(line).toContain('linkedin_easy_apply_fill');
    expect(line).not.toMatch(/https?:\/\//);
    expect(line).not.toContain('<b>');
    const p = buildLinkedinDripPrompt({ runId: 'r1', dryRun: false, now: NOON_IST, budget: loadBudget({}), item });
    expect(p).toContain('Task: easy_apply quota 1');
  });

  it('a due tick launches one run for the application into the linkedin window (the lane marker is fixed in the window env)', async () => {
    const s = setup({ ...ON, MAX_APPLIES_PER_DAY: '3' });
    easyJob(s, '4011111111');
    inboxRead(s);
    const r = await linkedinDripTick(s.d);
    expect(r).toMatchObject({ status: 'ran', item: 'easy_apply:li-job:4011111111' });
    const plan = s.launcher.starts[0];
    expect(plan).toMatchObject({ trigger: 'linkedin_drip', window: 'linkedin' });
    // The lane marker is fixed in the window's start environment (config/manager-windows.json), not passed per item.
    const cfg = JSON.parse(readFileSync('config/manager-windows.json', 'utf8')) as { windows: Record<string, { env?: Record<string, string> }> };
    expect(cfg.windows.linkedin.env?.JOBBER_RUN_LANE).toBe('linkedin_drip');
    expect(plan.prompt).toContain('Drip item: easy_apply');
  });

  it('the status screen shows the count when on and the manual-queue hint when off', () => {
    const on = setup(ON);
    easyJob(on, '4011111111');
    const sOn = linkedinDripStatus(on.db, ON, { now: on.now(), tuning: on.d.tuning });
    expect(sOn.waiting.easy_applies_ready).toBe(1);
    expect(renderLinkedinDripLines(sOn, on.now()).join('\n')).toContain('Easy Apply ready 1');
    const off = setup(OFF);
    easyJob(off, '4011111111');
    const sOff = linkedinDripStatus(off.db, OFF, { now: off.now(), tuning: off.d.tuning });
    expect(sOff.waiting.easy_applies_ready).toBe(0);
    expect(renderLinkedinDripLines(sOff, off.now()).join('\n')).toContain('npm run apply:manual -- list');
  });
});
