// src/heal/land.ts
// Landing, restart, watch and rollback of a heal branch. All of it is code: the model never merges, restarts or reverts.
//   landAttempt      gate again -> verify in the worktree (tsc + full vitest) -> `git merge --ff-only` into the live branch (prev_head kept)
//                    -> boot check on the live checkout -> restart is queued (restart_state pending)
//   runPendingRestart restarts only what changed and only when idle (scheduler_runs `running` is checked before AND right before each
//                    restart; a busy window postpones the restart to the next tick), optional requeue, then the scheduler daemon last
//   watchPass        for HEAL_WATCH_MIN after the restart: the signature recurring, a new crashed run or a failing boot check reverts the
//                    landed commits with `git revert` (never `reset --hard`, which would drop owner work), restarts again and alerts
// Every function takes its effects (git, tests, tmux, clock) through HealDeps so tests run against a temp repo and fakes.
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { peekLock } from '../platform/lock.js';
import { loadManagerConfig, restartWindowWithMemory, sessionName } from '../platform/manager.js';
import { listWindows, type Run } from '../platform/tmux.js';
import { windowLockHeld } from '../platform/windowLock.js';
import { cleanEnvArgv, SCHEDULER_CMD } from '../stack/plan.js';
import { FIXER_WINDOW, IDLE_POLL_MS, IDLE_WAIT_MS, LIVE_RETRY_MS, LIVE_SKIP_BOUND_MS, REQUEUE_MAX, healWatchMin } from './config.js';
import type { LiveVerdict } from './live.js';
import { failureOfQueueRow } from './detect.js';
import { gateBranch } from './gate.js';
import {
  evidenceOf, getAttempt, getLedger, LIVE_RETRY_NOTE, setLedgerState, updateAttempt, type AttemptRow, type LedgerRow,
} from './ledger.js';
import { sendNotice, type AlertFn } from './notice.js';
import { classify, signatureOf } from './signature.js';

type Db = BetterSqlite3.Database;

export interface VerifyResult { ok: boolean; step?: 'tsc' | 'vitest'; tail?: string }

export interface HealDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  db: Db;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  alert?: AlertFn;
  killed: () => boolean;
  /** tmux session of the worker windows (manager config) and of the scheduler daemon window (stack session). */
  windowSession: string;
  stackSession: string;
  idleWaitMs?: number;
  idlePollMs?: number;
  /** tsc plus the full vitest run in a directory. Default: the real commands. */
  verify?: (cwd: string) => Promise<VerifyResult>;
  /** Fast check that the code on disk loads. Default: `npx tsc -p . --noEmit` before a restart, the scheduler status script after. */
  bootCheck?: (cwd: string, phase: 'pre_restart' | 'post_restart') => Promise<boolean>;
  /** The live try of the real action (`npm run heal:live -- <ledger_id>` in the worktree). Default: runs that command and reads its JSON line. */
  liveCheck?: (cwd: string, ledgerId: number) => Promise<LiveVerdict>;
  /** Called right before the scheduler daemon is respawned (this process is about to die): release the heal lock. */
  beforeSelfRestart?: () => void;
}

const tail = (s: string): string => s.split('\n').filter((l) => l.trim() !== '').slice(-8).join(' | ').slice(0, 400);

export async function defaultVerify(run: Run, cwd: string): Promise<VerifyResult> {
  const t = await run('npx', ['tsc', '-p', '.', '--noEmit'], { cwd, timeoutMs: 600_000 });
  if (t.code !== 0) return { ok: false, step: 'tsc', tail: tail(`${t.stdout}\n${t.stderr ?? ''}`) };
  const v = await run('npx', ['vitest', 'run'], { cwd, timeoutMs: 1_800_000, env: { CI: '1' } });
  if (v.code !== 0) return { ok: false, step: 'vitest', tail: tail(`${v.stdout}\n${v.stderr ?? ''}`) };
  return { ok: true };
}

async function defaultBootCheck(d: HealDeps, cwd: string, phase: 'pre_restart' | 'post_restart'): Promise<boolean> {
  const r = phase === 'pre_restart'
    ? await d.run('npx', ['tsc', '-p', '.', '--noEmit'], { cwd, timeoutMs: 600_000 })
    : await d.run('npx', ['tsx', 'scripts/scheduler.ts', '--status'], { cwd, timeoutMs: 120_000 });
  return r.code === 0;
}

const gitOut = async (d: HealDeps, args: string[], cwd: string = d.root): Promise<{ ok: boolean; out: string }> => {
  const r = await d.run('git', args, { cwd, timeoutMs: 120_000 });
  return { ok: r.code === 0, out: r.stdout.trim() };
};

// ---- what to restart ----

export interface RestartTargets { windows: string[]; scheduler: boolean }

const ALL_WORKERS = ['mail', 'linkedin', 'sources', 'pipeline', 'boards', 'apply'];
const WINDOW_MAP: ReadonlyArray<[RegExp, string[]]> = [
  [/^src\/(linkedin\/|mcp\/linkedin)/, ['linkedin', 'apply']],
  [/^src\/(naukri\/|wellfound\/|mcp\/(naukri|wellfound))/, ['boards', 'apply']],
  [/^src\/(apply\/|applier\/|mcp\/applier)/, ['apply', 'linkedin']],
  [/^src\/(sources\/|scout\/|mcp\/scout)/, ['sources']],
  [/^src\/(email|followups|replies|replyTriage|mcp\/gmail|outreach\/email)/, ['mail', 'pipeline']],
  [/^src\/(browserctl\/|webcore\/)/, ['linkedin', 'boards', 'sources', 'apply', 'pipeline']],
];

/** Which windows and whether the scheduler daemon load code that this change set touched. Tests and docs only: nothing. */
export function restartTargets(files: string[]): RestartTargets {
  const windows = new Set<string>();
  let scheduler = false;
  for (const f0 of files) {
    const f = f0.replace(/\\/g, '/');
    if (/^(tests|docs)\//.test(f) || /\.md$/.test(f)) {
      const m = /^config\/windows\/([A-Za-z0-9_-]+)\.md$/.exec(f);
      if (m && m[1] !== FIXER_WINDOW) windows.add(m[1] as string);
      continue;
    }
    if (!/^(src|scripts|config|renderer)\//.test(f)) continue;
    scheduler = true;
    const hit = WINDOW_MAP.find(([re]) => re.test(f));
    for (const w of hit ? hit[1] : ALL_WORKERS) windows.add(w);
  }
  return { windows: ALL_WORKERS.filter((w) => windows.has(w)).concat([...windows].filter((w) => !ALL_WORKERS.includes(w))), scheduler };
}

// ---- idle ----

/** Nothing is running: no `running` scheduler_runs row, no wake or update holding the run lock, and (for a window) no dispatcher lock. */
export function isIdle(d: HealDeps, window?: string): boolean {
  try {
    const n = (d.db.prepare("SELECT COUNT(*) AS n FROM scheduler_runs WHERE status = 'running'").get() as { n: number }).n;
    if (n > 0) return false;
  } catch { return false; }
  try { if (peekLock(path.join(d.root, '.jobber'), 'run') !== null) return false; } catch { return false; }
  if (window && windowLockHeld(d.root, window)) return false;
  return true;
}

async function waitIdle(d: HealDeps, window?: string): Promise<boolean> {
  const budget = d.idleWaitMs ?? IDLE_WAIT_MS;
  const poll = d.idlePollMs ?? IDLE_POLL_MS;
  let waited = 0;
  for (;;) {
    if (d.killed()) return false;
    if (isIdle(d, window)) return true;
    if (waited >= budget) return false;
    await d.sleep(poll);
    waited += poll;
  }
}

// ---- worktree ----

export const worktreeRoot = (root: string): string => path.join(root, '.jobber', 'heal', 'wt');

/** Removes a heal worktree (never the branch). Only paths under .jobber/heal/wt are touched. Best effort. */
export async function cleanupWorktree(d: HealDeps, worktree: string | null): Promise<void> {
  if (!worktree) return;
  const rel = path.relative(worktreeRoot(d.root), path.resolve(worktree));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
  try { await d.run('git', ['worktree', 'remove', '--force', worktree], { cwd: d.root, timeoutMs: 60_000 }); } catch { /* ignore */ }
  try { if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await d.run('git', ['worktree', 'prune'], { cwd: d.root, timeoutMs: 30_000 }); } catch { /* ignore */ }
}

// ---- requeue ----

/**
 * After a landing, for a signature marked requeue_safe: puts up to REQUEUE_MAX parked apply rows of THIS signature back to queued.
 * Never a row whose job has an application row or an outcome. Returns how many rows were put back.
 */
export function requeueSafeRows(d: HealDeps, ledger: LedgerRow): number {
  if (ledger.requeue_safe !== 1) return 0;
  let n = 0;
  for (const id of evidenceOf(ledger).queue.slice().reverse()) {
    if (n >= REQUEUE_MAX) break;
    try {
      const r = d.db.prepare('SELECT id, job_id, apply_platform, apply_status, apply_note FROM outreach_queue WHERE id = ?').get(id) as
        | { id: number; job_id: string; apply_platform: string | null; apply_status: string | null; apply_note: string | null } | undefined;
      if (!r || !['needs_owner', 'manual_review', 'failed'].includes(r.apply_status ?? '')) continue;
      if (signatureOf(failureOfQueueRow(r.apply_status as string, r.apply_note, r.apply_platform)) !== ledger.signature) continue;
      const app = d.db.prepare('SELECT 1 FROM applications WHERE job_id = ? LIMIT 1').get(r.job_id);
      const out = d.db.prepare('SELECT 1 FROM job_outcomes WHERE job_id = ? LIMIT 1').get(r.job_id);
      if (app || out) continue;
      n += d.db.prepare("UPDATE outreach_queue SET apply_status = NULL, apply_note = NULL, status = 'queued', updated_at = datetime('now') WHERE id = ?").run(id).changes;
    } catch { /* one row never stops the others */ }
  }
  return n;
}

// ---- the live try before landing ----

export async function defaultLiveCheck(run: Run, cwd: string, ledgerId: number): Promise<LiveVerdict> {
  const skipped = (evidence: string): LiveVerdict => ({ ledger_id: ledgerId, testability: 'not_testable', ran: false, result: 'skipped', evidence });
  const r = await run('npm', ['run', '--silent', 'heal:live', '--', String(ledgerId)], { cwd, timeoutMs: 300_000 });
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') && l.includes('"ledger_id"'));
  for (const l of lines.reverse()) {
    try {
      const j = JSON.parse(l) as Partial<LiveVerdict>;
      if (j.ledger_id === ledgerId && (j.result === 'pass' || j.result === 'fail' || j.result === 'skipped')) {
        return { ledger_id: ledgerId, testability: j.testability ?? 'not_testable', ran: j.ran === true, result: j.result, evidence: String(j.evidence ?? '').slice(0, 300) };
      }
    } catch { /* next */ }
  }
  return skipped('the live runner printed no verdict');
}

interface LiveState { verdict: LiveVerdict; at: string; first_skip_at?: string; told?: boolean }
const liveStateOf = (att: AttemptRow): LiveState | null => { try { return att.live ? (JSON.parse(att.live) as LiveState) : null; } catch { return null; } };

/**
 * The live gate. `not_testable` signatures need tests only (the watch window and auto rollback protect them). `live_readonly` and
 * `live_until_commit` need a PASS from the real action: fail sends the fixer back for one more round, then gave_up; skipped postpones the
 * landing (retried every LIVE_RETRY_MS; after LIVE_SKIP_BOUND_MS the owner is told once) and NEVER lands untested.
 * Returns null to go on, or the refusal.
 */
async function liveGate(d: HealDeps, att: AttemptRow, ledger: LedgerRow, cwd: string): Promise<LandResult | null> {
  const v = classify(ledger.signature);
  if (v.testability === 'not_testable') return null;
  const now = d.now();
  const prior = liveStateOf(att);
  if (prior && prior.verdict.result === 'skipped' && now.getTime() - Date.parse(prior.at) < LIVE_RETRY_MS) return { ok: false, reason: `live check skipped earlier (${prior.verdict.evidence}); retrying later` };
  let verdict: LiveVerdict;
  try { verdict = await (d.liveCheck ?? ((c, id) => defaultLiveCheck(d.run, c, id)))(cwd, ledger.id); }
  catch (e) { verdict = { ledger_id: ledger.id, testability: v.testability, ran: false, result: 'skipped', evidence: `live runner error: ${(e as Error).message.slice(0, 100)}` }; }
  const state: LiveState = { verdict, at: now.toISOString(), ...(prior?.first_skip_at ? { first_skip_at: prior.first_skip_at } : {}), ...(prior?.told ? { told: true } : {}) };
  if (verdict.result === 'pass') {
    updateAttempt(d.db, att.id, { live: JSON.stringify(state) });
    return null;
  }
  if (verdict.result === 'skipped') {
    state.first_skip_at ??= now.toISOString();
    const first = !prior || prior.verdict.result !== 'skipped';
    if (!state.told && now.getTime() - Date.parse(state.first_skip_at) >= LIVE_SKIP_BOUND_MS) {
      state.told = true;
      await sendNotice(d.alert, { kind: 'error', signature: ledger.signature, ledgerId: ledger.id, detail: `the live check is still skipped (${verdict.evidence}); the fix stays on branch ${att.branch} and is never landed untested` });
    } else if (first) {
      await sendNotice(d.alert, { kind: 'postponed', signature: ledger.signature, ledgerId: ledger.id, detail: `landing waits for the live check (${verdict.evidence})` });
    }
    updateAttempt(d.db, att.id, { live: JSON.stringify(state), note: `live check skipped: ${verdict.evidence}`.slice(0, 200) });
    return { ok: false, reason: `live check skipped: ${verdict.evidence}` };
  }
  // fail: one more round, then give up
  updateAttempt(d.db, att.id, { live: JSON.stringify(state) });
  const before = (d.db.prepare("SELECT COUNT(*) AS n FROM heal_attempts WHERE ledger_id = ? AND outcome = 'live_failed' AND id <> ?").get(ledger.id, att.id) as { n: number }).n;
  const why = `live check failed: ${verdict.evidence}`;
  updateAttempt(d.db, att.id, { outcome: 'live_failed', ended_at: now.toISOString(), note: why.slice(0, 200) });
  if (before >= 1) {
    setLedgerState(d.db, ledger.id, 'gave_up', why.slice(0, 200));
    await sendNotice(d.alert, { kind: 'gave_up', signature: ledger.signature, ledgerId: ledger.id, detail: `${why} (second round)` });
  } else {
    setLedgerState(d.db, ledger.id, 'open', LIVE_RETRY_NOTE);
    await sendNotice(d.alert, { kind: 'error', signature: ledger.signature, ledgerId: ledger.id, detail: `${why}; the fixer gets one more round` });
  }
  await cleanupWorktree(d, att.worktree);
  return { ok: false, reason: why };
}

// ---- landing ----

export type LandResult = { ok: true; landedHead: string; files: string[] } | { ok: false; reason: string };

/** Lands a `ready` attempt. Never throws. The caller holds the heal lock. */
export async function landAttempt(d: HealDeps, attemptId: number): Promise<LandResult> {
  const att = getAttempt(d.db, attemptId);
  const ledger = att ? getLedger(d.db, att.ledger_id) : undefined;
  if (!att || !ledger) return { ok: false, reason: 'unknown attempt' };
  const stop = async (outcome: AttemptRow['outcome'], ledgerState: 'gave_up' | 'open', reason: string): Promise<LandResult> => {
    updateAttempt(d.db, att.id, { outcome, ended_at: d.now().toISOString(), note: reason });
    setLedgerState(d.db, ledger.id, ledgerState, reason);
    if (ledgerState === 'gave_up') await sendNotice(d.alert, { kind: 'gave_up', signature: ledger.signature, ledgerId: ledger.id, detail: reason });
    return { ok: false, reason };
  };
  try {
    if (att.outcome !== 'ready' || !att.branch || !att.base_head || !att.head) return { ok: false, reason: `attempt is not ready (${att.outcome})` };
    if (d.killed()) return { ok: false, reason: 'kill switch is on' };
    const wt = att.worktree ?? d.root;
    // 1. the branch must still be exactly what was gated, and pass the gate again.
    const head = await gitOut(d, ['rev-parse', att.branch]);
    if (!head.ok || head.out !== att.head) return await stop('gate_failed', 'gave_up', 'branch changed after the gate');
    const gate = await gateBranch({ run: d.run, cwd: d.root }, att.base_head, att.branch);
    if (!gate.ok) return await stop('gate_failed', 'gave_up', `gate: ${gate.reasons.slice(0, 3).join('; ')}`);
    // 2. the live checkout: a named branch, and the branch must fast-forward onto it.
    const live = await gitOut(d, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!live.ok || live.out === 'HEAD' || live.out === '') return { ok: false, reason: 'live checkout is on a detached HEAD' };
    const prev = await gitOut(d, ['rev-parse', 'HEAD']);
    if (!prev.ok) return { ok: false, reason: 'cannot read live HEAD' };
    const ff = await d.run('git', ['merge-base', '--is-ancestor', prev.out, att.branch], { cwd: d.root, timeoutMs: 30_000 });
    if (ff.code !== 0) return await stop('stale_base', 'open', 'the live branch moved on since the fix was cut; a new heal will start from the new head');
    // 3. verify in the worktree: tsc and the FULL vitest run.
    const v = await (d.verify ?? ((cwd) => defaultVerify(d.run, cwd)))(wt);
    if (!v.ok) return await stop('verify_failed', 'gave_up', `${v.step ?? 'verify'} failed: ${v.tail ?? ''}`);
    if (d.killed()) return { ok: false, reason: 'kill switch is on' };
    // 3b. LIVE TRY of the real action (when it can be tried): a pass is required, a skip waits, a fail sends the fixer back once.
    const refused = await liveGate(d, att, ledger, wt);
    if (refused) return refused;
    if (d.killed()) return { ok: false, reason: 'kill switch is on' };
    // 4. land: fast-forward only.
    const m = await d.run('git', ['merge', '--ff-only', att.branch], { cwd: d.root, timeoutMs: 120_000 });
    if (m.code !== 0) return await stop('land_failed', 'open', `ff-only merge refused: ${tail(`${m.stdout}\n${m.stderr ?? ''}`)}`);
    const landed = await gitOut(d, ['rev-parse', 'HEAD']);
    const landedHead = landed.ok ? landed.out : att.head;
    const targets = restartTargets(gate.files);
    updateAttempt(d.db, att.id, {
      outcome: 'landed', prev_head: prev.out, landed_head: landedHead, files: JSON.stringify(gate.files),
      restart_state: 'pending', restart_targets: JSON.stringify(targets), ended_at: d.now().toISOString(), note: `landed on ${live.out}`,
    });
    setLedgerState(d.db, ledger.id, 'landed', `landed ${landedHead.slice(0, 8)}`);
    await sendNotice(d.alert, { kind: 'landed', signature: ledger.signature, ledgerId: ledger.id, detail: `${gate.files.length} files, ${gate.testFiles.length} test file(s), ${gate.changedLines} lines, head ${landedHead.slice(0, 8)}` });
    // 5. boot check on the live checkout; a broken tree is reverted before anything restarts.
    const boot = await (d.bootCheck ?? ((cwd, ph) => defaultBootCheck(d, cwd, ph)))(d.root, 'pre_restart');
    if (!boot) {
      await rollbackAttempt(d, getAttempt(d.db, att.id) as AttemptRow, 'boot_check_failed', false);
      return { ok: false, reason: 'boot check failed after the merge; reverted' };
    }
    await cleanupWorktree(d, att.worktree);
    return { ok: true, landedHead, files: gate.files };
  } catch (e) {
    return { ok: false, reason: `land error: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 120)}` };
  }
}

// ---- restart ----

export type RestartResult = 'done' | 'postponed' | 'manual' | 'nothing';

/** Restarts what a landing (or a rollback) changed, only when idle. Never throws. The caller holds the heal lock. */
export async function runPendingRestart(d: HealDeps, attemptId: number): Promise<RestartResult> {
  const att = getAttempt(d.db, attemptId);
  const ledger = att ? getLedger(d.db, att.ledger_id) : undefined;
  if (!att || !ledger || (att.restart_state !== 'pending' && att.restart_state !== 'postponed')) return 'nothing';
  const postpone = async (why: string): Promise<RestartResult> => {
    const first = att.restart_state !== 'postponed';
    updateAttempt(d.db, att.id, { restart_state: 'postponed', note: `restart postponed: ${why}` });
    if (first) await sendNotice(d.alert, { kind: 'postponed', signature: ledger.signature, ledgerId: ledger.id, detail: why });
    return 'postponed';
  };
  try {
    let targets: RestartTargets = { windows: [], scheduler: false };
    try { targets = JSON.parse(att.restart_targets ?? '{}') as RestartTargets; } catch { /* nothing to restart */ }
    const windows = Array.isArray(targets.windows) ? targets.windows : [];
    const finish = (): void => {
      const at = d.now();
      const patch: Parameters<typeof updateAttempt>[2] = { restart_state: 'done', restart_at: at.toISOString() };
      if (att.outcome === 'landed') patch.watch_until = new Date(at.getTime() + healWatchMin(d.env) * 60_000).toISOString();
      updateAttempt(d.db, att.id, patch);
    };
    if (windows.length === 0 && !targets.scheduler) { finish(); return 'nothing'; }
    if (!(await waitIdle(d))) return await postpone(d.killed() ? 'kill switch' : 'a run is in progress');

    let cfg;
    try { cfg = loadManagerConfig(readFileSync(path.join(d.root, 'config', 'manager-windows.json'), 'utf8')); } catch { return await postpone('manager config unreadable'); }
    const session = sessionName(cfg, d.env);
    const alive = new Set((await listWindows(d.run, session)).map((w) => w.name));
    for (const w of windows) {
      if (!alive.has(w) || w === FIXER_WINDOW) continue;
      if (!(await waitIdle(d, w))) return await postpone(`window ${w} is busy`);
      if (!isIdle(d, w)) return await postpone(`window ${w} became busy`); // right before the restart
      try {
        await restartWindowWithMemory(d.run, cfg, d.env, w, d.root, { tries: 30, intervalMs: 1000, sleep: d.sleep });
      } catch (e) {
        return await postpone(`restart of ${w} refused: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
    if (att.outcome === 'landed') {
      const n = requeueSafeRows(d, ledger);
      if (n > 0) updateAttempt(d.db, att.id, { requeued: n });
    }
    // The scheduler daemon last: it is this process. State first, then the respawn (which ends us).
    if (targets.scheduler) {
      const stackAlive = (await listWindows(d.run, d.stackSession)).some((w) => w.name === 'scheduler');
      if (!stackAlive) {
        finish();
        updateAttempt(d.db, att.id, { restart_state: 'manual' });
        await sendNotice(d.alert, { kind: 'manual_restart', signature: ledger.signature, ledgerId: ledger.id, detail: 'the scheduler daemon is not a window of the stack session; restart it so it loads the fix', command: 'npm run up' });
        return 'manual';
      }
      if (!(await waitIdle(d)) || !isIdle(d)) return await postpone('a run is in progress (scheduler restart)');
      finish();
      d.beforeSelfRestart?.();
      await d.run('tmux', ['respawn-window', '-k', '-t', `=${d.stackSession}:=scheduler`, '-c', d.root, '--', ...cleanEnvArgv(d.env, SCHEDULER_CMD)], { cwd: d.root, timeoutMs: 15_000 });
      return 'done';
    }
    finish();
    return 'done';
  } catch (e) {
    return await postpone(`restart error: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
}

// ---- watch and rollback ----

/** Reverts the landed commits with `git revert` (never reset --hard), queues the restart, marks the ledger rolled_back, alerts. */
export async function rollbackAttempt(d: HealDeps, att: AttemptRow, why: string, needsRestart = true): Promise<boolean> {
  const ledger = getLedger(d.db, att.ledger_id);
  if (!ledger) return false;
  const gaveUp = async (reason: string): Promise<boolean> => {
    setLedgerState(d.db, ledger.id, 'gave_up', reason);
    updateAttempt(d.db, att.id, { note: reason });
    await sendNotice(d.alert, { kind: 'error', signature: ledger.signature, ledgerId: ledger.id, detail: reason });
    return false;
  };
  if (!att.prev_head || !att.landed_head) return gaveUp(`rollback impossible (${why}): no recorded commits`);
  const list = await gitOut(d, ['rev-list', '--no-merges', `${att.prev_head}..${att.landed_head}`]);
  if (!list.ok) return gaveUp(`rollback failed (${why}): cannot list the landed commits`);
  if (list.out !== '') {
    const rv = await d.run('git', ['-c', 'user.name=jobber-heal', '-c', 'user.email=heal@localhost', 'revert', '--no-edit', `${att.prev_head}..${att.landed_head}`], { cwd: d.root, timeoutMs: 120_000 });
    if (rv.code !== 0) {
      await d.run('git', ['revert', '--abort'], { cwd: d.root, timeoutMs: 30_000 });
      return gaveUp(`rollback failed (${why}); revert by hand: git revert ${att.prev_head.slice(0, 8)}..${att.landed_head.slice(0, 8)}`);
    }
  }
  updateAttempt(d.db, att.id, { outcome: 'rolled_back', watch_until: null, note: `rolled back: ${why}`, restart_state: needsRestart ? 'pending' : 'done' });
  setLedgerState(d.db, ledger.id, 'rolled_back', `rolled back: ${why}`);
  await sendNotice(d.alert, { kind: 'rolled_back', signature: ledger.signature, ledgerId: ledger.id, detail: why });
  return true;
}

/** One watch pass over landed attempts inside their watch window. Never throws. */
export async function watchPass(d: HealDeps): Promise<void> {
  try {
    const rows = d.db.prepare("SELECT * FROM heal_attempts WHERE outcome = 'landed' AND restart_state IN ('done', 'manual') AND watch_until IS NOT NULL").all() as AttemptRow[];
    for (const att of rows) {
      const ledger = getLedger(d.db, att.ledger_id);
      if (!ledger) continue;
      const now = d.now().getTime();
      if (now >= Date.parse(att.watch_until as string)) {
        updateAttempt(d.db, att.id, { outcome: 'stable', note: 'stable' });
        await sendNotice(d.alert, { kind: 'stable', signature: ledger.signature, ledgerId: ledger.id });
        continue;
      }
      if (!(att.note ?? '').includes('boot_ok')) {
        const ok = await (d.bootCheck ?? ((cwd, ph) => defaultBootCheck(d, cwd, ph)))(d.root, 'post_restart');
        if (!ok) { await rollbackAttempt(d, att, 'boot_check_failed'); continue; }
        updateAttempt(d.db, att.id, { note: `${att.note ?? ''} boot_ok`.trim() });
      }
      const restartAt = Date.parse(att.restart_at ?? '');
      if (!Number.isFinite(restartAt)) continue;
      if (Date.parse(ledger.last_seen) > restartAt) { await rollbackAttempt(d, att, 'the same failure came back'); continue; }
      const crashed = (d.db.prepare("SELECT COUNT(*) AS n FROM scheduler_runs WHERE status = 'crashed' AND ended_at > ? AND COALESCE(stop_reason, '') <> 'orphaned'").get(att.restart_at) as { n: number }).n;
      if (crashed > 0) await rollbackAttempt(d, att, 'a run crashed after the restart');
    }
  } catch { /* the watch never stops the scheduler */ }
}

/** Attempts whose restart still has to happen (pending or postponed). */
export const pendingRestarts = (db: Db): AttemptRow[] =>
  db.prepare("SELECT * FROM heal_attempts WHERE restart_state IN ('pending', 'postponed') ORDER BY id ASC").all() as AttemptRow[];

