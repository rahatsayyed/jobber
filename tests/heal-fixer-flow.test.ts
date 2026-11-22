// tests/heal-fixer-flow.test.ts
// End to end: prepareWorktree + runFixer on a REAL temp git repo with a FAKE fixer window that commits on the worktree branch and returns a
// summary that went through the real secret redactor (redactPane), exactly like the live dispatcher. No network, no tmux, no model.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { BACKOFF_KEY, prepareWorktree, runFixer, type FixerDispatcher } from '../src/heal/fixer.js';
import { landAttempt, type HealDeps } from '../src/heal/land.js';
import { getAttempt, getLedger, migrateHealTables, recordSighting } from '../src/heal/ledger.js';
import { classify } from '../src/heal/signature.js';
import { redactPane } from '../src/platform/redact.js';
import type { Run } from '../src/platform/tmux.js';
import { getState } from '../src/scheduler/runLog.js';

const SIG = 'run:crashed:dispatch_error';
const TEST_V1 = "import { it, expect } from 'vitest';\nit('a', () => {\n  expect(1).toBe(1);\n});\n";
const GOOD: Record<string, string> = { 'src/a.ts': 'export const a = 2;\n', 'tests/a.test.ts': `${TEST_V1}it('b', () => { expect(3).toBe(3); });\n` };

let dir: string;
const g = (args: string[], cwd = dir): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (rel: string, text: string, cwd = dir): void => { mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); writeFileSync(path.join(cwd, rel), text); };
const realRun: Run = async (cmd, args, opts) => {
  try { return { stdout: execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0, stderr: '' }; }
  catch (e) { const x = e as { stdout?: string; stderr?: string }; return { stdout: String(x.stdout ?? ''), code: 1, stderr: String(x.stderr ?? '') }; }
};
const healBranches = (): string[] => g(['branch', '--list', 'heal/*']).split('\n').map((s) => s.trim()).filter(Boolean);
/** Resets heal worktrees and branches between loop rounds of one test. */
const resetHeal = (): void => {
  rmSync(path.join(dir, '.jobber', 'heal'), { recursive: true, force: true });
  g(['worktree', 'prune']);
  for (const b of healBranches()) g(['branch', '-D', b]);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heal-fixer-'));
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  write('src/a.ts', 'export const a = 1;\n');
  write('tests/a.test.ts', TEST_V1);
  write('.gitignore', '.jobber/\nnode_modules/\n');
  g(['add', '-A']); g(['commit', '-qm', 'base']);
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  mkdirSync(path.join(dir, '.jobber'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Rig { d: HealDeps & { mode: string }; db: ReturnType<typeof openDb>; alerts: string[]; calls: string[]; verifyCalls: string[] }
function rig(mode = 'suggest'): Rig {
  const db = openDb(':memory:');
  migrateHealTables(db);
  const alerts: string[] = []; const calls: string[] = []; const verifyCalls: string[] = [];
  const run: Run = async (cmd, args, opts) => {
    if (cmd === 'git') return realRun(cmd, args, { ...opts, cwd: opts?.cwd ?? dir });
    calls.push([cmd, ...args].join(' '));
    return { stdout: '', code: 0 };
  };
  const d: HealDeps & { mode: string } = {
    root: dir, env: {}, run, db, now: () => new Date(), sleep: async () => undefined, alert: async (t) => { alerts.push(t); }, killed: () => false,
    windowSession: 'Jobber', stackSession: 'Jobber', idleWaitMs: 0, idlePollMs: 1, mode,
    verify: async (cwd) => { verifyCalls.push(cwd); return { ok: true }; }, bootCheck: async () => true,
    liveCheck: async (_c, id) => ({ ledger_id: id, testability: 'live_until_commit', ran: true, result: 'pass', evidence: 'ok' }),
  };
  return { d, db, alerts, calls, verifyCalls };
}
const ledgerRow = (r: Rig, sig = SIG) => recordSighting(r.db, classify(sig), { runs: ['r1'], queue: [] }, new Date());

interface FakeOpts {
  edits?: Record<string, string>;
  verdict?: 'ready' | 'abandon';
  summary?: (report: string) => string;
  result?: { status: 'unavailable' | 'usage_limit' | 'killed' | 'failed'; stopReason?: string };
  notes?: string;
}
/** A fake fixer window: edits and commits on the worktree branch that code created, then answers like the dispatcher (redacted summary). */
function fakeFixer(o: FakeOpts = {}): FixerDispatcher & { seen: string[]; finished: string[] } {
  const seen: string[] = []; const finished: string[] = [];
  return {
    seen, finished,
    async dispatch(i) {
      seen.push(i.window);
      if (o.result) return { status: o.result.status, stopReason: o.result.stopReason ?? o.result.status, summary: '', toolCalls: 0, runId: 'fx-r' };
      const wt = /worktree: (\S+)/.exec(i.promptText)?.[1] as string;
      const br = /branch: (\S+)/.exec(i.promptText)?.[1] as string;
      const lid = Number(/ledger (\d+)/.exec(i.promptText)?.[1]);
      for (const [f, t] of Object.entries(o.edits ?? GOOD)) write(f, t, wt);
      g(['add', '-A', '--', '.', ':(exclude)node_modules'], wt);
      g(['-c', 'user.name=fx', '-c', 'user.email=fx@x', 'commit', '-qm', 'fix'], wt);
      const head = g(['rev-parse', 'HEAD'], wt);
      const report = JSON.stringify({ ledger_id: lid, branch: br, head, files: Object.keys(o.edits ?? GOOD), tests_added: 1, full_suite: 'pass', mutation_check: 'pass', verdict: o.verdict ?? 'ready', notes: o.notes ?? 'ok' });
      const text = o.summary ? o.summary(report) : `all done\n${report}`;
      return { status: 'ok' as const, stopReason: 'end_turn', summary: redactPane(text), toolCalls: 3, runId: 'fx-r' };
    },
    async finish(runId) { finished.push(runId); },
  };
}

describe('prepareWorktree', () => {
  it('cuts a heal/ branch from HEAD in .jobber/heal/wt, links node_modules, picks a free name', async () => {
    const r = rig();
    const p = await prepareWorktree(r.d, SIG);
    expect(p?.branch).toMatch(/^heal\/run-crashed-dispatch-error-\d{8}$/);
    expect(p?.baseHead).toBe(g(['rev-parse', 'HEAD']));
    expect(p?.worktree.startsWith(path.join(dir, '.jobber', 'heal', 'wt'))).toBe(true);
    expect(lstatSync(path.join(p?.worktree as string, 'node_modules')).isSymbolicLink()).toBe(true);
    const p2 = await prepareWorktree(r.d, SIG);
    expect(p2?.branch).toBe(`${p?.branch}-2`);
  });
  it('works without node_modules and returns null when git fails', async () => {
    const r = rig();
    rmSync(path.join(dir, 'node_modules'), { recursive: true });
    const p = await prepareWorktree(r.d, SIG);
    expect(existsSync(path.join(p?.worktree as string, 'node_modules'))).toBe(false);
    expect(await prepareWorktree({ ...r.d, run: async () => ({ stdout: '', code: 1 }) }, SIG)).toBeNull();
  });
});

describe('runFixer end to end', () => {
  it('(a) a good fix whose report branch and head came back as [redacted] is still ready, with head and files recorded', async () => {
    const r = rig(); const l = ledgerRow(r);
    const fx = fakeFixer();
    const out = await runFixer(r.d, fx, l);
    expect(out?.ready).toBe(true);
    const att = getAttempt(r.db, out?.attemptId as number);
    // the live failure is reproduced: the real redactor masks both fields of the report
    expect(JSON.parse(att?.report as string)).toMatchObject({ branch: '[redacted]', head: '[redacted]', verdict: 'ready' });
    expect(att?.outcome).toBe('ready');
    expect(att?.head).toBe(g(['rev-parse', att?.branch as string]));
    expect(JSON.parse(att?.files as string).sort()).toEqual(['src/a.ts', 'tests/a.test.ts']);
    expect(getLedger(r.db, l.id)?.state).toBe('ready');
    expect(fx.seen).toEqual(['fixer']);
    expect(fx.finished).toEqual(['fx-r']);
    expect(g(['rev-parse', 'HEAD'])).toBe(att?.base_head); // live checkout untouched
  });
  it('(a2) leftovers the fixer did not commit are committed by code', async () => {
    const r = rig(); const l = ledgerRow(r);
    const fx = fakeFixer();
    const orig = fx.dispatch.bind(fx);
    fx.dispatch = async (i) => {
      const wt = /worktree: (\S+)/.exec(i.promptText)?.[1] as string;
      const res = await orig(i);
      write('src/b.ts', 'export const b = 1;\n', wt); // left dirty after the fixer's own commit
      return res;
    };
    const out = await runFixer(r.d, fx, l);
    expect(out?.ready).toBe(true);
    const att = getAttempt(r.db, out?.attemptId as number);
    expect(JSON.parse(att?.files as string)).toContain('src/b.ts');
  });
  it('(b) verdict abandon ends abandoned and gave_up, with the note', async () => {
    const r = rig(); const l = ledgerRow(r);
    const out = await runFixer(r.d, fakeFixer({ verdict: 'abandon', notes: 'human wall, not a code bug' }), l);
    expect(out?.ready).toBe(false);
    const att = getAttempt(r.db, out?.attemptId as number);
    expect(att?.outcome).toBe('abandoned');
    expect(att?.note).toContain('human wall');
    expect(getLedger(r.db, l.id)?.state).toBe('gave_up');
    expect(r.alerts.join()).toContain('Heal gave up');
    expect(existsSync(att?.worktree as string)).toBe(false);
  });
  it('(c) a fix that touches a denylisted path ends gate_failed and nothing lands', async () => {
    for (const bad of ['.claude/hooks/x.cjs', 'src/safety/gate.ts']) {
      const r = rig(); const l = ledgerRow(r);
      const before = g(['rev-parse', 'HEAD']);
      const out = await runFixer(r.d, fakeFixer({ edits: { ...GOOD, [bad]: '// off\n' } }), l);
      expect(out?.ready, bad).toBe(false);
      const att = getAttempt(r.db, out?.attemptId as number);
      expect(att?.outcome, bad).toBe('gate_failed');
      expect(att?.note, bad).toContain('denied path');
      expect(getLedger(r.db, l.id)?.state, bad).toBe('gave_up');
      expect(g(['rev-parse', 'HEAD']), bad).toBe(before);
      expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), bad).toBe('export const a = 1;\n');
      resetHeal();
    }
  });
  it('(d) no valid report line ends in error', async () => {
    const bads = [(_r: string) => 'I finished but forgot the line', (r: string) => r.replace('"verdict"', '"verd"'), (r: string) => r.replace(/"ledger_id":\d+/, '"ledger_id":999')];
    for (const summary of bads) {
      const r = rig(); const l = ledgerRow(r);
      const out = await runFixer(r.d, fakeFixer({ summary }), l);
      expect(out?.ready).toBe(false);
      const att = getAttempt(r.db, out?.attemptId as number);
      expect(att?.outcome).toBe('error');
      expect(att?.note).toContain('valid report');
      expect(getLedger(r.db, l.id)?.state).toBe('gave_up');
      resetHeal();
    }
  });
  it('(d2) a failed dispatch item ends in error; a ready verdict without a passing suite is abandoned', async () => {
    const r = rig(); const l = ledgerRow(r);
    const out = await runFixer(r.d, fakeFixer({ result: { status: 'failed', stopReason: 'stalled' } }), l);
    expect(getAttempt(r.db, out?.attemptId as number)?.outcome).toBe('error');
    resetHeal();
    const r2 = rig(); const l2 = ledgerRow(r2);
    const out2 = await runFixer(r2.d, fakeFixer({ summary: (x) => x.replace('"full_suite":"pass"', '"full_suite":"fail"') }), l2);
    expect(getAttempt(r2.db, out2?.attemptId as number)?.outcome).toBe('abandoned');
  });
  it('(e) usage_limit, unavailable and killed forget the attempt, set the backoff and put the ledger back to open', async () => {
    for (const status of ['usage_limit', 'unavailable', 'killed'] as const) {
      const r = rig(); const l = ledgerRow(r);
      const fx = fakeFixer({ result: { status } });
      const out = await runFixer(r.d, fx, l);
      expect(out, status).toBeNull();
      expect(r.db.prepare('SELECT COUNT(*) n FROM heal_attempts').get(), status).toEqual({ n: 0 });
      const row = getLedger(r.db, l.id);
      expect(row?.state, status).toBe('open');
      expect(row?.last_heal_id, status).toBeNull();
      expect(Date.parse(getState(r.db, BACKOFF_KEY) ?? ''), status).toBeGreaterThan(Date.now());
      expect(fx.finished, status).toEqual(['fx-r']);
      expect(g(['worktree', 'list']).split('\n').length, status).toBe(1);
      resetHeal();
    }
  });
  it('a never-heal signature never reaches the fixer', async () => {
    const r = rig(); const l = ledgerRow(r, 'run:crashed:api_error');
    const fx = fakeFixer();
    expect(await runFixer(r.d, fx, l)).toBeNull();
    expect(fx.seen).toEqual([]);
  });
  it('(f) a stale base: the live branch moved on after the fix, landing reopens the signature', async () => {
    const r = rig(); const l = ledgerRow(r);
    const out = await runFixer(r.d, fakeFixer(), l);
    expect(out?.ready).toBe(true);
    write('src/other.ts', 'o\n'); g(['add', '-A']); g(['commit', '-qm', 'main moved']);
    const moved = g(['rev-parse', 'HEAD']);
    const res = await landAttempt(r.d, out?.attemptId as number);
    expect(res.ok).toBe(false);
    expect(getAttempt(r.db, out?.attemptId as number)?.outcome).toBe('stale_base');
    expect(getLedger(r.db, l.id)?.state).toBe('open');
    expect(g(['rev-parse', 'HEAD'])).toBe(moved);
    expect(r.verifyCalls.length).toBe(0);
  });
  it('(g1) suggest mode: a ready fix is never merged, the notice carries the land command', async () => {
    const r = rig('suggest'); const l = ledgerRow(r);
    const before = g(['rev-parse', 'HEAD']);
    const out = await runFixer(r.d, fakeFixer(), l);
    expect(out?.ready).toBe(true);
    expect(g(['rev-parse', 'HEAD'])).toBe(before);
    expect(g(['branch', '--show-current'])).toBe('main');
    expect(r.verifyCalls.length).toBe(0);
    expect(r.alerts.join('\n')).toContain(`npm run heal -- land ${l.id}`);
    expect(r.alerts.join('\n')).toContain('Fix ready');
  });
  it('(g2) auto mode: runFixer stops at ready (no land command), then the landing path merges it with fakes for verify, live try and restart', async () => {
    const r = rig('auto'); const l = ledgerRow(r);
    const out = await runFixer(r.d, fakeFixer(), l);
    expect(out?.ready).toBe(true);
    expect(r.alerts.join('\n')).not.toContain('npm run heal -- land');
    const att = getAttempt(r.db, out?.attemptId as number);
    const res = await landAttempt(r.d, out?.attemptId as number);
    expect(res.ok).toBe(true);
    expect(g(['rev-parse', 'HEAD'])).toBe(att?.head);
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(getAttempt(r.db, out?.attemptId as number)).toMatchObject({ outcome: 'landed', restart_state: 'pending' });
    expect(getLedger(r.db, l.id)?.state).toBe('landed');
    expect(r.verifyCalls.length).toBe(1);
    expect(r.calls.some((c) => c.startsWith('tmux') && !c.includes('list-windows'))).toBe(false); // no restart inside landAttempt
  });
});
