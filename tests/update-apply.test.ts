import { describe, expect, it } from 'vitest';
import { applyUpdate, type ApplyDeps } from '../src/update/apply.js';
import { emptyState, type UpdateState } from '../src/update/state.js';
import type { Exec } from '../src/lib/exec.js';
import type { UpdatePlan } from '../src/update/plan.js';

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const plan: Extract<UpdatePlan, { action: 'apply' }> = {
  action: 'apply', from: FROM, to: TO, commits: [{ sha: TO, subject: 'feat: x', signature: 'G' }],
  changedPaths: ['src/x.ts'], permissionSetFileChanged: false,
};
const DOCTOR_OK = JSON.stringify([{ id: 'a', title: 'A', status: 'pass', detail: 'ok' }]);
const DOCTOR_BAD = JSON.stringify([{ id: 'a', title: 'A', status: 'fail', detail: 'no' }]);
const REPORT_OK = JSON.stringify({ testResults: [{ name: '/proj/tests/resume.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] }] });
const REPORT_BAD = JSON.stringify({ testResults: [{ name: '/proj/tests/new.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] }] });

interface Opts {
  script?: Record<string, { stdout?: string; code?: number; once?: boolean }>;
  doctorCalls?: string[];
  report?: string | null;
  settings?: string[];
  snapshotThrows?: boolean;
  notifyOk?: boolean;
  notifyThrows?: boolean;
  marker?: boolean;
  throwOn?: string;
  headAfterReset?: string;
  markerSaveThrows?: boolean;
}

function setup(o: Opts = {}) {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const removed: string[] = [];
  const sent: string[] = [];
  const copies: [string, string][] = [];
  const order: string[] = [];
  let snapshots = 0;
  let reset = false;
  let state: UpdateState = { ...emptyState(), last_good_commit: FROM };
  if (o.marker) state = { ...state, in_progress: { from: 'x'.repeat(40), to: 'y'.repeat(40), started_at: 'then' } };
  const doctorOut = [...(o.doctorCalls ?? [DOCTOR_OK, DOCTOR_OK])];
  const settings = [...(o.settings ?? ['same', 'same'])];
  const used = new Set<string>();
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const key = `${cmd} ${args.join(' ')}`;
    order.push(key);
    if (o.throwOn && key === o.throwOn) throw new Error('exec exploded');
    if (key.startsWith('git reset --hard')) reset = true;
    const s = o.script?.[key];
    if (s && !(s.once && used.has(key))) {
      used.add(key);
      return { stdout: s.stdout ?? '', stderr: '', code: s.code ?? 0 };
    }
    if (key === 'git status --porcelain') return { stdout: '', stderr: '', code: 0 };
    if (key === 'git rev-parse HEAD') {
      return { stdout: (reset && o.headAfterReset ? o.headAfterReset : FROM) + '\n', stderr: '', code: 0 };
    }
    if (key === 'npm run doctor -- --json') return { stdout: '> x\n' + (doctorOut.shift() ?? DOCTOR_OK), stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const deps: ApplyDeps = {
    exec, root: '/proj', now: () => new Date('2026-10-15T00:00:00Z'),
    fs: {
      read: (p) => {
        if (p.includes('test-report-')) return o.report === undefined ? REPORT_OK : o.report;
        if (p.endsWith('settings.local.json')) return settings.shift() ?? null;
        return null;
      },
      exists: () => true,
      mkdtemp: (prefix) => `${prefix}XYZ`,
      rmrf: (p) => { removed.push(p); },
      mkdirp: () => undefined,
      copy: (a, b) => { copies.push([a, b]); },
    },
    state: {
      load: () => state,
      save: (s) => {
        if (o.markerSaveThrows && s.in_progress && !state.in_progress) throw new Error('disk full');
        state = s;
      },
    },
    snapshotDb: async () => { order.push('SNAPSHOT'); snapshots++; if (o.snapshotThrows) throw new Error('boom'); },
    knownFailures: { 'tests/resume.test.ts': 1 },
    notify: { send: async (t) => { if (o.notifyThrows) throw new Error('net'); sent.push(t); return { ok: o.notifyOk ?? true, detail: 'x' }; } },
    dbPath: '/proj/data.sqlite',
  };
  return { deps, calls, removed, sent, copies, order, snapshots: () => snapshots, getState: () => state };
}
const keys = (c: { cmd: string; args: string[] }[]) => c.map((x) => `${x.cmd} ${x.args.join(' ')}`);

describe('applyUpdate', () => {
  it('happy path runs the exact ordered steps', async () => {
    const t = setup();
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('updated');
    const k = keys(t.calls);
    expect(k.slice(0, 7)).toEqual([
      'git status --porcelain',
      'git rev-parse HEAD',
      'npm run doctor -- --json',
      `git merge --ff-only ${TO}`,
      'npm ci',
      'npx tsx scripts/migrate-check.ts',
      'npm run doctor -- --json',
    ]);
    expect(k[7]).toMatch(/^npx vitest run --reporter=json --outputFile=\/proj\/\.update\/test-report-/);
    expect(k).toHaveLength(8);
    expect(t.getState().last_good_commit).toBe(TO);
    expect(t.getState().in_progress).toBeNull();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatch(/restart/);
  });

  it('dry run stops after baseline', async () => {
    const t = setup();
    const r = await applyUpdate(t.deps, plan, { dryRun: true });
    expect(r.outcome).toBe('dry_run');
    expect(keys(t.calls).some((x) => x.includes('merge') || x === 'npm ci')).toBe(false);
    expect(t.getState().last_good_commit).toBe(FROM);
    expect(t.getState().in_progress).toBeNull();
  });

  it('dirty tree skips with no mutation', async () => {
    const t = setup({ script: { 'git status --porcelain': { stdout: ' M x\n' } } });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toBe('dirty');
    expect(keys(t.calls)).toEqual(['git status --porcelain']);
  });

  it('head moved skips', async () => {
    const t = setup({ script: { 'git rev-parse HEAD': { stdout: 'c'.repeat(40) + '\n' } } });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('skipped');
    expect(keys(t.calls).some((x) => x.includes('merge'))).toBe(false);
  });

  it('unparseable baseline doctor aborts', async () => {
    const t = setup({ doctorCalls: ['not json'] });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('error');
    expect(r.step).toBe('baseline-doctor');
    expect(keys(t.calls).some((x) => x.includes('merge'))).toBe(false);
  });

  it('install failure rolls back with reset then npm ci', async () => {
    const t = setup({ script: { 'npm ci': { code: 1, once: true } } });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('rolled_back');
    expect(r.step).toBe('install');
    const k = keys(t.calls);
    const i = k.indexOf(`git reset --hard ${FROM}`);
    expect(i).toBeGreaterThan(-1);
    expect(k[i + 1]).toBe('npm ci');
    expect(k[i + 2]).toBe('git rev-parse HEAD');
    expect(t.getState().in_progress).toBeNull();
    expect(t.getState().last_good_commit).toBe(FROM);
  });

  it.each([
    ['migrate', { script: { 'npx tsx scripts/migrate-check.ts': { code: 1 } } }, 'migrate-copy'],
    ['doctor', { doctorCalls: [DOCTOR_OK, DOCTOR_BAD] }, 'doctor'],
    ['tests', { report: REPORT_BAD }, 'tests'],
    ['tests unparseable', { report: 'nope' }, 'tests'],
    ['tests missing', { report: null }, 'tests'],
    ['permissions', { settings: ['one', 'two'] }, 'permissions'],
  ] as [string, Opts, string][])('%s failure rolls back', async (_n, o, step) => {
    const t = setup(o);
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('rolled_back');
    expect(r.step).toBe(step);
    expect(keys(t.calls)).toContain(`git reset --hard ${FROM}`);
    expect(t.sent).toHaveLength(1);
  });

  it('runs the migration check against a removed copy', async () => {
    const t = setup();
    await applyUpdate(t.deps, plan, { dryRun: false });
    const m = t.calls.find((c) => c.args.includes('scripts/migrate-check.ts'))!;
    const db = m.env?.JOBAPPLIER_DB ?? '';
    expect(db).not.toBe('');
    expect(db).not.toBe(t.deps.dbPath);
    const dir = db.slice(0, db.lastIndexOf('/'));
    expect(t.removed).toContain(dir);
  });

  it('rollback failure keeps in_progress and shouts', async () => {
    const t = setup({ script: { 'npm ci': { code: 1, once: true }, [`git reset --hard ${FROM}`]: { code: 1 } } });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('rollback_failed');
    expect(t.getState().in_progress).not.toBeNull();
    expect(t.sent[0]).toContain('ROLLBACK FAILED');
  });

  it('snapshot failure aborts before merge', async () => {
    const t = setup({ snapshotThrows: true });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('error');
    expect(r.step).toBe('snapshot');
    expect(keys(t.calls).some((x) => x.includes('merge'))).toBe(false);
    expect(t.getState().in_progress).toBeNull();
  });

  it('never issues forbidden git verbs', async () => {
    for (const o of [{}, { script: { 'npm ci': { code: 1, once: true } } }] as Opts[]) {
      const t = setup(o);
      await applyUpdate(t.deps, plan, { dryRun: false });
      const bad = /--force|\bpull\b|\brebase\b|\bpush\b|\bcheckout\b|\bstash\b|\bclean\b/;
      expect(keys(t.calls).filter((k) => bad.test(k))).toEqual([]);
    }
  });

  it('a pre-existing marker is never cleared and nothing runs', async () => {
    for (const dryRun of [false, true]) {
      const t = setup({ marker: true });
      const r = await applyUpdate(t.deps, plan, { dryRun });
      expect(r.outcome).toBe('skipped');
      expect(r.reason).toBe('in-progress-marker');
      expect(t.calls).toEqual([]);
      expect(t.getState().in_progress?.started_at).toBe('then');
      expect(t.sent).toHaveLength(1);
    }
  });

  it('invalid commit ids are an error', async () => {
    const t = setup();
    const r = await applyUpdate(t.deps, { ...plan, to: '--force' }, { dryRun: false });
    expect(r.outcome).toBe('error');
    expect(r.step).toBe('preflight');
    expect(t.calls).toEqual([]);
  });

  it('marker write failure returns error before merge', async () => {
    const t = setup({ markerSaveThrows: true });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('error');
    expect(r.step).toBe('state-in-progress');
    expect(keys(t.calls).some((x) => x.includes('merge'))).toBe(false);
  });

  it('dry run never snapshots; happy path snapshots before merge', async () => {
    const d = setup();
    await applyUpdate(d.deps, plan, { dryRun: true });
    expect(d.snapshots()).toBe(0);
    const t = setup();
    await applyUpdate(t.deps, plan, { dryRun: false });
    expect(t.order.indexOf('SNAPSHOT')).toBeGreaterThan(-1);
    expect(t.order.indexOf('SNAPSHOT')).toBeLessThan(t.order.indexOf(`git merge --ff-only ${TO}`));
  });

  it('exec throwing after merge rolls back', async () => {
    const u = setup({ throwOn: 'npx tsx scripts/migrate-check.ts' });
    const r2 = await applyUpdate(u.deps, plan, { dryRun: false });
    expect(r2.outcome).toBe('rolled_back');
    expect(r2.step).toBe('migrate-copy');
    const t = setup({ throwOn: 'npm ci' });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('rollback_failed');
  });

  it('HEAD differing after reset is rollback_failed', async () => {
    const t = setup({ script: { 'npm ci': { code: 1, once: true } }, headAfterReset: 'd'.repeat(40) });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('rollback_failed');
    expect(t.getState().in_progress).not.toBeNull();
  });

  it('a throwing notifier is swallowed', async () => {
    const t = setup({ notifyThrows: true });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('updated');
    expect(t.getState().last_good_commit).toBe(TO);
  });

  it('migrate temp dir is removed on failure and the copy source is the snapshot', async () => {
    const t = setup({ script: { 'npx tsx scripts/migrate-check.ts': { code: 1 } } });
    await applyUpdate(t.deps, plan, { dryRun: false });
    expect(t.copies).toHaveLength(1);
    const [src, dst] = t.copies[0]!;
    expect(src).toBe(`/proj/.update/pre-update-${TO.slice(0, 12)}.sqlite`);
    expect(t.removed).toContain(dst.slice(0, dst.lastIndexOf('/')));
  });

  it('doctor and vitest calls do not inherit JOBAPPLIER_DB', async () => {
    process.env.JOBAPPLIER_DB = 'leak';
    try {
      const t = setup();
      await applyUpdate(t.deps, plan, { dryRun: false });
      for (const c of t.calls) {
        if (c.args.includes('scripts/migrate-check.ts')) expect(c.env?.JOBAPPLIER_DB).toBeTruthy();
        else expect(c.env?.JOBAPPLIER_DB).toBeUndefined();
      }
    } finally {
      delete process.env.JOBAPPLIER_DB;
    }
  });

  it('notifier failure does not change the outcome', async () => {
    const t = setup({ notifyOk: false });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('updated');
    expect(r.reason).toMatch(/notify failed$/);
  });
});
