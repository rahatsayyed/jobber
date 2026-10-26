import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { wakeOnce, type DriverDeps } from '../src/scheduler/driver.js';
import type { Notice } from '../src/scheduler/notify.js';
import { buildRunnerArgv, type LaunchHandle, type LaunchPlan, type Launcher, type PollResult } from '../src/scheduler/launch.js';
import { StreamInspector, unprovenSteps, MAX_CONTINUATIONS } from '../src/scheduler/stream.js';
import { AWAIT_RULES, DIAGNOSTIC_RULES, buildContinuationPrompt, buildWakePrompt } from '../src/scheduler/prompt.js';
import { listRuns, migrateSchedulerTables } from '../src/scheduler/runLog.js';
import { buildReport, formatReport } from '../src/scheduler/report.js';
import { buildClaudeArgs, loadProfiles } from '../src/platform/runner.js';
import type { Step } from '../src/scheduler/plan.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z');
const QUIET = new Date('2026-10-14T21:00:00.000Z'); // 02:30 IST
const S1 = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const L = (o: object): string => JSON.stringify(o) + '\n';
const init = (sid: string): string => L({ type: 'system', subtype: 'init', session_id: sid });
const started = (id: string, sub: string): string =>
  L({ type: 'system', subtype: 'task_started', task_id: `t${id}`, tool_use_id: id, subagent_type: sub, description: `run ${sub}`, is_backgrounded: true });
const notified = (id: string, status: string): string =>
  L({ type: 'system', subtype: 'task_notification', task_id: `t${id}`, tool_use_id: id, status });
const result = (text: string, extra: object = {}): string =>
  L({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra });
const reportLine = (runId: string, ops: string[]): string =>
  JSON.stringify({
    run_id: runId,
    operators: ops.map((o) => ({ operator: o, platform: o.split('-')[0], tasks: [{ kind: 'inbox', done: 1, skipped: 0, escalated: 0, stopped: 'none' }] })),
  });
const doneAgent = (id: string, sub: string): string => started(id, sub) + notified(id, 'completed');

interface Sess { polls: Array<{ out?: string; exited?: boolean; code?: number }> }
class SeqLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  killed = 0;
  afterExit?: () => void;
  private cur = -1;
  constructor(private sessions: Sess[]) {}
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    this.cur = Math.min(this.starts.length - 1, this.sessions.length - 1);
    return { runId: plan.runId, session: plan.session, window: `wake-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> {
    const s = this.sessions[this.cur];
    const p = s.polls.length > 1 ? (s.polls.shift() as Sess['polls'][number]) : s.polls[0];
    if (p.exited) this.afterExit?.();
    return { exited: !!p.exited, exitCode: p.exited ? (p.code ?? 0) : null, newOutput: p.out ?? '' };
  }
  async kill(): Promise<void> {
    this.killed++;
  }
}
const sess = (out: string): Sess => ({ polls: [{ out, exited: true, code: 0 }] });

function setup(sessions: Sess[], opts: { env?: NodeJS.ProcessEnv; start?: Date; stopExists?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sched-inc-'));
  dirs.push(dir);
  let t = (opts.start ?? NOON_IST).getTime();
  const env = opts.env ?? {};
  const notices: Notice[] = [];
  const launcher = new SeqLauncher(sessions);
  const db = openDb(':memory:');
  let n = 0;
  const d: DriverDeps = {
    db,
    now: () => new Date(t),
    rng: () => 0.5,
    sleep: async (ms) => void (t += ms),
    cfg: loadOutreachConfig(env),
    tuning: loadTuning(env),
    env,
    lockRoot: join(dir, 'locks'),
    stopFile: join(dir, 'STOP'),
    runDir: join(dir, 'runs'),
    projectRoot: dir,
    launcher,
    notifier: { notify: async (x) => void notices.push(x) },
    newRunId: () => `run${String(++n).padStart(8, '0')}`,
    control: opts.stopExists ? { exists: opts.stopExists, read: () => 'stop it' } : undefined,
    pollMs: 5000,
  };
  return { d, db, launcher, notices, advance: (ms: number) => void (t += ms) };
}

const BOTH = doneAgent('a1', 'linkedin-operator') + doneAgent('a2', 'naukri-operator');

describe('StreamInspector', () => {
  it('reads the session id, the result, tasks and the final report (fenced or not)', () => {
    const i = new StreamInspector();
    i.feed(init(S1) + started('x1', 'contact-finder') + notified('x1', 'completed'));
    i.feed(result('done\n```json\n' + reportLine('r1', ['linkedin-operator']) + '\n```'));
    i.finish();
    expect(i.sessionId).toBe(S1);
    expect(i.resultSeen).toBe(true);
    expect(i.pending()).toEqual([]);
    expect(i.completedCount('contact-finder')).toBe(1);
    expect(i.report(['r1'])?.operators[0].operator).toBe('linkedin-operator');
    expect(i.report(['other'])).toBeNull();
  });

  it('treats a task with no completion notice or a stopped one as pending, a failed one as not pending', () => {
    const i = new StreamInspector();
    i.feed(started('a', 'contact-finder') + started('b', 'contact-finder') + started('c', 'matcher') + notified('b', 'stopped') + notified('c', 'failed'));
    i.finish();
    expect(i.pending().map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('handles chunks split mid-line and ignores junk lines', () => {
    const i = new StreamInspector();
    const full = 'not json\n' + init(S1) + result('x');
    i.feed(full.slice(0, 20));
    i.feed(full.slice(20));
    i.finish();
    expect(i.sessionId).toBe(S1);
    expect(i.resultSeen).toBe(true);
  });
});

describe('unprovenSteps', () => {
  const order: Step[] = [
    { operator: 'code', kind: 'discover_scripts', quota: 1 },
    { operator: 'pipeline', kind: 'pipeline', quota: 3 },
    { operator: 'linkedin-operator', platform: 'linkedin', kind: 'inbox', quota: 5 },
    { operator: 'apply-operator', kind: 'apply', quota: 2 },
  ];
  it('the pipeline needs the report and no pending subagent; operators need a completed task or a report entry', () => {
    const i = new StreamInspector();
    i.feed(init(S1) + started('p', 'contact-finder') + doneAgent('q', 'linkedin-operator') + result("I'm waiting for both"));
    i.finish();
    const r = unprovenSteps(order, i, ['r1'], new Set());
    expect([...r.proven].sort()).toEqual([0, 2]);
    expect(r.unproven).toEqual([1, 3]);
  });
  it('everything proven with a full report', () => {
    const i = new StreamInspector();
    i.feed(init(S1) + doneAgent('q', 'linkedin-operator') + doneAgent('z', 'apply-operator') + result(reportLine('r1', ['linkedin-operator', 'apply-operator'])));
    i.finish();
    expect(unprovenSteps(order, i, ['r1'], new Set()).unproven).toEqual([]);
  });
  it('steps proven by an earlier session stay proven', () => {
    const i = new StreamInspector();
    i.feed(init(S1) + doneAgent('z', 'apply-operator') + result(reportLine('r1', ['apply-operator'])));
    i.finish();
    expect(unprovenSteps(order, i, ['r1'], new Set([2])).unproven).toEqual([]);
  });
});

describe('wake prompt hardening', () => {
  const base = {
    runId: 'abcd1234', dryRun: false, tasks: [], budget: { maxWallSec: 900, maxTokensApprox: 150000 },
    allowed: ['linkedin' as const], now: new Date('2026-10-15T10:00:00Z'),
  };
  it('tells the session what its diagnostic tools are for and where they stop', () => {
    const p = buildWakePrompt(base);
    for (const rule of DIAGNOSTIC_RULES) expect(p).toContain(rule);
    expect(p).toMatch(/retry the typed tool ONCE/);
    expect(p).toMatch(/Never commit, never push/);
    expect(p).toMatch(/outreach\.escalate/);
    expect(p).toMatch(/untrusted data/);
    expect(p).toMatch(/\.jobber\/STOP/);
    expect(p).not.toMatch(/[^\x20-\x7e\n]/);
  });
  it('tells the session to block on every Agent call and never end its turn with one pending', () => {
    const p = buildWakePrompt(base);
    for (const rule of AWAIT_RULES) expect(p).toContain(rule);
    expect(p).toContain('run_in_background');
    expect(p).toMatch(/do NOT end your turn/i);
    expect(p).toMatch(/not write a summary/i);
    expect(p).toMatch(/ONE message/);
  });
  it('the continuation prompt names done and remaining steps, repeats the rules and the dry flag, and forbids repeating sends', () => {
    const order: Step[] = [
      { operator: 'pipeline', kind: 'pipeline', quota: 3 },
      { operator: 'linkedin-operator', platform: 'linkedin', kind: 'inbox', quota: 5 },
      { operator: 'apply-operator', kind: 'apply', quota: 2 },
    ];
    const p = buildContinuationPrompt({
      rootRunId: 'root0001', runId: 'run00002', n: 1, max: 2, dryRun: true, budget: base.budget, allowed: ['linkedin'], now: base.now,
      order, proven: new Set([1]), pending: [{ subagent: 'contact-finder', description: 'Contacts batch A' }],
      pipeline: { matchThreshold: 60, sendLimit: 1, targetRegions: 'Target regions: home=India', followupsAutonomous: false },
    });
    expect(p).toContain('Continue wake root0001');
    expect(p).toContain('Dry run: yes.');
    expect(p).toContain('Steps already done');
    expect(p).toMatch(/Remaining steps/);
    expect(p).toContain('Dispatch `apply-operator`');
    expect(p).not.toContain('Dispatch `linkedin-operator`');
    expect(p).toContain('Pipeline stage');
    expect(p).toContain('contact-finder');
    expect(p).toMatch(/check the (db|state)/i);
    expect(p).toMatch(/never repeat a send/i);
    for (const rule of AWAIT_RULES) expect(p).toContain(rule);
    expect(p).not.toMatch(/[^\x20-\x7e\n]/);
  });
});

describe('driver: a wake that ended incomplete', () => {
  it('stays ok when every step is proven and the report is present', async () => {
    const s = setup([sess(init(S1) + BOTH + result(reportLine('run00000001', ['linkedin-operator', 'naukri-operator'])))]);
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('ok');
    expect(s.launcher.starts).toHaveLength(1);
    expect(listRuns(s.db)[0].session_id).toBe(S1);
  });

  it('marks exit 0 without a report incomplete, names the unproven steps, and cannot continue without a session id', async () => {
    const s = setup([sess(started('p', 'contact-finder') + notified('p', 'stopped') + result("I'm waiting for both to return"))]);
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('incomplete');
    const row = listRuns(s.db)[0];
    expect(row.status).toBe('incomplete');
    expect(row.exit_code).toBe(0);
    expect(row.stop_reason).toContain('unproven');
    expect(row.stop_reason).toContain('linkedin-operator');
    expect(row.stop_reason).toContain('naukri-operator');
    expect(row.stop_reason).toContain('no session id');
    expect(s.launcher.starts).toHaveLength(1);
    expect(s.notices.some((n) => n.title.includes('incomplete'))).toBe(true);
  });

  it('continues once with --resume and finishes the chain; the child row points at its parent', async () => {
    const s = setup([
      sess(init(S1) + doneAgent('a1', 'linkedin-operator') + started('b', 'naukri-operator') + notified('b', 'stopped') + result("I'm waiting for naukri")),
      sess(init(S1) + doneAgent('a2', 'naukri-operator') + result(reportLine('run00000001', ['naukri-operator']))),
    ]);
    const r = await wakeOnce(s.d);
    expect(s.launcher.starts).toHaveLength(2);
    expect(s.launcher.starts[1].resumeSessionId).toBe(S1);
    expect(s.launcher.starts[1].dryRun).toBe(s.launcher.starts[0].dryRun);
    expect(s.launcher.starts[1].profile).toBe(s.launcher.starts[0].profile);
    expect(s.launcher.starts[1].prompt).toContain('Continue wake run00000001');
    expect(s.launcher.starts[1].prompt).toContain('Dispatch `naukri-operator`');
    expect(s.launcher.starts[1].prompt).not.toContain('Dispatch `linkedin-operator`');
    expect(r.status).toBe('ok');
    const rows = listRuns(s.db);
    const parent = rows.find((x) => x.id === 'run00000001');
    const child = rows.find((x) => x.parent_run_id === 'run00000001');
    expect(parent?.status).toBe('incomplete');
    expect(parent?.stop_reason).toContain('continued by');
    expect(child?.status).toBe('ok');
    expect(child?.trigger).toBe('continuation');
  });

  it('keeps the dry run flag on a continuation', async () => {
    const s = setup([sess(init(S1) + result('waiting')), sess(init(S1) + BOTH + result(reportLine('run00000001', ['linkedin-operator', 'naukri-operator'])))], { env: { JOBBER_DRY_RUN: 'true' } });
    await wakeOnce(s.d);
    expect(s.launcher.starts.map((p) => p.dryRun)).toEqual([true, true]);
  });

  it(`never continues more than ${MAX_CONTINUATIONS} times`, async () => {
    const s = setup([sess(init(S1) + result('waiting'))]);
    const r = await wakeOnce(s.d);
    expect(s.launcher.starts).toHaveLength(1 + MAX_CONTINUATIONS);
    expect(r.status).toBe('incomplete');
    expect(listRuns(s.db)).toHaveLength(1 + MAX_CONTINUATIONS);
  });

  it('a usage limit stop never continues', async () => {
    const s = setup([{ polls: [{ out: init(S1) + result("You've hit your session limit", { is_error: true }), exited: false }, { exited: true, code: 0 }] }]);
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('usage_limit');
    expect(s.launcher.starts).toHaveLength(1);
  });

  it('does not continue when the kill switch is on', async () => {
    let stop = false;
    const s = setup([sess(init(S1) + result('waiting'))], { stopExists: () => stop });
    s.launcher.afterExit = () => void (stop = true);
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('incomplete');
    expect(s.launcher.starts).toHaveLength(1);
    expect(listRuns(s.db)[0].stop_reason).toMatch(/not continued.*kill/);
  });

  it('does not continue inside quiet hours', async () => {
    const s = setup([sess(init(S1) + result('waiting'))]);
    s.launcher.afterExit = () => s.advance(QUIET.getTime() - NOON_IST.getTime());
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('incomplete');
    expect(s.launcher.starts).toHaveLength(1);
    expect(listRuns(s.db)[0].stop_reason).toMatch(/not continued.*quiet/);
  });

  it('verifyCompletion false keeps the old exit-code-only status', async () => {
    const s = setup([sess('')]);
    s.d.verifyCompletion = false;
    expect((await wakeOnce(s.d)).status).toBe('ok');
  });
});

describe('launcher argv for a continuation', () => {
  const p = { runId: 'run00000002', dryRun: false, promptPath: 'p', logPath: 'l', exitPath: 'e' };
  it('passes --resume=<uuid> to the runner after the profile, only for a valid uuid', () => {
    const argv = buildRunnerArgv({ ...p, resumeSessionId: S1 });
    expect(argv).toContain(`--resume=${S1}`);
    expect(argv.indexOf(`--resume=${S1}`)).toBeGreaterThan(argv.indexOf('outreach_wake'));
    expect(buildRunnerArgv(p).some((a) => a.startsWith('--resume'))).toBe(false);
    expect(() => buildRunnerArgv({ ...p, resumeSessionId: 'abc; rm -rf /' })).toThrow(/session id/);
  });
  it('the claude argv gets --resume <id> with every restriction kept', () => {
    const profiles = loadProfiles('config/run-profiles.json', 'config/permission-sets.json');
    const base = buildClaudeArgs('outreach_wake', profiles.outreach_wake, { settingsPath: 's.json' });
    const args = buildClaudeArgs('outreach_wake', profiles.outreach_wake, { settingsPath: 's.json' }, { resumeSessionId: S1 });
    expect(args[args.indexOf('--resume') + 1]).toBe(S1);
    expect(args.filter((a) => a !== '--resume' && a !== S1)).toEqual(base);
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(() => buildClaudeArgs('outreach_wake', profiles.outreach_wake, { settingsPath: 's.json' }, { resumeSessionId: '--dangerously-skip-permissions' })).toThrow();
  });
});

describe('run log and report', () => {
  it('migrates an old scheduler_runs table (no parent_run_id, session_id) in place', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE scheduler_runs (id TEXT PRIMARY KEY, planned_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, trigger TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0, burst INTEGER, tasks TEXT NOT NULL DEFAULT \'[]\', status TEXT NOT NULL, stop_reason TEXT, exit_code INTEGER, tool_calls INTEGER NOT NULL DEFAULT 0, tokens_approx INTEGER NOT NULL DEFAULT 0, wall_sec INTEGER, window TEXT, log_path TEXT, summary TEXT)');
    migrateSchedulerTables(db);
    migrateSchedulerTables(db);
    const cols = (db.prepare('PRAGMA table_info(scheduler_runs)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('parent_run_id');
    expect(cols).toContain('session_id');
  });
  it('the dry-run report counts incomplete runs and says what they are', () => {
    const s = setup([sess(init(S1) + result('waiting'))]);
    s.d.maxContinuations = 0;
    return wakeOnce(s.d).then(() => {
      const r = buildReport(s.db);
      expect(r.statusCounts.incomplete).toBe(1);
      expect(formatReport(r)).toMatch(/incomplete/);
      expect(formatReport(r)).toMatch(/unfinished|unproven/);
    });
  });
});
