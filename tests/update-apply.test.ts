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
}

function setup(o: Opts = {}) {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const removed: string[] = [];
  const sent: string[] = [];
  let state: UpdateState = { ...emptyState(), last_good_commit: FROM };
  const doctorOut = [...(o.doctorCalls ?? [DOCTOR_OK, DOCTOR_OK])];
  const settings = [...(o.settings ?? ['same', 'same'])];
  const used = new Set<string>();
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const key = `${cmd} ${args.join(' ')}`;
    const s = o.script?.[key];
    if (s && !(s.once && used.has(key))) {
      used.add(key);
      return { stdout: s.stdout ?? '', stderr: '', code: s.code ?? 0 };
    }
    if (key === 'git status --porcelain') return { stdout: '', stderr: '', code: 0 };
    if (key === 'git rev-parse HEAD') return { stdout: FROM + '\n', stderr: '', code: 0 };
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
      copy: () => undefined,
    },
    state: { load: () => state, save: (s) => { state = s; } },
    snapshotDb: async () => { if (o.snapshotThrows) throw new Error('boom'); },
    knownFailures: { 'tests/resume.test.ts': 1 },
    notify: { send: async (t) => { sent.push(t); return { ok: o.notifyOk ?? true, detail: 'x' }; } },
    dbPath: '/proj/data.sqlite',
  };
  return { deps, calls, removed, sent, getState: () => state };
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

  it('notifier failure does not change the outcome', async () => {
    const t = setup({ notifyOk: false });
    const r = await applyUpdate(t.deps, plan, { dryRun: false });
    expect(r.outcome).toBe('updated');
    expect(r.reason).toMatch(/notify failed$/);
  });
});
