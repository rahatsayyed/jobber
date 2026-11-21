// src/heal/fixer.ts
// One heal run: create a git worktree and branch from the live HEAD, hand the work item to the `fixer` window, read its report, commit what it
// left, run the landing gate's diff checks, and record the result. It never merges and never restarts (landing is src/heal/land.ts).
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { setState } from '../scheduler/runLog.js';
import type { DispatchInput, DispatchResult } from '../scheduler/windowDispatch.js';
import { FIXER_DEADLINE_MS, FIXER_WINDOW } from './config.js';
import { gateBranch } from './gate.js';
import { cleanupWorktree, worktreeRoot, type HealDeps } from './land.js';
import {
  evidenceOf, getAttempt, setLedgerState, startAttempt, updateAttempt, type LedgerRow,
} from './ledger.js';
import { sendNotice } from './notice.js';
import { classify, signatureSlug } from './signature.js';
import { buildFixerPrompt, parseFixerReport } from './workItem.js';

export interface FixerDispatcher {
  dispatch(i: DispatchInput): Promise<DispatchResult>;
  finish(runId: string): Promise<unknown>;
}

export const BACKOFF_KEY = 'heal_backoff_until';
export const BACKOFF_MS = 10 * 60_000;

const ymd = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');
const one = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 160);

async function git(d: HealDeps, args: string[], cwd: string = d.root): Promise<{ ok: boolean; out: string }> {
  const r = await d.run('git', args, { cwd, timeoutMs: 120_000 });
  return { ok: r.code === 0, out: r.stdout.trim() };
}

export interface Prepared { branch: string; worktree: string; baseHead: string }

/** `git worktree add -b heal/<slug>-<date>[-n] <root>/.jobber/heal/wt/<name> HEAD`, with node_modules linked in. null on any git failure. */
export async function prepareWorktree(d: HealDeps, signature: string): Promise<Prepared | null> {
  const head = await git(d, ['rev-parse', 'HEAD']);
  if (!head.ok || !/^[0-9a-f]{7,64}$/.test(head.out)) return null;
  const base = `heal/${signatureSlug(signature)}-${ymd(d.now())}`;
  let branch = base;
  for (let n = 2; n < 50; n++) {
    const ex = await d.run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: d.root, timeoutMs: 30_000 });
    if (ex.code !== 0) break;
    branch = `${base}-${n}`;
  }
  const dir = path.join(worktreeRoot(d.root), branch.replace(/^heal\//, ''));
  try { mkdirSync(worktreeRoot(d.root), { recursive: true, mode: 0o700 }); } catch { return null; }
  const add = await d.run('git', ['worktree', 'add', '-b', branch, dir, 'HEAD'], { cwd: d.root, timeoutMs: 120_000 });
  if (add.code !== 0) return null;
  try {
    const nm = path.join(d.root, 'node_modules');
    if (existsSync(nm) && !existsSync(path.join(dir, 'node_modules'))) symlinkSync(nm, path.join(dir, 'node_modules'));
  } catch { /* the fixer can still read; tests would fail and the heal is abandoned */ }
  return { branch, worktree: dir, baseHead: head.out };
}

/** Commits anything the fixer left uncommitted (node_modules excluded). */
async function commitLeftovers(d: HealDeps, worktree: string, signature: string): Promise<void> {
  const spec = ['--', '.', ':(exclude)node_modules'];
  const st = await git(d, ['status', '--porcelain', ...spec], worktree);
  if (!st.ok || st.out === '') return;
  await git(d, ['add', '-A', ...spec], worktree);
  await d.run('git', ['-c', 'user.name=jobber-heal', '-c', 'user.email=heal@localhost', 'commit', '-m', `heal: ${one(signature)}`], { cwd: worktree, timeoutMs: 60_000 });
}

export interface FixerOutcome { attemptId: number; ready: boolean }

/** Runs one heal for a ledger row. Never throws. The attempt row records every outcome. */
export async function runFixer(d: HealDeps & { mode: string }, disp: FixerDispatcher, ledger: LedgerRow): Promise<FixerOutcome | null> {
  const verdict = classify(ledger.signature);
  if (!verdict.heal) return null; // never-heal signatures never reach a fixer, whatever the ledger says
  const prep = await prepareWorktree(d, ledger.signature);
  if (!prep) {
    try { setState(d.db, BACKOFF_KEY, new Date(d.now().getTime() + BACKOFF_MS).toISOString(), d.now()); } catch { /* ignore */ }
    return null;
  }
  // A second round after a failed live check carries the earlier evidence into the work item.
  let previousLive: string | undefined;
  try {
    const prev = d.db.prepare("SELECT live FROM heal_attempts WHERE ledger_id = ? AND outcome = 'live_failed' ORDER BY id DESC LIMIT 1").get(ledger.id) as { live: string | null } | undefined;
    if (prev?.live) previousLive = (JSON.parse(prev.live) as { verdict?: { evidence?: string } }).verdict?.evidence;
  } catch { /* none */ }
  const attemptId = startAttempt(d.db, ledger.id, { mode: d.mode, branch: prep.branch, worktree: prep.worktree, baseHead: prep.baseHead, at: d.now() });
  const fail = async (outcome: 'error' | 'abandoned' | 'gate_failed', why: string): Promise<FixerOutcome> => {
    updateAttempt(d.db, attemptId, { outcome, ended_at: d.now().toISOString(), note: one(why) });
    setLedgerState(d.db, ledger.id, 'gave_up', one(why));
    await sendNotice(d.alert, { kind: 'gave_up', signature: ledger.signature, ledgerId: ledger.id, detail: one(why) });
    await cleanupWorktree(d, prep.worktree);
    return { attemptId, ready: false };
  };
  try {
    await sendNotice(d.alert, { kind: 'started', signature: ledger.signature, ledgerId: ledger.id, detail: prep.branch });
    const prompt = buildFixerPrompt({
      ledgerId: ledger.id, attemptId, signature: ledger.signature, reason: verdict.reason, evidence: evidenceOf(ledger),
      branch: prep.branch, worktree: prep.worktree, baseHead: prep.baseHead, liveRoot: d.root, testability: verdict.testability,
      ...(previousLive ? { previousLive } : {}),
    });
    const res = await disp.dispatch({
      window: FIXER_WINDOW, lane: 'heal', trigger: 'heal', item: { signature: ledger.signature, ledger_id: ledger.id, attempt: attemptId },
      promptText: prompt, deadlineMs: FIXER_DEADLINE_MS,
    });
    if (res.status === 'unavailable' || res.status === 'usage_limit' || res.status === 'killed') {
      // Nothing was fixed and nothing is the fixer's fault: forget the attempt, try again later.
      d.db.prepare('DELETE FROM heal_attempts WHERE id = ?').run(attemptId);
      setLedgerState(d.db, ledger.id, 'open');
      d.db.prepare('UPDATE heal_ledger SET last_heal_id = NULL WHERE id = ? AND last_heal_id = ?').run(ledger.id, attemptId);
      try { setState(d.db, BACKOFF_KEY, new Date(d.now().getTime() + BACKOFF_MS).toISOString(), d.now()); } catch { /* ignore */ }
      if (res.runId) { try { await disp.finish(res.runId); } catch { /* ignore */ } }
      await cleanupWorktree(d, prep.worktree);
      return null;
    }
    if (res.runId) { try { await disp.finish(res.runId); } catch { /* ignore */ } }
    if (res.status !== 'ok') return await fail('error', `fixer item ${res.status}: ${res.stopReason}`);

    const report = parseFixerReport(res.summary, ledger.id);
    if (!report) return await fail('error', 'the fixer ended without a valid report line');
    updateAttempt(d.db, attemptId, { report: JSON.stringify(report) });
    if (report.verdict !== 'ready') return await fail('abandoned', `fixer abandoned: ${report.notes || 'no reason given'}`);
    if (report.full_suite !== 'pass' || report.mutation_check !== 'pass') return await fail('abandoned', 'fixer reported ready without a passing suite and mutation check');
    if (report.branch !== prep.branch) return await fail('gate_failed', 'report names another branch');

    await commitLeftovers(d, prep.worktree, ledger.signature);
    const head = await git(d, ['rev-parse', prep.branch]);
    if (!head.ok) return await fail('gate_failed', 'cannot read the branch head');
    const gate = await gateBranch({ run: d.run, cwd: d.root }, prep.baseHead, prep.branch);
    if (!gate.ok) return await fail('gate_failed', `gate: ${gate.reasons.slice(0, 3).join('; ')}`);

    updateAttempt(d.db, attemptId, { outcome: 'ready', head: head.out, files: JSON.stringify(gate.files), note: `ready: ${gate.files.length} files, ${gate.changedLines} lines` });
    setLedgerState(d.db, ledger.id, 'ready', `fix ready on ${prep.branch}`);
    if (d.mode !== 'auto') {
      await sendNotice(d.alert, { kind: 'ready', signature: ledger.signature, ledgerId: ledger.id, detail: `branch ${prep.branch}, ${gate.files.length} files`, command: `npm run heal -- land ${ledger.id}` });
    }
    return { attemptId, ready: true };
  } catch (e) {
    const row = getAttempt(d.db, attemptId);
    if (row && row.outcome === 'running') return await fail('error', `fixer run error: ${(e as Error).message}`);
    return { attemptId, ready: false };
  }
}
