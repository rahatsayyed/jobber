import { join } from 'node:path';
import type { Exec } from '../lib/exec.js';
import type { Notifier } from '../platform/notify.js';
import { formatNotification } from './notes.js';
import type { UpdatePlan } from './plan.js';
import { recordResult, type Outcome, type UpdateState } from './state.js';
import { doctorRegression, evaluateTestReport, fingerprint, type KnownFailures } from './verify.js';

export interface ApplyDeps {
  exec: Exec;
  root: string;
  now: () => Date;
  fs: {
    read(p: string): string | null;
    exists(p: string): boolean;
    mkdtemp(prefix: string): string;
    rmrf(p: string): void;
    mkdirp(p: string): void;
    copy(from: string, to: string): void;
  };
  state: { load(): UpdateState; save(s: UpdateState): void };
  snapshotDb: (dest: string) => Promise<void>;
  knownFailures: KnownFailures;
  notify: Notifier;
  dbPath: string;
}
export interface ApplyOptions { dryRun: boolean }
export interface ApplyOutcome { outcome: Outcome; step: string | null; reason: string | null; from: string; to: string }

const SCRUBBED_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG.*)$/;
const MIN = 60_000;

class StepFailure extends Error {
  constructor(public step: string, public detail: string) { super(`${step}: ${detail}`); }
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUBBED_ENV.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function parseDoctor(stdout: string): { id: string; status: string }[] | null {
  const lines = stdout.split('\n');
  const start = lines.findIndex((l) => l.startsWith('['));
  if (start < 0) return null;
  try {
    const v = JSON.parse(lines.slice(start).join('\n').trim()) as unknown;
    if (!Array.isArray(v)) return null;
    const out: { id: string; status: string }[] = [];
    for (const row of v) {
      const r = row as Record<string, unknown>;
      if (typeof r?.id !== 'string' || typeof r?.status !== 'string') return null;
      out.push({ id: r.id, status: r.status });
    }
    return out;
  } catch {
    return null;
  }
}

export async function applyUpdate(
  deps: ApplyDeps,
  plan: Extract<UpdatePlan, { action: 'apply' }>,
  opts: ApplyOptions,
): Promise<ApplyOutcome> {
  const { exec, root } = deps;
  const from = plan.from;
  const to = plan.to;
  const short = to.slice(0, 12);
  const updateDir = join(root, '.update');
  const snapshotPath = join(updateDir, `pre-update-${short}.sqlite`);
  const git = (args: string[]) => exec('git', args, { cwd: root, env: cleanEnv(), timeoutMs: MIN });
  const flags = plan.permissionSetFileChanged ? ['config/permission-sets.json changed in this update'] : [];

  const finish = async (
    outcome: Outcome, step: string | null, reason: string | null,
    extra: { keepInProgress?: boolean; lastGood?: string; flags?: string[] } = {},
  ): Promise<ApplyOutcome> => {
    const text = formatNotification({
      outcome, from, to, reason, step, commits: plan.commits,
      flags: [...flags, ...(extra.flags ?? [])], dryRun: opts.dryRun, restartNeeded: outcome === 'updated',
    });
    let finalReason = reason;
    try {
      const sent = await deps.notify.send(text);
      if (!sent.ok) finalReason = reason ? `${reason}; notify failed` : 'notify failed';
    } catch {
      finalReason = reason ? `${reason}; notify failed` : 'notify failed';
    }
    const base = deps.state.load();
    const cleared: UpdateState = extra.keepInProgress ? base : { ...base, in_progress: null };
    const record = { at: deps.now().toISOString(), outcome, from, to, reason: finalReason, step };
    deps.state.save(recordResult(cleared, record, extra.lastGood));
    return { outcome, step, reason: finalReason, from, to };
  };

  const runDoctor = async (step: string) => {
    const r = await exec('npm', ['run', 'doctor', '--', '--json'], { cwd: root, env: cleanEnv(), timeoutMs: 5 * MIN });
    const parsed = parseDoctor(r.stdout);
    if (parsed === null) throw new StepFailure(step, 'doctor output not parseable');
    return parsed;
  };

  // Steps 1 to 5: nothing is mutated yet, a failure just aborts.
  let baseline: { id: string; status: string }[];
  let before: string;
  try {
    const status = await git(['status', '--porcelain']);
    if (status.code !== 0) return finish('error', 'preflight', 'git status failed');
    if (status.stdout.trim() !== '') return finish('skipped', 'preflight', 'dirty');
    const head = await git(['rev-parse', 'HEAD']);
    if (head.code !== 0 || head.stdout.trim() !== from) return finish('skipped', 'preflight', 'head-changed');
    baseline = await runDoctor('baseline-doctor');
    before = fingerprint(deps.fs.read(join(root, '.claude', 'settings.local.json')));
  } catch (e) {
    const step = e instanceof StepFailure ? e.step : 'preflight';
    return finish('error', step, `${step} failed`);
  }

  if (opts.dryRun) return finish('dry_run', null, null);

  try {
    deps.fs.mkdirp(updateDir);
    await deps.snapshotDb(snapshotPath);
  } catch {
    return finish('error', 'snapshot', 'snapshot failed');
  }

  const startedAt = deps.now().toISOString();
  deps.state.save({ ...deps.state.load(), in_progress: { from, to, started_at: startedAt } });

  let failedStep = 'merge';
  let failedReason = '';
  try {
    failedStep = 'merge';
    const merge = await git(['merge', '--ff-only', to]);
    if (merge.code !== 0) throw new StepFailure('merge', 'merge --ff-only failed');

    failedStep = 'install';
    const ci = await exec('npm', ['ci'], { cwd: root, env: cleanEnv(), timeoutMs: 10 * MIN });
    if (ci.code !== 0) throw new StepFailure('install', 'npm ci failed');

    failedStep = 'migrate-copy';
    const dir = deps.fs.mkdtemp(join(updateDir, 'migrate-'));
    try {
      const copy = join(dir, 'migrate.sqlite');
      deps.fs.copy(snapshotPath, copy);
      const m = await exec('npx', ['tsx', 'scripts/migrate-check.ts'], {
        cwd: root, env: cleanEnv({ JOBAPPLIER_DB: copy }), timeoutMs: 5 * MIN,
      });
      if (m.code !== 0) throw new StepFailure('migrate-copy', 'migration check failed');
    } finally {
      try { deps.fs.rmrf(dir); } catch { /* best effort */ }
    }

    failedStep = 'doctor';
    const after = await runDoctor('doctor');
    const regressed = doctorRegression(baseline, after);
    if (regressed.length > 0) {
      throw new StepFailure('doctor', `regressed checks: ${regressed.slice(0, 10).join(', ')}`);
    }

    failedStep = 'tests';
    const reportPath = join(updateDir, `test-report-${deps.now().getTime()}.json`);
    await exec('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`], {
      cwd: root, env: cleanEnv(), timeoutMs: 20 * MIN,
    });
    let raw: string | null = null;
    try { raw = deps.fs.read(reportPath); } catch { raw = null; }
    try { deps.fs.rmrf(reportPath); } catch { /* best effort */ }
    if (raw === null) throw new StepFailure('tests', 'test report missing');
    let report: Parameters<typeof evaluateTestReport>[0];
    try {
      report = JSON.parse(raw) as typeof report;
      if (!Array.isArray(report.testResults)) throw new Error('shape');
    } catch {
      throw new StepFailure('tests', 'test report not parseable');
    }
    const verdict = evaluateTestReport(report, deps.knownFailures, root);
    if (!verdict.ok) {
      throw new StepFailure('tests', `unexpected failures in: ${verdict.unexpected.slice(0, 5).join(', ')}`);
    }

    failedStep = 'permissions';
    const afterFp = fingerprint(deps.fs.read(join(root, '.claude', 'settings.local.json')));
    if (afterFp !== before) throw new StepFailure('permissions', 'settings.local.json changed during update');
  } catch (e) {
    failedReason = e instanceof StepFailure ? e.detail : `${failedStep} failed`;
    failedStep = e instanceof StepFailure ? e.step : failedStep;
    return rollback(failedStep, failedReason);
  }

  return finish('updated', null, null, { lastGood: to });

  async function rollback(step: string, reason: string): Promise<ApplyOutcome> {
    let ok = false;
    try {
      const reset = await git(['reset', '--hard', from]);
      if (reset.code === 0) {
        const ci = await exec('npm', ['ci'], { cwd: root, env: cleanEnv(), timeoutMs: 10 * MIN });
        if (ci.code === 0) {
          const head = await git(['rev-parse', 'HEAD']);
          ok = head.code === 0 && head.stdout.trim() === from;
        }
      }
    } catch {
      ok = false;
    }
    if (ok) return finish('rolled_back', step, reason);
    return finish('rollback_failed', step, `ROLLBACK FAILED after ${step}`, {
      keepInProgress: true,
      flags: [`pre-update snapshot: .update/pre-update-${short}.sqlite`],
    });
  }
}
