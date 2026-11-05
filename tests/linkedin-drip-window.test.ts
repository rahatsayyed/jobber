// Phase 3b: the LinkedIn drip lane through the long-lived `linkedin` window (WINDOW_LANES contains `linkedin`). Fakes only: fake clock,
// fake dispatcher or fake tmux, in-memory db. Nothing touches LinkedIn, no tmux, no claude.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { listHandoff } from '../src/platform/handoff.js';
import { loadManagerConfig } from '../src/platform/manager.js';
import { buildWindowEnv } from '../src/platform/windowEnv.js';
import { takeWindowLock } from '../src/platform/windowLock.js';
import type { Run } from '../src/platform/tmux.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import type { LaunchHandle, LaunchPlan, Launcher, PollResult } from '../src/scheduler/launch.js';
import type { Notice } from '../src/scheduler/notify.js';
import { linkedinDripTick, LI_STATE_INBOX_AT, LI_STATE_LAST_AT } from '../src/scheduler/linkedinDrip.js';
import { linkedinStartDiff, linkedinStartValues } from '../src/scheduler/linkedinWindowStart.js';
import { getState, listRuns, setState, startRun } from '../src/scheduler/runLog.js';
import { WindowDispatcher, type DispatchInput, type DispatchResult } from '../src/scheduler/windowDispatch.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const req = createRequire(import.meta.url);
const NOON_IST = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST, inside the active hours
const EVENING = new Date('2026-10-15T15:30:00.000Z'); // 21:00 IST, after the active hours
const QUIET = new Date('2026-10-14T21:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

class FakeLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    return { runId: plan.runId, session: plan.session, window: `w-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> {
    return { exited: true, exitCode: 0, newOutput: '' };
  }
  async kill(): Promise<void> {}
}

class FakeDispatcher {
  inputs: DispatchInput[] = [];
  finished: string[] = [];
  reply: (i: DispatchInput, n: number) => DispatchResult = () => ({ status: 'ok', stopReason: 'end_turn', summary: '', toolCalls: 1, runId: 'w-run' });
  async dispatch(i: DispatchInput): Promise<DispatchResult> {
    this.inputs.push(i);
    return this.reply(i, this.inputs.length);
  }
  async finish(id: string): Promise<{ cleared: boolean }> {
    this.finished.push(id);
    return { cleared: true };
  }
}

function setup(opts: { start?: Date; env?: NodeJS.ProcessEnv; stopExists?: () => boolean; withWindows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'li-win-'));
  dirs.push(dir);
  let t = (opts.start ?? NOON_IST).getTime();
  const env = opts.env ?? { WINDOW_LANES: 'linkedin' };
  const notices: Notice[] = [];
  const db = openDb(':memory:');
  const launcher = new FakeLauncher();
  const fake = new FakeDispatcher();
  const d: DriverDeps = {
    db, now: () => new Date(t), rng: () => 0, sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), runDir: join(dir, 'runs'), projectRoot: dir,
    launcher, notifier: { notify: async (n) => void notices.push(n) },
    newRunId: (() => { let i = 0; return () => `lidrip${String(++i).padStart(6, '0')}`; })(),
    control: opts.stopExists ? { exists: opts.stopExists, read: () => 'stop it' } : undefined,
    pollMs: 5000,
    windows: opts.withWindows === false ? undefined : (fake as unknown as WindowDispatcher),
  };
  return { d, db, dir, launcher, fake, notices, advance: (ms: number) => void (t += ms), setNow: (x: Date) => void (t = x.getTime()), now: () => new Date(t) };
}

// With no seed the first due item is the inbox read.
describe('linkedin lane through the window', () => {
  it('lane off: the old headless path runs and the dispatcher is never used', async () => {
    const s = setup({ env: {} });
    await linkedinDripTick(s.d);
    expect(s.launcher.starts).toHaveLength(1);
    expect(s.fake.inputs).toHaveLength(0);
  });

  it('lane on but no dispatcher object (a --once or --now process): headless', async () => {
    const s = setup({ withWindows: false });
    await linkedinDripTick(s.d);
    expect(s.launcher.starts).toHaveLength(1);
  });

  it('only the linkedin lane enables it: WINDOW_LANES=mail leaves LinkedIn headless', async () => {
    const s = setup({ env: { WINDOW_LANES: 'mail' } });
    await linkedinDripTick(s.d);
    expect(s.launcher.starts).toHaveLength(1);
    expect(s.fake.inputs).toHaveLength(0);
  });

  it('lane on: window linkedin gets the item, the headless launcher is unused, the prompt is identical to the headless one, then finish()', async () => {
    const headless = setup({ env: {} });
    await linkedinDripTick(headless.d);
    const win = setup();
    win.fake.reply = () => ({ status: 'ok', stopReason: 'end_turn', summary: 'x', toolCalls: 3, runId: 'w-run-1' });
    const r = await linkedinDripTick(win.d);
    expect(r).toMatchObject({ status: 'ran', item: 'inbox' });
    expect(win.launcher.starts).toHaveLength(0);
    const i = win.fake.inputs[0];
    expect(i).toMatchObject({ window: 'linkedin', lane: 'linkedin', trigger: 'linkedin_drip', dryRun: false });
    expect(i.item).toMatchObject({ operator: 'linkedin-operator', kind: 'inbox', quota: 1, item: 'inbox' });
    expect(i.promptText).toBe(headless.launcher.starts[0].prompt);
    expect(i.deadlineMs).toBe(3600 * 1000);
    expect(win.fake.finished).toEqual(['w-run-1']);
    expect(win.notices).toHaveLength(0);
  });

  it('failed, stalled, timeout and killed results map like the headless statuses, warn the owner and still finish() (the /clear)', async () => {
    const want: Record<string, string> = { failed: 'failed', stalled: 'failed', timeout: 'budget_exceeded', killed: 'killed' };
    for (const status of ['failed', 'stalled', 'timeout', 'killed'] as const) {
      const s = setup();
      s.fake.reply = () => ({ status, stopReason: status, summary: '', toolCalls: 1, runId: 'w1' });
      const r = await linkedinDripTick(s.d);
      expect(r.run).toMatchObject({ status: want[status] });
      expect(s.notices.some((n) => /did not end cleanly/.test(n.title))).toBe(true);
      expect(s.fake.finished).toEqual(['w1']);
      // the item is stamped as tried / read, like the headless path: a failing item is not retried at once
      expect(getState(s.db, LI_STATE_INBOX_AT)).not.toBeNull();
    }
  });

  it('usage_limit: usage_backoff_until set, handoff entry added, finish() called, the next tick is held by the gate', async () => {
    const s = setup({ env: { WINDOW_LANES: 'linkedin', USAGE_LIMIT_BACKOFF_MIN: '60' } });
    s.fake.reply = () => ({ status: 'usage_limit', stopReason: 'usage_limit', summary: '', toolCalls: 0, runId: 'w1' });
    const r = await linkedinDripTick(s.d);
    expect(r.run).toMatchObject({ status: 'usage_limit' });
    expect(Date.parse(getState(s.db, 'usage_backoff_until') as string)).toBe(NOON_IST.getTime() + 60 * 60000);
    const h = listHandoff(s.dir);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ window: 'linkedin' });
    expect(h[0].what).toMatch(/^skipped: linkedin inbox/);
    expect(h[0].why).toMatch(/usage limit/);
    expect(s.fake.finished).toEqual(['w1']);
    s.advance(30 * 60000);
    expect(await linkedinDripTick(s.d)).toMatchObject({ status: 'skipped', reason: 'usage_backoff' });
    expect(s.fake.inputs).toHaveLength(1);
  });

  it('window_busy: nothing typed, stamps restored so the item stays due, no alert, no headless, no finish()', async () => {
    const s = setup();
    s.fake.reply = () => ({ status: 'unavailable', stopReason: 'window_busy', summary: '', toolCalls: 0 });
    const r = await linkedinDripTick(s.d);
    expect(r.run).toMatchObject({ skipped: true });
    expect(s.launcher.starts).toHaveLength(0);
    expect(s.fake.finished).toEqual([]);
    expect(s.notices).toHaveLength(0);
    expect(getState(s.db, LI_STATE_INBOX_AT)).toBe(''); // not read: inbox is still due
    expect(getState(s.db, LI_STATE_LAST_AT)).toBe('');
    // after the normal gap the same item is offered again and now goes through
    s.advance(25 * 60000);
    s.fake.reply = () => ({ status: 'ok', stopReason: 'end_turn', summary: '', toolCalls: 1, runId: 'w2' });
    expect(await linkedinDripTick(s.d)).toMatchObject({ status: 'ran', item: 'inbox' });
    expect(s.fake.finished).toEqual(['w2']);
  });

  it('window missing or not claude: that item runs headless, one warning only', async () => {
    const s = setup();
    s.fake.reply = () => ({ status: 'unavailable', stopReason: 'window_missing', summary: '', toolCalls: 0 });
    const r = await linkedinDripTick(s.d);
    expect(r).toMatchObject({ status: 'ran' });
    expect(s.launcher.starts).toHaveLength(1);
    expect(s.launcher.starts[0].profile).toBe('linkedin_drip');
    expect(s.notices.filter((n) => /linkedin window unavailable/.test(n.title))).toHaveLength(1);
    expect(listRuns(s.db, 10).filter((x) => x.trigger === 'linkedin_drip')).toHaveLength(1); // one run row: no double action
  });

  it('other dispatcher refusals send nothing and never fall back to headless', async () => {
    for (const why of ['usage_backoff', 'killed', 'send_failed', 'invalid:prompt']) {
      const s = setup();
      s.fake.reply = () => ({ status: 'unavailable', stopReason: why, summary: '', toolCalls: 0 });
      await linkedinDripTick(s.d);
      expect(s.launcher.starts).toHaveLength(0);
      expect(getState(s.db, LI_STATE_INBOX_AT)).toBe('');
    }
  });

  it('dry run: the dispatcher gets dryRun true and the prompt says so', async () => {
    const s = setup({ env: { WINDOW_LANES: 'linkedin', JOBBER_DRY_RUN: 'true' } });
    await linkedinDripTick(s.d);
    expect(s.fake.inputs[0].dryRun).toBe(true);
    expect(s.fake.inputs[0].promptText).toMatch(/Dry run: yes/);
  });

  it('dry run in the scheduler but the window started live (record in .jobber/window-start): nothing is typed', async () => {
    const s = setup({ env: { WINDOW_LANES: 'linkedin', JOBBER_DRY_RUN: 'true' } });
    mkdirSync(join(s.dir, '.jobber', 'window-start'), { recursive: true });
    const rec = join(s.dir, '.jobber', 'window-start', 'linkedin.json');
    writeFileSync(rec, JSON.stringify({ JOBBER_DRY_RUN: '' }));
    const r = await linkedinDripTick(s.d);
    expect(r.run).toMatchObject({ skipped: true, reason: 'window_started_live_but_dry_run_now' });
    expect(s.fake.inputs).toHaveLength(0);
    expect(s.launcher.starts).toHaveLength(0);
    writeFileSync(rec, JSON.stringify({ JOBBER_DRY_RUN: 'true' }));
    s.advance(25 * 60000);
    await linkedinDripTick(s.d);
    expect(s.fake.inputs).toHaveLength(1);
  });

  it('a live scheduler with a window that started dry is allowed to type (the window only records)', async () => {
    const s = setup();
    mkdirSync(join(s.dir, '.jobber', 'window-start'), { recursive: true });
    writeFileSync(join(s.dir, '.jobber', 'window-start', 'linkedin.json'), JSON.stringify({ JOBBER_DRY_RUN: 'true' }));
    await linkedinDripTick(s.d);
    expect(s.fake.inputs).toHaveLength(1);
  });
});

describe('gates come before any text is typed', () => {
  it('quiet hours, outside active hours, kill switch, linkedin halt, spacing, wake running, usage backoff: dispatcher untouched', async () => {
    const evening = setup({ start: EVENING });
    expect(await linkedinDripTick(evening.d)).toMatchObject({ reason: 'outside_active_hours' });
    const quiet = setup({ start: QUIET });
    expect(await linkedinDripTick(quiet.d)).toMatchObject({ reason: 'quiet_hours' });
    const killed = setup({ stopExists: () => true });
    expect(await linkedinDripTick(killed.d)).toMatchObject({ reason: 'killed' });
    const halted = setup();
    haltPlatform(halted.db, 'linkedin', 'test', halted.now());
    expect(await linkedinDripTick(halted.d)).toMatchObject({ reason: 'halted' });
    const spaced = setup();
    setState(spaced.db, LI_STATE_LAST_AT, spaced.now().toISOString(), spaced.now());
    expect(await linkedinDripTick(spaced.d)).toMatchObject({ reason: 'spacing' });
    const wake = setup();
    startRun(wake.db, { id: 'wake1', at: wake.now(), trigger: 'scheduled', dryRun: false, tasks: [{ operator: 'linkedin-operator', kind: 'discover', quota: 1 }], status: 'running' });
    expect(await linkedinDripTick(wake.d)).toMatchObject({ reason: 'wake_running' });
    const backoff = setup();
    setState(backoff.db, 'usage_backoff_until', new Date(backoff.now().getTime() + 3600_000).toISOString(), backoff.now());
    expect(await linkedinDripTick(backoff.d)).toMatchObject({ reason: 'usage_backoff' });
    for (const x of [evening, quiet, killed, halted, spaced, wake, backoff]) expect(x.fake.inputs).toHaveLength(0);
  });

  it('with the real dispatcher and a fake tmux: a failed gate types nothing', async () => {
    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { stdout: '0|linkedin|0|claude', code: 0 }; };
    const s = setup({ start: EVENING });
    s.d.windows = new WindowDispatcher({ root: s.dir, session: 'Jobber', run, db: s.db, killed: () => false });
    await linkedinDripTick(s.d);
    expect(calls.filter((c) => c[0] === 'send-keys')).toHaveLength(0);
  });

  it('with the real dispatcher: missing window falls back to headless, a busy window skips with nothing typed', async () => {
    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { stdout: '', code: 0 }; };
    const s = setup();
    s.d.windows = new WindowDispatcher({ root: s.dir, session: 'Jobber', run, db: s.db, killed: () => false });
    await linkedinDripTick(s.d);
    expect(s.launcher.starts).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'send-keys')).toHaveLength(0);

    const calls2: string[][] = [];
    const run2: Run = async (_c, args) => { calls2.push(args); return { stdout: args[0] === 'list-windows' ? '0|linkedin|0|claude' : '', code: 0 }; };
    const b = setup();
    b.d.windows = new WindowDispatcher({ root: b.dir, session: 'Jobber', run: run2, db: b.db, killed: () => false });
    const lock = takeWindowLock(b.dir, 'linkedin', 'other');
    expect(lock).not.toBeNull();
    const r = await linkedinDripTick(b.d);
    expect(r.run).toMatchObject({ skipped: true });
    expect(b.launcher.starts).toHaveLength(0);
    expect(calls2.filter((c) => c[0] === 'send-keys')).toHaveLength(0);
    lock?.release();
  });
});

describe('window config and the Easy Apply lane marker', () => {
  const shipped = loadManagerConfig(readFileSync(join(ROOT, 'config/manager-windows.json'), 'utf8'));
  const base = { HOME: '/home/x', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-secret', TELEGRAM_BOT_TOKEN: '1:a', LINKEDIN_SESSION_TOKEN: 'tok' };
  const dotenv = { LINKEDIN_MAX_INVITES_PER_DAY: '12', APPLY_LINKEDIN_EASY: 'true', MAX_APPLIES_PER_DAY: '3', EMAIL_MAX_PER_DAY: '9', SERPER_API_KEY: 'k', JOBBER_DRY_RUN: 'true' };

  it('the linkedin window is a worker with its own role file; its marker equals what the headless lane passes', () => {
    const w = shipped.windows.linkedin;
    expect(w).toMatchObject({ kind: 'worker', lane: 'linkedin', role_prompt: 'config/windows/linkedin.md' });
    const role = readFileSync(join(ROOT, w.role_prompt as string), 'utf8');
    expect(role).toMatch(/linkedin-operator/);
    expect(role).toMatch(/linkedin_close/);
    // headless: dripEnv() sets JOBBER_RUN_LANE = LI_DRIP_TRIGGER = 'linkedin_drip' and launch.ts accepts exactly that value
    expect(readFileSync(join(ROOT, 'src/scheduler/linkedinDrip.ts'), 'utf8')).toMatch(/out\.JOBBER_RUN_LANE = LI_DRIP_TRIGGER/);
    expect(w.env?.JOBBER_RUN_LANE).toBe('linkedin_drip');
    expect(readFileSync(join(ROOT, 'src/browserctl/arm/linkedinEasyApply.ts'), 'utf8')).toMatch(/JOBBER_RUN_LANE !== 'linkedin_drip'/);
  });

  it('the window env has what the operator MCP path needs, the fixed marker, a short idle close, and no secrets', () => {
    const env = buildWindowEnv('linkedin', shipped.windows.linkedin, base, dotenv);
    expect(env).toMatchObject({
      JOBBER_RUN_LANE: 'linkedin_drip', LINKEDIN_IDLE_MS: '60000', LINKEDIN_MAX_INVITES_PER_DAY: '12',
      APPLY_LINKEDIN_EASY: 'true', MAX_APPLIES_PER_DAY: '3', JOBBER_DRY_RUN: 'true',
    });
    for (const k of Object.keys(env)) expect(/KEY|TOKEN|SECRET|PASSWORD|ANTHROPIC|TELEGRAM/.test(k)).toBe(false);
    expect(env.EMAIL_MAX_PER_DAY).toBeUndefined();
    expect(env.SERPER_API_KEY).toBeUndefined();
    // .env cannot override the fixed markers
    expect(buildWindowEnv('linkedin', shipped.windows.linkedin, base, { ...dotenv, LINKEDIN_IDLE_MS: '3600000' }).LINKEDIN_IDLE_MS).toBe('60000');
  });

  it('every other window gets a different marker, so Easy Apply stays closed there', () => {
    const mail = buildWindowEnv('mail', shipped.windows.mail, base, dotenv);
    expect(mail.JOBBER_RUN_LANE).toBe('mail');
    expect(mail.JOBBER_RUN_LANE).not.toBe('linkedin_drip');
    for (const [name, w] of Object.entries(shipped.windows)) {
      if (name === 'linkedin') continue;
      expect(buildWindowEnv(name, w, base, dotenv).JOBBER_RUN_LANE).not.toBe('linkedin_drip');
    }
  });

  it('start-time record: values and diff', () => {
    const v = linkedinStartValues({ JOBBER_DRY_RUN: 'true', APPLY_LINKEDIN_EASY: 'true', EMAIL_MAX_PER_DAY: '5' });
    expect(v.JOBBER_DRY_RUN).toBe('true');
    expect(v.MAX_APPLIES_PER_DAY).toBe('');
    expect('EMAIL_MAX_PER_DAY' in v).toBe(false);
    expect(linkedinStartDiff(v, { JOBBER_DRY_RUN: 'true', APPLY_LINKEDIN_EASY: 'true' })).toEqual([]);
    expect(linkedinStartDiff(v, { JOBBER_DRY_RUN: '', APPLY_LINKEDIN_EASY: 'false', MAX_APPLIES_PER_DAY: '' })).toEqual(['JOBBER_DRY_RUN', 'APPLY_LINKEDIN_EASY']);
  });
});

describe('window-guard carries the screen_args of the linkedin_drip profile', () => {
  const guard = req('../.claude/hooks/window-guard.cjs') as {
    decide: (e: unknown, o: { root: string; env: Record<string, string> }) => { allow: boolean; reason: string };
    SCREENED_TOOLS: Set<string>;
  };
  const profile = (JSON.parse(readFileSync(join(ROOT, 'config/run-profiles.json'), 'utf8')) as { profiles?: Record<string, { screen_args: string[] }> } & Record<string, { screen_args: string[] }>);
  const prof = (profile.profiles ?? profile).linkedin_drip;
  const wake = (profile.profiles ?? profile).outreach_wake;

  it('the screened set is the union of the linkedin_drip and outreach_wake lists (without gmail, which has its own rule)', () => {
    const union = new Set([...prof.screen_args, ...wake.screen_args].filter((t) => !t.startsWith('mcp__gmail__')));
    expect([...guard.SCREENED_TOOLS].sort()).toEqual([...union].sort());
    for (const t of prof.screen_args.filter((x) => !x.startsWith('mcp__gmail__'))) expect(guard.SCREENED_TOOLS.has(t)).toBe(true);
  });

  it('denies secret-shaped strings in each screened tool and passes normal text; other tools are not screened', () => {
    const o = { root: ROOT, env: {} as Record<string, string> };
    for (const t of guard.SCREENED_TOOLS) {
      expect(guard.decide({ tool_name: t, tool_input: { text: 'hello there', profile_url: 'https://www.linkedin.com/in/x' } }, o).allow).toBe(true);
      for (const bad of ['see secrets/linkedin-main-state.json', 'cat .env', 'user-data/resume.json', '/etc/passwd', '~/notes', 'data.sqlite']) {
        expect(guard.decide({ tool_name: t, tool_input: { nested: { text: bad } } }, o).allow).toBe(false);
      }
    }
    expect(guard.decide({ tool_name: 'mcp__linkedin__linkedin_snapshot', tool_input: { x: 'secrets/' } }, o).allow).toBe(true);
    expect(guard.decide({ tool_name: 'mcp__outreach__list_due_touches', tool_input: { x: 'secrets/' } }, o).allow).toBe(true);
  });

  it('the kill switch still wins first', () => {
    expect(guard.decide({ tool_name: 'mcp__linkedin__linkedin_open', tool_input: { url: 'https://www.linkedin.com/in/x' } }, { root: ROOT, env: { JOBBER_KILL: '1' } }).allow).toBe(false);
  });
});

describe('linkedin-operator tools bound is unchanged', () => {
  it('the agent tools line equals config/worker-tools.json and the headless profile allow list', () => {
    const md = readFileSync(join(ROOT, '.claude/agents/linkedin-operator.md'), 'utf8');
    const line = /^tools:\s*(.*)$/m.exec(md)?.[1] ?? '';
    const tools = line.split(',').map((x) => x.trim()).filter(Boolean);
    const wt = JSON.parse(readFileSync(join(ROOT, 'config/worker-tools.json'), 'utf8')) as Record<string, unknown>;
    const listed = JSON.stringify(wt);
    for (const t of tools.filter((x) => x.startsWith('mcp__'))) expect(listed).toContain(t);
    expect(tools).not.toContain('mcp__linkedin__linkedin_close');
    expect(tools).not.toContain('Bash');
  });
});
