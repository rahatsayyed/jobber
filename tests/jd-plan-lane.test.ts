// JD fetch in the planner (Naukri wake task), the LinkedIn drip lane (one job per tick), the prompt lines, the wake report line and the status screens.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, saveJob } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { ceilings, recordEvent } from '../src/outreach/limits.js';
import { sqlTime } from '../src/pipelineWork.js';
import { countDue } from '../src/scheduler/due.js';
import { planWake, stepOrder, JD_FETCH_NAUKRI_PER_WAKE, type PlanKnobs } from '../src/scheduler/plan.js';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import { pipelineLines } from '../src/scheduler/pipeline.js';
import { loadBudget } from '../src/scheduler/budget.js';
import type { ControlState } from '../src/scheduler/control.js';
import type { QuietConfig } from '../src/outreach/quiet.js';
import {
  buildLinkedinDripPrompt, itemKey, linkedinDripStatus, pickLinkedinItem, renderLinkedinDripLines, loadLinkedinDripConfig, LI_STATE_INBOX_AT,
} from '../src/scheduler/linkedinDrip.js';
import { setState } from '../src/scheduler/runLog.js';
import { jdReportLine } from '../src/jdStore.js';
import { buildSnapshot } from '../src/status/snapshot.js';
import { renderLimits, renderWorking } from '../src/status/render.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import { FULL_JD } from './helpers/jdFixtures.js';

type Db = ReturnType<typeof openDb>;
const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST, inside the LinkedIn active hours
const quiet: QuietConfig = { quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330 };
const knobs: PlanKnobs = { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 };
const ctl = (o: Partial<ControlState> = {}): ControlState => ({
  killed: false, killReason: null, halted: { linkedin: null, naukri: null, wellfound: null }, allowed: ['linkedin', 'naukri'], readError: null, ...o,
});

function jobs(db: Db, spec: Array<{ id: string; source: string; desc?: string; url?: string }>): void {
  for (const s of spec) {
    saveJob(db, { id: s.id, source: s.source, title: `React ${s.id}`, company: `Co ${s.id}`, url: s.url ?? `https://www.naukri.com/job-listings-x-${s.id.replace(/\D/g, '')}`, apply_url: '', description: s.desc ?? 'India' });
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(sqlTime(new Date(NOW.getTime() - 3600_000)), s.id);
  }
}
const decide = (db: Db, o: { env?: NodeJS.ProcessEnv; liDrip?: boolean; control?: ControlState; usedNaukri?: number } = {}) => {
  const env = o.env ?? {};
  for (let i = 0; i < (o.usedNaukri ?? 0); i++) recordEvent(db, 'naukri_jd_fetch', new Date(NOW.getTime() - 60_000));
  const due = countDue(db, NOW, loadTuning(env), env);
  const c = ceilings(db, loadOutreachConfig(env), NOW);
  return planWake({ now: NOW, quiet, control: o.control ?? ctl(), ceilings: c, due, knobs, linkedinDrip: o.liDrip ?? true, linkedinActive: true });
};
const taskOf = (d: ReturnType<typeof decide>, platform: string, kind: string) => {
  if (d.kind !== 'run') return undefined;
  return d.tasks.find((a) => a.platform === platform)?.tasks.find((t) => t.kind === kind);
};

describe('planner: Naukri jd_fetch task', () => {
  it('plans a jd_fetch task bounded by what waits, the per-wake cap of 15 and the room under the daily ceiling, and runs it before the pipeline', () => {
    const db = openDb(':memory:');
    jobs(db, [1, 2, 3].map((n) => ({ id: `naukri:${n}`, source: 'naukri' })));
    const d = decide(db);
    expect(taskOf(d, 'naukri', 'jd_fetch')).toEqual({ kind: 'jd_fetch', quota: 3 });
    if (d.kind !== 'run') throw new Error('x');
    const order = stepOrder(d).map((s) => `${s.operator}:${s.kind}`);
    expect(order.indexOf('naukri-operator:jd_fetch')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('naukri-operator:jd_fetch')).toBeLessThan(order.indexOf('pipeline:pipeline'));
    expect(order.filter((x) => x === 'naukri-operator:jd_fetch')).toHaveLength(1);

    const db2 = openDb(':memory:');
    jobs(db2, Array.from({ length: 40 }, (_, i) => ({ id: `naukri:${100 + i}`, source: 'naukri' })));
    expect(taskOf(decide(db2), 'naukri', 'jd_fetch')?.quota).toBe(JD_FETCH_NAUKRI_PER_WAKE);
    expect(taskOf(decide(db2, { env: { NAUKRI_MAX_JD_FETCH_PER_DAY: '60' }, usedNaukri: 55 }), 'naukri', 'jd_fetch')?.quota).toBe(5);
    expect(taskOf(decide(openDb(':memory:')), 'naukri', 'jd_fetch')).toBeUndefined();
  });
  it('plans nothing when the ceiling is used up, Naukri is halted or nothing waits', () => {
    const db = openDb(':memory:');
    jobs(db, [{ id: 'naukri:1', source: 'naukri' }]);
    expect(taskOf(decide(db, { env: { NAUKRI_MAX_JD_FETCH_PER_DAY: '1' }, usedNaukri: 1 }), 'naukri', 'jd_fetch')).toBeUndefined();
    const halted = decide(db, { control: ctl({ allowed: ['linkedin'], halted: { linkedin: null, naukri: 'login wall', wellfound: null } }) });
    expect(taskOf(halted, 'naukri', 'jd_fetch')).toBeUndefined();
    const full = openDb(':memory:');
    jobs(full, [{ id: 'naukri:1', source: 'naukri', desc: FULL_JD }]);
    expect(taskOf(decide(full), 'naukri', 'jd_fetch')).toBeUndefined();
  });
  it('LinkedIn gets a wake jd_fetch task only when its drip lane is off', () => {
    const db = openDb(':memory:');
    jobs(db, [{ id: 'li-job:5', source: 'linkedin-jobs', url: 'https://www.linkedin.com/jobs/view/5/' }]);
    expect(taskOf(decide(db, { liDrip: true }), 'linkedin', 'jd_fetch')).toBeUndefined();
    expect(taskOf(decide(db, { liDrip: false }), 'linkedin', 'jd_fetch')).toEqual({ kind: 'jd_fetch', quota: 1 });
  });
  it('the wake prompt names the typed tool, no URL, and the order', () => {
    const db = openDb(':memory:');
    jobs(db, [{ id: 'naukri:1', source: 'naukri' }]);
    const d = decide(db);
    if (d.kind !== 'run') throw new Error('x');
    const prompt = buildWakePrompt({
      runId: 'r1', dryRun: false, tasks: d.tasks, budget: loadBudget({}), allowed: ['linkedin', 'naukri'], now: NOW, order: stepOrder(d),
      pipeline: { matchThreshold: 3, sendLimit: 1, targetRegions: 'Target regions: x', followupsAutonomous: false, jdLine: jdReportLine(db, NOW) },
    });
    expect(prompt).toContain('task: jd_fetch quota 1');
    expect(prompt).toContain('naukri_fetch_jd');
    expect(prompt).toContain('with no arguments');
    expect(prompt).toContain('JD fetched 0, unavailable 0, waiting 1');
    expect(prompt).toMatch(/jd_incomplete/);
  });
  it('pipelineLines carries the JD rules and the code-computed report line', () => {
    const lines = pipelineLines({ matchThreshold: 3, sendLimit: 1, targetRegions: 'x', followupsAutonomous: false, jdLine: 'JD fetched 2, unavailable 1, waiting 3' }).join('\n');
    expect(lines).toContain('JD fetched 2, unavailable 1, waiting 3');
    expect(lines).toContain('jd_pending');
    expect(lines).toContain('do not re-dispatch it');
  });
});

describe('LinkedIn drip lane: jd_fetch item', () => {
  const dirs: string[] = [];
  function setup(env: NodeJS.ProcessEnv = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'li-jd-'));
    dirs.push(dir);
    const db = openDb(':memory:');
    const d = {
      db, now: () => NOW, rng: () => 0, sleep: async () => undefined, cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
      lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), runDir: join(dir, 'runs'), projectRoot: dir,
    } as unknown as DriverDeps;
    return { db, d };
  }
  const pick = async (s: ReturnType<typeof setup>, exclude: ReadonlySet<string> = new Set()) => (await pickLinkedinItem(s.d, NOW, loadLinkedinDripConfig(s.d.env), exclude)).item;
  const inboxRead = (db: Db): void => setState(db, LI_STATE_INBOX_AT, new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW);

  it('is picked after the inbox read, before everything else, one job per tick', async () => {
    const s = setup();
    jobs(s.db, [{ id: 'li-job:1', source: 'linkedin-jobs', url: 'https://www.linkedin.com/jobs/view/1/' }, { id: 'li-job:2', source: 'linkedin-jobs', url: 'https://www.linkedin.com/jobs/view/2/' }]);
    expect((await pick(s))?.kind).toBe('inbox'); // replies and inbox first
    inboxRead(s.db);
    const it1 = await pick(s);
    expect(it1).toMatchObject({ kind: 'jd_fetch', job_id: 'li-job:2' }); // newest first
    expect(itemKey(it1!)).toBe('jd_fetch:li-job:2');
    // an item a run already tried is not offered again at once
    expect(await pick(s, new Set(['jd_fetch:li-job:2']))).toMatchObject({ kind: 'jd_fetch', job_id: 'li-job:1' });
    expect(await pick(s, new Set(['jd_fetch:li-job:2', 'jd_fetch:li-job:1']))).toBeNull();
  });
  it('is not picked when its ceiling or the profile-view ceiling is used up, or when the job has its JD', async () => {
    const s = setup({ LINKEDIN_MAX_JD_FETCH_PER_DAY: '1' });
    inboxRead(s.db);
    jobs(s.db, [{ id: 'li-job:1', source: 'linkedin-jobs', url: 'https://www.linkedin.com/jobs/view/1/' }, { id: 'li-job:3', source: 'linkedin-jobs', desc: FULL_JD }]);
    expect((await pick(s))?.kind).toBe('jd_fetch');
    recordEvent(s.db, 'linkedin_jd_fetch', new Date(NOW.getTime() - 60_000));
    expect(await pick(s)).toBeNull();
    const t = setup({ LINKEDIN_MAX_PROFILE_VIEWS_PER_DAY: '0' });
    inboxRead(t.db);
    jobs(t.db, [{ id: 'li-job:1', source: 'linkedin-jobs', url: 'https://www.linkedin.com/jobs/view/1/' }]);
    expect(await pick(t)).toBeNull();
  });
  it('does not pick a Naukri job (that is the wake task) and its prompt carries the job id and the typed tool', async () => {
    const s = setup();
    inboxRead(s.db);
    jobs(s.db, [{ id: 'naukri:1', source: 'naukri' }, { id: 'li-job:9', source: 'linkedin-jobs', url: 'https://www.linkedin.com/jobs/view/9/' }]);
    const item = await pick(s);
    expect(item).toMatchObject({ kind: 'jd_fetch', job_id: 'li-job:9' });
    const prompt = buildLinkedinDripPrompt({ runId: 'x', dryRun: false, now: NOW, budget: loadBudget({}), item: item! });
    expect(prompt).toContain('Task: jd_fetch quota 1');
    expect(prompt).toContain('linkedin_fetch_jd');
    expect(prompt).toContain('li-job:9');
    expect(prompt).toContain('Open no URL yourself');
  });
  it('shows up in the lane status', () => {
    const s = setup();
    jobs(s.db, [{ id: 'li-job:9', source: 'linkedin-jobs', url: 'https://www.linkedin.com/jobs/view/9/' }]);
    const st = linkedinDripStatus(s.db, {}, { now: NOW, tuning: loadTuning({}) });
    expect(st.waiting.jd_fetch).toBe(1);
    expect(renderLinkedinDripLines(st, NOW).join('\n')).toContain('job descriptions to read 1');
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
});

describe('status and report lines', () => {
  it('limits show the two fetch ceilings and working shows waiting, fetched and unavailable', () => {
    const db = openDb(':memory:');
    jobs(db, [{ id: 'naukri:1', source: 'naukri' }, { id: 'naukri:2', source: 'naukri' }, { id: 'naukri:3', source: 'naukri', desc: FULL_JD }]);
    db.prepare("UPDATE jobs SET jd_fetched_at = ? WHERE id = 'naukri:3'").run(sqlTime(new Date(NOW.getTime() - 3600_000)));
    db.prepare("UPDATE jobs SET excluded_reason = 'jd_unavailable' WHERE id = 'naukri:2'").run();
    recordEvent(db, 'naukri_jd_fetch', new Date(NOW.getTime() - 60_000));
    const snap = buildSnapshot(db, loadOutreachConfig({}), NOW, {});
    expect(snap.jd).toEqual({ waiting: 1, pending: 0, fetched24h: 1, unavailable: 1 });
    const limits = renderLimits(snap);
    expect(limits).toContain('naukri_jd_fetch 1/60 per day');
    expect(limits).toContain('linkedin_jd_fetch 0/20 per day');
    expect(limits).toContain('job descriptions fetched in the last 24 hours: 1');
    expect(renderWorking(snap)).toContain('job descriptions: waiting 1');
    expect(renderWorking(snap)).toContain('unavailable 1');
    expect(jdReportLine(db, NOW)).toBe('JD fetched 1, unavailable 1, waiting 1');
  });
  it('the env catalog knows both caps with their defaults', async () => {
    const { LIMITS } = await import('../src/setup/limitsCatalog.js');
    const by = Object.fromEntries(LIMITS.map((l) => [l.key, l.default]));
    expect(by.NAUKRI_MAX_JD_FETCH_PER_DAY).toBe(60);
    expect(by.LINKEDIN_MAX_JD_FETCH_PER_DAY).toBe(20);
    expect(loadOutreachConfig({}).naukriMaxJdFetchPerDay).toBe(60);
    expect(loadOutreachConfig({ LINKEDIN_MAX_JD_FETCH_PER_DAY: '5' } as NodeJS.ProcessEnv).linkedinMaxJdFetchPerDay).toBe(5);
  });
});
