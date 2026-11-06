// The wake through the long-lived windows (the only way a wake runs). Fakes only: fake dispatcher, in-memory db, temp dirs. Nothing touches a real window, browser, mail or LinkedIn.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { openDb, saveJob } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { listHandoff } from '../src/platform/handoff.js';
import type { Run } from '../src/platform/tmux.js';
import { projectTranscriptDir, transcriptFile, writeWindowSession } from '../src/platform/windowSession.js';
import { loadBudget } from '../src/scheduler/budget.js';
import { wakeOnce, type DriverDeps } from '../src/scheduler/driver.js';
import type { Notice } from '../src/scheduler/notify.js';
import type { Step } from '../src/scheduler/plan.js';
import { buildWakePrompt, DIAGNOSTIC_RULES, ITEM_RULES } from '../src/scheduler/prompt.js';
import { getState, listRuns } from '../src/scheduler/runLog.js';
import { wakeStartDiff, wakeStartValues, windowStartedLive } from '../src/scheduler/wakeWindowStart.js';
import {
  groupWakeSteps, ownerWindow, runWakeThroughWindows, type WakeItem, type WakeWindowsCtx,
} from '../src/scheduler/wakeWindows.js';
import { WindowDispatcher, type DispatchInput, type DispatchResult } from '../src/scheduler/windowDispatch.js';
import { FULL_ORDER, fullWakeInput, INSTRUCTIONS, PIPELINE_INPUT } from './fixtures/wake-prompt-input.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const req = createRequire(import.meta.url);
const NOON_IST = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST, outside quiet hours
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

const steps = (...s: Array<[string, string | undefined, string]>): Step[] =>
  s.map(([operator, platform, kind]) => ({ operator, ...(platform ? { platform } : {}), kind, quota: 2 }) as Step);
const names = (items: WakeItem[]): string[] => items.map((i) => `${i.window}:${i.steps.map((s) => `${s.platform ?? s.operator}.${s.kind}`).join('+')}`);
const all = (): Set<string> => new Set(['sources', 'pipeline', 'boards', 'apply', 'linkedin']);

describe('the all-steps wake prompt is unchanged (byte for byte)', () => {
  it('buildWakePrompt without `item` equals the golden file made from the pre-3c builder', () => {
    const golden = readFileSync(join(ROOT, 'tests/fixtures/wake-prompt-full.txt'), 'utf8');
    expect(buildWakePrompt(fullWakeInput())).toBe(golden);
  });
});

describe('item prompt', () => {
  const base = { ...fullWakeInput(), instructions: undefined };
  it('lists only the item steps, names the window and the run id line, and keeps the self-repair rules in the pipeline item only', () => {
    const boards = steps(['naukri-operator', 'naukri', 'inbox'], ['wellfound-operator', 'wellfound', 'inbox']);
    const p = buildWakePrompt({ ...base, order: boards, item: { window: 'boards', selfRepair: false } });
    expect(p).toContain('work item of window `boards`');
    expect(p).toContain('`naukri-operator` for platform naukri');
    expect(p).toContain('`wellfound-operator` for platform wellfound');
    expect(p).not.toContain('linkedin-operator');
    expect(p).not.toContain('Pipeline stage');
    for (const l of ITEM_RULES) expect(p).toContain(l);
    for (const l of DIAGNOSTIC_RULES) expect(p).not.toContain(l);
    expect(p).toContain('End with one JSON line {run_id: "abcd1234"');
    const pipe = buildWakePrompt({ ...base, order: steps(['pipeline', undefined, 'pipeline']), item: { window: 'pipeline', selfRepair: true }, instructions: INSTRUCTIONS });
    for (const l of DIAGNOSTIC_RULES) expect(pipe).toContain(l);
    expect(pipe).toContain('Pipeline stage (');
    expect(pipe).toContain('Skip Acme this week');
    expect(pipe).toContain(PIPELINE_INPUT.targetRegions);
  });
  it('keeps the chunk rule of a split sending step', () => {
    const o: Step[] = [{ operator: 'apply-operator', kind: 'apply', quota: 7, chunks: [5, 2] }];
    const p = buildWakePrompt({ ...base, order: o, item: { window: 'apply', selfRepair: false } });
    expect(p).toContain('quota 7 -> calls of 5, 2');
    expect(p).toContain('SEPARATE sequential Agent calls');
  });
});

describe('grouping the wake steps by window', () => {
  it('owner windows', () => {
    expect(ownerWindow(FULL_ORDER[2])).toBe('sources');
    expect(ownerWindow(FULL_ORDER[3])).toBe('linkedin');
    expect(ownerWindow(FULL_ORDER[4])).toBe('boards');
    expect(ownerWindow(FULL_ORDER[5])).toBe('boards');
    expect(ownerWindow(FULL_ORDER[11])).toBe('pipeline');
    expect(ownerWindow(FULL_ORDER[17])).toBe('apply');
    expect(ownerWindow({ operator: 'mail-operator', kind: 'mail', quota: 1 })).toBeNull();
  });

  it('keeps stepOrder: barriers keep their place, platform steps of one stretch are put together, code steps are in no item', () => {
    expect(names(groupWakeSteps(FULL_ORDER))).toEqual([
      'sources:source-operator.discover_agent',
      'linkedin:linkedin.manual_url+linkedin.discover+linkedin.accept_recent',
      'boards:naukri.manual_url+wellfound.manual_url+naukri.discover+wellfound.discover+naukri.jd_fetch',
      'pipeline:pipeline.pipeline',
      'linkedin:linkedin.inbox+linkedin.followups+linkedin.new_outreach',
      'boards:naukri.inbox+naukri.followups',
      'apply:apply-operator.apply',
    ]);
  });

  it('every non-code step appears exactly once; a step no window owns (mail-operator) is dropped, never run', () => {
    const flat = groupWakeSteps(FULL_ORDER).flatMap((i) => i.steps);
    expect(flat.length).toBe(FULL_ORDER.filter((s) => s.operator !== 'code').length);
    expect(new Set(flat).size).toBe(flat.length);
    expect(groupWakeSteps(steps(['mail-operator', undefined, 'mail']))).toEqual([]);
  });

  it('a mixed small plan (linkedin, naukri, pipeline, apply)', () => {
    const o = steps(
      ['naukri-operator', 'naukri', 'discover'], ['linkedin-operator', 'linkedin', 'discover'],
      ['pipeline', undefined, 'pipeline'], ['naukri-operator', 'naukri', 'inbox'], ['apply-operator', undefined, 'apply'],
    );
    expect(names(groupWakeSteps(o))).toEqual([
      'boards:naukri.discover', 'linkedin:linkedin.discover', 'pipeline:pipeline.pipeline', 'boards:naukri.inbox', 'apply:apply-operator.apply',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
class FakeDispatcher {
  inputs: DispatchInput[] = [];
  finished: string[] = [];
  reply: (i: DispatchInput, n: number) => DispatchResult;
  constructor(reply?: (i: DispatchInput, n: number) => DispatchResult) {
    this.reply = reply ?? ((i, n) => this.ok(i, n));
  }
  /** An ok turn whose last text is the final JSON line naming exactly the operators of the item's steps. */
  ok(i: DispatchInput, n: number): DispatchResult {
    const item = i.item as { wake_run_id: string; steps: string[] };
    const ops = item.steps.map((s) => {
      const m = /^\d+\. (\S+)(?: (naukri|linkedin|wellfound))? (\S+)$/.exec(s);
      return m ? { operator: m[1], ...(m[2] ? { platform: m[2] } : {}), tasks: [{ kind: m[3], done: 1, skipped: 0, escalated: 0, stopped: 0 }] } : null;
    }).filter(Boolean);
    return { status: 'ok', stopReason: 'end_turn', summary: JSON.stringify({ run_id: item.wake_run_id, operators: ops }), toolCalls: 3, runId: `w-${i.window}-${n}` };
  }
  async dispatch(i: DispatchInput): Promise<DispatchResult> {
    this.inputs.push(i);
    return this.reply(i, this.inputs.length);
  }
  async finish(id: string): Promise<{ cleared: boolean }> {
    this.finished.push(id);
    return { cleared: true };
  }
}

function ctxFor(items: WakeItem[], disp: FakeDispatcher | undefined, o: { env?: NodeJS.ProcessEnv; dry?: boolean; stop?: () => string | null } = {}) {
  const root = tmp('ww-run-');
  let t = NOON_IST.getTime();
  const notices: Notice[] = [];
  const db = openDb(':memory:');
  const headlessCalls: unknown[] = []; // nothing may ever run headless: always empty
  let claims = 0;
  const env = o.env ?? {};
  const d = {
    db, now: () => new Date(t), sleep: async (ms: number) => { t += ms; }, env, projectRoot: root,
    notifier: { notify: async (n: Notice) => void notices.push(n) },
    windows: disp as unknown as WindowDispatcher,
  } as unknown as DriverDeps;
  const ctx: WakeWindowsCtx = {
    d, runId: 'wake0001', dry: o.dry ?? false, budget: loadBudget({}), now: NOON_IST, allowed: ['linkedin', 'naukri', 'wellfound'], items,
    pipelineInput: PIPELINE_INPUT,
    claimInstructions: () => { claims++; return INSTRUCTIONS; },
    stopCheck: o.stop ?? (() => null),
    heartbeat: () => {},
    waitMs: 60_000, waitPollMs: 10_000,
  };
  return { ctx, db, root, notices, headlessCalls, claims: () => claims, clock: () => t };
}
const mixedItems = (): WakeItem[] => groupWakeSteps(FULL_ORDER);

describe('runWakeThroughWindows', () => {
  it('dispatches every item to its window in order with trigger wake, lane wake, then finish() after each; sums the report counts', async () => {
    const disp = new FakeDispatcher();
    const c = ctxFor(mixedItems(), disp);
    const r = await runWakeThroughWindows(c.ctx);
    expect(disp.inputs.map((i) => i.window)).toEqual(['sources', 'linkedin', 'boards', 'pipeline', 'linkedin', 'boards', 'apply']);
    for (const i of disp.inputs) {
      expect(i.trigger).toBe('wake');
      expect(i.lane).toBe('wake');
      expect(i.deadlineMs).toBe(loadBudget({}).maxWallSec * 1000);
      expect(i.promptText).toContain(`work item of window \`${i.window}\``);
    }
    expect(disp.finished).toHaveLength(7);
    expect(r.status).toBe('ok');
    expect(r.stopReason).toBeNull();
    expect(r.sessionRan).toBe(true);
    expect(r.counts?.done).toBeGreaterThan(0);
    expect(c.headlessCalls).toHaveLength(0);
    expect(r.items.every((x) => x.status === 'ok')).toBe(true);
  });

  it('claims the owner instructions only for the pipeline item', async () => {
    const disp = new FakeDispatcher();
    const c = ctxFor(mixedItems(), disp);
    await runWakeThroughWindows(c.ctx);
    expect(c.claims()).toBe(1);
    const withIns = disp.inputs.filter((i) => i.promptText.includes('Skip Acme this week')).map((i) => i.window);
    expect(withIns).toEqual(['pipeline']);
  });

  it('an item without a final report line is incomplete and NOT continued; the next item still runs', async () => {
    const disp: FakeDispatcher = new FakeDispatcher((i, n) => (i.window === 'boards' ? { status: 'ok', stopReason: 'end_turn', summary: 'I did some things', toolCalls: 1, runId: `w-${n}` } : disp.ok(i, n)));
    const c = ctxFor(mixedItems(), disp);
    const r = await runWakeThroughWindows(c.ctx);
    expect(disp.inputs.filter((i) => i.window === 'boards')).toHaveLength(2); // once per item, never re-typed
    expect(disp.inputs.map((i) => i.window)).toContain('apply');
    expect(r.status).toBe('incomplete');
    expect(r.stopReason).toMatch(/boards: incomplete/);
    expect(r.stopReason).toMatch(/no final report line/);
    expect(r.stopReason).toMatch(/not continued/);
  });

  it('a report that lacks one of the item steps leaves that step unproven (incomplete)', async () => {
    const disp: FakeDispatcher = new FakeDispatcher((i, n) => {
      if (i.window !== 'boards') return disp.ok(i, n);
      return { status: 'ok', stopReason: 'end_turn', summary: JSON.stringify({ run_id: 'wake0001', operators: [{ operator: 'naukri-operator', platform: 'naukri', tasks: [{ kind: 'manual_url', done: 1 }] }] }), toolCalls: 1, runId: `w-${n}` };
    });
    const r = await runWakeThroughWindows(ctxFor(mixedItems(), disp).ctx);
    expect(r.status).toBe('incomplete');
    expect(r.stopReason).toMatch(/unproven steps: .*wellfound/);
  });

  it('a report for another run id proves nothing', async () => {
    const disp: FakeDispatcher = new FakeDispatcher((i, n) => ({ ...disp.ok(i, n), summary: '{"run_id":"other","operators":[]}' }));
    const r = await runWakeThroughWindows(ctxFor(mixedItems().slice(0, 1), disp).ctx);
    expect(r.status).toBe('incomplete');
    expect(r.items[0].status).toBe('incomplete');
  });

  it('maps failed, stalled and timeout results (none is continued; later items still run)', async () => {
    const mk = (status: DispatchResult['status'], stopReason: string) => new FakeDispatcher((i, n) => (i.window === 'sources' ? { status, stopReason, summary: '', toolCalls: 0, runId: `w-${n}` } : new FakeDispatcher().ok(i, n)));
    for (const [status, reason, expected] of [['failed', 'api_error', 'failed'], ['stalled', 'stalled', 'incomplete'], ['timeout', 'wall_clock', 'timeout']] as const) {
      const disp = mk(status, reason);
      const r = await runWakeThroughWindows(ctxFor(mixedItems(), disp).ctx);
      expect(r.items[0].status).toBe(expected);
      expect(r.items[0].reason).toContain(reason);
      expect(disp.inputs).toHaveLength(7);
      expect(r.status).toBe('incomplete');
    }
  });

  it('a window busy at first is retried and then used (no headless, one item typed)', async () => {
    let busy = 2;
    const disp = new FakeDispatcher((i, n) => (i.window === 'sources' && busy-- > 0 ? { status: 'unavailable', stopReason: 'window_busy', summary: '', toolCalls: 0 } : new FakeDispatcher().ok(i, n)));
    const c = ctxFor(mixedItems(), disp);
    const t0 = c.clock();
    const r = await runWakeThroughWindows(c.ctx);
    expect(c.clock() - t0).toBeGreaterThanOrEqual(20_000);
    expect(c.headlessCalls).toHaveLength(0);
    expect(r.status).toBe('ok');
  });

  it('a window busy for the whole wait is SKIPPED with a handoff entry; the other items still run; the notice reason says so', async () => {
    const disp = new FakeDispatcher((i, n) => (i.window === 'linkedin' ? { status: 'unavailable', stopReason: 'window_busy', summary: '', toolCalls: 0 } : new FakeDispatcher().ok(i, n)));
    const c = ctxFor(mixedItems(), disp);
    const r = await runWakeThroughWindows(c.ctx);
    expect(c.headlessCalls).toHaveLength(0); // never double-run in a headless session
    expect(r.status).toBe('incomplete');
    expect(r.stopReason).toMatch(/linkedin: skipped \(window_busy\)/);
    const h = listHandoff(c.root);
    expect(h.some((e) => e.window === 'linkedin' && /wake steps/.test(e.what) && /window_busy/.test(e.why))).toBe(true);
    expect(disp.inputs.map((i) => i.window)).toContain('apply');
    expect(r.items.filter((x) => x.status === 'skipped')).toHaveLength(2);
  });

  it('a window that is unavailable after the bounded start wait: its items are skipped (nothing runs elsewhere), handoff entry, one alert per hour, the rest of the wake still runs', async () => {
    const disp = new FakeDispatcher((i, n) => (i.window === 'boards' ? { status: 'unavailable', stopReason: 'window_unavailable:window_missing:not_ready', summary: '', toolCalls: 0 } : new FakeDispatcher().ok(i, n)));
    const c = ctxFor(mixedItems(), disp);
    const posts: string[] = [];
    (c.ctx.d as { tg?: unknown }).tg = async (_t: string, text: string) => void posts.push(text);
    const r = await runWakeThroughWindows(c.ctx);
    expect(c.headlessCalls).toHaveLength(0);
    expect(r.status).toBe('incomplete');
    expect(r.items.filter((x) => x.status === 'skipped' && x.window === 'boards')).toHaveLength(2);
    expect(disp.inputs.map((i) => i.window)).toContain('apply');
    expect(listHandoff(c.root).some((e) => e.window === 'boards' && /window unavailable/.test(e.why))).toBe(true);
    expect(posts.filter((t) => /Window boards is not available/.test(t))).toHaveLength(1);
  });

  it('with no dispatcher at all nothing runs: every item is skipped', async () => {
    const c = ctxFor(mixedItems(), undefined);
    const r = await runWakeThroughWindows(c.ctx);
    expect(r.sessionRan).toBe(false);
    expect(r.items.every((x) => x.status === 'skipped' && x.reason === 'no_dispatcher')).toBe(true);
    expect(r.status).toBe('incomplete');
  });

  it('usage_limit from a window sets usage_backoff_until, adds a handoff entry, finishes the item and stops the rest of the wake', async () => {
    const disp = new FakeDispatcher((i, n) => (i.window === 'linkedin' ? { status: 'usage_limit', stopReason: 'usage_limit', summary: '', toolCalls: 2, runId: `w-${n}` } : new FakeDispatcher().ok(i, n)));
    const c = ctxFor(mixedItems(), disp, { env: { USAGE_LIMIT_BACKOFF_MIN: '60' } });
    const r = await runWakeThroughWindows(c.ctx);
    expect(r.status).toBe('usage_limit');
    expect(disp.inputs.map((i) => i.window)).toEqual(['sources', 'linkedin']);
    expect(disp.finished).toHaveLength(2);
    const until = getState(c.db, 'usage_backoff_until');
    expect(until).toBeTruthy();
    expect(Date.parse(until as string) - NOON_IST.getTime()).toBe(60 * 60_000);
    expect(listHandoff(c.root).some((e) => /usage limit/.test(e.why))).toBe(true);
  });

  it('a kill mid-wake (dispatcher result killed) stops dispatching', async () => {
    const disp = new FakeDispatcher((i, n) => (i.window === 'boards' ? { status: 'killed', stopReason: 'killed', summary: '', toolCalls: 0, runId: `w-${n}` } : new FakeDispatcher().ok(i, n)));
    const r = await runWakeThroughWindows(ctxFor(mixedItems(), disp).ctx);
    expect(r.status).toBe('killed');
    expect(disp.inputs.map((i) => i.window)).toEqual(['sources', 'linkedin', 'boards']);
  });

  it('the kill switch, quiet hours or a shutdown seen between items stops dispatching', async () => {
    for (const why of ['kill_switch', 'quiet_hours', 'shutdown']) {
      const disp = new FakeDispatcher();
      let n = 0;
      const r = await runWakeThroughWindows(ctxFor(mixedItems(), disp, { stop: () => (n++ >= 2 ? why : null) }).ctx);
      expect(r.status).toBe('killed');
      expect(r.stopReason).toContain(why);
      expect(disp.inputs).toHaveLength(2);
    }
  });

  it('a dispatcher that reports a kill while waiting for a busy window stops too', async () => {
    const disp = new FakeDispatcher(() => ({ status: 'unavailable', stopReason: 'window_busy', summary: '', toolCalls: 0 }));
    let n = 0;
    const r = await runWakeThroughWindows(ctxFor(mixedItems(), disp, { stop: () => (n++ >= 2 ? 'kill_switch' : null) }).ctx);
    expect(r.status).toBe('killed');
  });

  it('dry-run guard: a window recorded as started live while the scheduler is dry gets nothing typed', async () => {
    const disp = new FakeDispatcher();
    const c = ctxFor(mixedItems(), disp, { dry: true });
    mkdirSync(join(c.root, '.jobber', 'window-start'), { recursive: true });
    writeFileSync(join(c.root, '.jobber', 'window-start', 'boards.json'), JSON.stringify({ JOBBER_DRY_RUN: 'false' }));
    writeFileSync(join(c.root, '.jobber', 'window-start', 'apply.json'), JSON.stringify({ JOBBER_DRY_RUN: 'true' }));
    const r = await runWakeThroughWindows(c.ctx);
    expect(disp.inputs.map((i) => i.window)).not.toContain('boards');
    expect(disp.inputs.map((i) => i.window)).toContain('apply');
    expect(r.items.filter((x) => x.reason === 'window_started_live_but_dry_run_now')).toHaveLength(2);
    expect(c.headlessCalls).toHaveLength(0);
    expect(windowStartedLive(c.root, 'boards', true)).toBe(true);
    expect(windowStartedLive(c.root, 'boards', false)).toBe(false); // a live scheduler never blocks
    expect(windowStartedLive(c.root, 'sources', true)).toBe(false); // no record: no opinion
  });

  it('a throwing dispatcher is recorded as a failed item and never escapes', async () => {
    const disp = new FakeDispatcher(() => { throw new Error('tmux exploded'); });
    const r = await runWakeThroughWindows(ctxFor(mixedItems(), disp).ctx);
    expect(r.status).toBe('failed');
    expect(r.stopReason).toMatch(/tmux exploded/);
  });
});

describe('start-time record of the wake windows', () => {
  it('records the dry-run flag and the caps, no secrets, and diffs against .env', () => {
    const v = wakeStartValues({
      JOBBER_DRY_RUN: 'true', MAX_APPLIES_PER_DAY: '5', APPLY_MAX_ATTEMPTS_PER_DAY: '9', NAUKRI_MAX_MESSAGES_PER_DAY: '3',
      LINKEDIN_MAX_INVITES_PER_DAY: '20', HUNTER_API_KEY: 'sk-secret', PATH: '/bin', SCOUT_ALLOW_SIGNUP: 'false',
    });
    expect(v).toMatchObject({ JOBBER_DRY_RUN: 'true', MAX_APPLIES_PER_DAY: '5', APPLY_MAX_ATTEMPTS_PER_DAY: '9', NAUKRI_MAX_MESSAGES_PER_DAY: '3', LINKEDIN_MAX_INVITES_PER_DAY: '20' });
    expect(JSON.stringify(v)).not.toContain('sk-secret');
    expect(v.PATH).toBeUndefined();
    expect(wakeStartDiff({ ...v, at: 'x' }, { JOBBER_DRY_RUN: 'false', MAX_APPLIES_PER_DAY: '5' })).toContain('JOBBER_DRY_RUN');
    expect(wakeStartDiff(v, { ...v })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
function driverSetup(o: { env: NodeJS.ProcessEnv; disp?: FakeDispatcher | WindowDispatcher; withConfig?: boolean }) {
  const dir = tmp('ww-drv-');
  mkdirSync(join(dir, 'config'));
  if (o.withConfig !== false) copyFileSync(join(ROOT, 'config/manager-windows.json'), join(dir, 'config/manager-windows.json'));
  let t = NOON_IST.getTime();
  const notices: Notice[] = [];
  const tg: Array<{ topic: string; text: string }> = [];
  const db = openDb(':memory:');
  // One unscored job: the plan has a pipeline step (and the apply step it pulls in).
  saveJob(db, { id: 'j1', source: 'greenhouse', title: 'React Developer', company: 'Acme', url: 'https://x.test/j1', apply_url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'Location: Remote\n\nbody' });
  const d: DriverDeps = {
    db, now: () => new Date(t), rng: () => 0.5, sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(o.env), tuning: loadTuning(o.env), env: o.env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), projectRoot: dir,
    notifier: { notify: async (n) => void notices.push(n) },
    tg: async (topic, text) => void tg.push({ topic, text }),
    newRunId: (() => { let i = 0; return () => `wk${String(++i).padStart(8, '0')}`; })(),
    windows: o.disp as unknown as WindowDispatcher | undefined,
  };
  return { d, db, dir, launcher: { starts: [] as unknown[] }, notices, tg, advance: (ms: number) => void (t += ms) };
}

describe('the wake lane through the driver', () => {
  it('a forced wake (a /runhunt request read by the daemon) takes the same road through the windows; only the trigger differs', async () => {
    const disp = new FakeDispatcher();
    const s = driverSetup({ env: {}, disp });
    const r = await wakeOnce(s.d, { force: true });
    expect(disp.inputs.map((i) => i.window)).toEqual(['pipeline', 'boards', 'apply']);
    expect(listRuns(s.db).find((x) => x.id === r.runId)?.trigger).toBe('forced');
    expect(s.launcher.starts).toHaveLength(0);
  });

  it('no dispatcher: nothing runs anywhere and the wake is incomplete', async () => {
    const s = driverSetup({ env: {}, disp: undefined });
    const r = await wakeOnce(s.d, { force: true });
    expect(r.status).toBe('incomplete');
    expect(s.launcher.starts).toHaveLength(0);
  });

  it('the pipeline and apply items go to their windows, the wake row and the notice look like today', async () => {
    const disp = new FakeDispatcher();
    const s = driverSetup({ env: {}, disp });
    const r = await wakeOnce(s.d);
    expect(disp.inputs.map((i) => i.window)).toEqual(['pipeline', 'boards', 'apply']);
    expect(s.launcher.starts).toHaveLength(0);
    expect(r.status).toBe('ok');
    const row = listRuns(s.db).find((x) => x.id === r.runId);
    expect(row?.status).toBe('ok');
    expect(row?.trigger).toBe('scheduled');
    // the same Telegram wakes-topic message as a headless wake: id, status, trigger, counts line, new jobs line
    const n = s.tg.find((x) => x.topic === 'wakes');
    expect(n?.text).toMatch(/^✅ <b>Wake ok<\/b>\n<b>Run:<\/b> <code>wk000000<\/code>/);
    expect(n?.text).toContain('<b>Trigger:</b> scheduled');
    expect(n?.text).toMatch(/<b>Operators<\/b>\n• done \d+, skipped 0/);
    // the owner's instructions were claimed for the pipeline item only
    expect(disp.inputs[0].promptText).toContain('Pipeline stage (');
    expect(disp.inputs[1].promptText).not.toContain('Pipeline stage (');
    expect(disp.inputs[1].promptText).toContain('naukri-operator');
  });

  it('the windows are not usable: every item is skipped, the wake is incomplete, nothing runs headless, no scheduler_runs row for an item that was never typed', async () => {
    const disp = new FakeDispatcher(() => ({ status: 'unavailable', stopReason: 'window_unavailable:window_missing:not_ready', summary: '', toolCalls: 0 }));
    const s = driverSetup({ env: {}, disp });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('incomplete');
    expect(r.reason).toMatch(/window_unavailable/);
    expect(s.launcher.starts).toHaveLength(0);
    expect(listRuns(s.db).filter((x) => x.trigger === 'wake')).toHaveLength(0);
    expect(listRuns(s.db).every((x) => x.status !== 'running')).toBe(true);
  });

  it('a dry run with a live-started window types nothing and the wake is incomplete (nothing was double-run)', async () => {
    const disp = new FakeDispatcher();
    const s = driverSetup({ env: { JOBBER_DRY_RUN: 'true' }, disp });
    mkdirSync(join(s.dir, '.jobber', 'window-start'), { recursive: true });
    writeFileSync(join(s.dir, '.jobber', 'window-start', 'pipeline.json'), JSON.stringify({ JOBBER_DRY_RUN: 'false' }));
    const r = await wakeOnce(s.d);
    expect(disp.inputs.map((i) => i.window)).toEqual(['boards', 'apply']);
    expect(r.status).toBe('incomplete');
    expect(r.reason).toMatch(/window_started_live_but_dry_run_now/);
    expect(s.launcher.starts).toHaveLength(0);
  });

  it('usage_limit in a window sets the backoff, the wake row is usage_limit, and the alert notice goes out', async () => {
    const disp = new FakeDispatcher((i, n) => ({ status: 'usage_limit', stopReason: 'usage_limit', summary: '', toolCalls: 0, runId: `w-${n}` }));
    const s = driverSetup({ env: {}, disp });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('usage_limit');
    expect(getState(s.db, 'usage_backoff_until')).toBeTruthy();
    expect(disp.inputs).toHaveLength(1);
    expect(s.tg.some((x) => x.topic === 'alerts' && /usage_limit/.test(x.text))).toBe(true);
    // the next wake is refused by the backoff in the driver, as for a headless run
    const again = await wakeOnce(s.d);
    expect(again.status).toBe('skipped');
    expect(again.reason).toMatch(/usage_backoff/);
  });

  it('an incomplete item makes the wake incomplete, goes to the alerts topic with the reason, and is not continued', async () => {
    const disp = new FakeDispatcher((i, n) => ({ status: 'ok', stopReason: 'end_turn', summary: 'done, no json', toolCalls: 1, runId: `w-${n}` }));
    const s = driverSetup({ env: {}, disp });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('incomplete');
    expect(disp.inputs).toHaveLength(3); // pipeline, boards and apply, each typed once
    expect(s.launcher.starts).toHaveLength(0);
    const a = s.tg.find((x) => x.topic === 'alerts');
    expect(a?.text).toMatch(/incomplete/);
    expect(a?.text).toMatch(/pipeline: incomplete/);
  });

  it('manual request report still runs after a windows wake', async () => {
    const disp = new FakeDispatcher();
    const s = driverSetup({ env: {}, disp });
    const seen: string[] = [];
    s.d.manualReport = async (st) => void seen.push(st);
    await wakeOnce(s.d);
    expect(seen).toEqual(['ok']);
  });

});

describe('guards of the wake windows', () => {
  it('window-guard SCREENED_TOOLS (13 tools; send_email has its own rule) denies secret-shaped arguments in each', () => {
    const guard = req('../.claude/hooks/window-guard.cjs') as {
      decide: (e: unknown, o: { root: string; env: Record<string, string> }) => { allow: boolean };
      SCREENED_TOOLS: Set<string>;
    };
    const wake = [...guard.SCREENED_TOOLS];
    expect(wake).toHaveLength(13);
    const o = { root: ROOT, env: {} as Record<string, string> };
    for (const t of wake) {
      expect(guard.decide({ tool_name: t, tool_input: { text: 'hello' } }, o).allow).toBe(true);
      expect(guard.decide({ tool_name: t, tool_input: { a: { text: 'see secrets/x.json' } } }, o).allow).toBe(false);
    }
    expect(guard.decide({ tool_name: 'mcp__gmail__send_email', tool_input: { body: 'cat .env' } }, o).allow).toBe(false);
  });

  it('the window-guard reuses the tool-allowlist helper (no second copy of the secret regexes)', () => {
    const src = readFileSync(join(ROOT, '.claude/hooks/window-guard.cjs'), 'utf8');
    expect(src).toContain('allowlist.screenSecretArgs');
    expect(src).not.toMatch(/SECRET_ARG_RES|secrets\\\//);
  });

  it('every operator tool bound is unchanged: the agent files still match config/worker-tools.json, and no wake window config sets JOBBER_RUN_LANE', () => {
    const wt = JSON.parse(readFileSync(join(ROOT, 'config/worker-tools.json'), 'utf8')) as Record<string, unknown>;
    const listed = JSON.stringify(wt);
    for (const op of ['source-operator', 'naukri-operator', 'wellfound-operator', 'apply-operator', 'linkedin-operator']) {
      const md = readFileSync(join(ROOT, `.claude/agents/${op}.md`), 'utf8');
      const tools = (/^tools:\s*(.*)$/m.exec(md)?.[1] ?? '').split(',').map((x) => x.trim()).filter((x) => x.startsWith('mcp__'));
      expect(tools.length, op).toBeGreaterThan(0);
      for (const t of tools) expect(listed, `${op} ${t}`).toContain(t);
      expect(tools, op).not.toContain('mcp__gmail__send_email');
    }
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config/manager-windows.json'), 'utf8')) as { windows: Record<string, { lane?: string; env?: Record<string, string> }> };
    for (const w of ['sources', 'pipeline', 'boards', 'apply']) {
      expect(cfg.windows[w].lane).toBe('wake');
      expect(cfg.windows[w].env?.JOBBER_RUN_LANE).toBeUndefined();
    }
  });
});
