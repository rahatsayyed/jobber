// tests/heal-land.test.ts
// Self-heal landing gate and flow against a TEMP git repo: denylist, size caps, weakened tests, ff-only landing, idle check before restart,
// auto rollback by revert, requeue rule, the modes (off does nothing, suggest stops before the merge, auto lands). Nothing live: tmux and
// npx are fakes; git is real but only inside the temp repo.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { runHealCommand } from '../src/heal/cli.js';
import { countPatch, denyReason, evaluateDiff, gateBranch, parseNumstat, parseRaw } from '../src/heal/gate.js';
import { landAttempt, pendingRestarts, requeueSafeRows, restartTargets, rollbackAttempt, runPendingRestart, watchPass, type HealDeps } from '../src/heal/land.js';
import { getAttempt, getLedger, getLedgerBySignature, migrateHealTables, recordSighting, startAttempt, updateAttempt } from '../src/heal/ledger.js';
import { healTick } from '../src/heal/tick.js';
import { classify } from '../src/heal/signature.js';
import { takeWindowLock } from '../src/platform/windowLock.js';
import type { Run } from '../src/platform/tmux.js';
import { finishRun, startRun } from '../src/scheduler/runLog.js';

const ROOT = process.cwd();
let dir: string;
const g = (args: string[], cwd = dir): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (rel: string, text: string, cwd = dir): void => { mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); writeFileSync(path.join(cwd, rel), text); };
const TEST_V1 = "import { it, expect } from 'vitest';\nit('a', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heal-land-'));
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  write('src/a.ts', 'export const a = 1;\n');
  write('tests/a.test.ts', TEST_V1);
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  copyFileSync(path.join(ROOT, 'config/manager-windows.json'), path.join(dir, 'config/manager-windows.json'));
  write('.gitignore', '.jobber/\nnode_modules/\n');
  g(['add', '-A']); g(['commit', '-qm', 'base']);
  mkdirSync(path.join(dir, '.jobber'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A branch from main with the given edits (null deletes), committed; back on main. */
function branch(name: string, edits: Record<string, string | null>): string {
  g(['checkout', '-q', '-b', name]);
  for (const [f, t] of Object.entries(edits)) { if (t === null) g(['rm', '-q', f]); else write(f, t); }
  g(['add', '-A']); g(['commit', '-qm', `fix ${name}`]);
  const head = g(['rev-parse', 'HEAD']);
  g(['checkout', '-q', 'main']);
  return head;
}
const GOOD = { 'src/a.ts': 'export const a = 2;\n', 'tests/a.test.ts': `${TEST_V1}it('b', () => { expect(3).toBe(3); });\n` };
const baseHead = (): string => g(['rev-parse', 'main']);

const gate = (b: string, base = baseHead()) => gateBranch({ run: realRun, cwd: dir }, base, b);
const realRun: Run = async (cmd, args, opts) => {
  try { return { stdout: execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0, stderr: '' }; }
  catch (e) { const x = e as { stdout?: string; stderr?: string }; return { stdout: String(x.stdout ?? ''), code: 1, stderr: String(x.stderr ?? '') }; }
};

describe('denylist (denyReason)', () => {
  const denied = [
    'secrets/x.json', 'user-data/profile.json', 'models/m.bin', '.env', '.env.local', '.env.example', 'sub/.env.production', '.jobber/STOP', '.jobber/work/x.md',
    '.claude/hooks/tamper-guard.cjs', '.claude/settings.json', '.claude/settings.local.json', '.claude/agents/matcher.md', '.claude/skills/x/SKILL.md', '.mcp.json',
    'config/permission-sets.json', 'config/permission-sets.local.json', 'config/run-profiles.json', 'config/runner/x.json', 'config/worker-tools.json',
    'config/manager-windows.json', 'config/windows/fixer.md', 'src/heal/gate.ts', 'scripts/heal.ts', 'tests/heal-land.test.ts', 'src/safety/dryRun.ts',
    'src/safety/fieldGate.ts', 'src/outreach/limits.ts', 'src/setup/limitsCatalog.ts', 'src/settings/envCatalog.ts', 'src/scheduler/control.ts',
    'scripts/killSwitch.ts', 'scripts/jobber-control.ts', 'scripts/claude-window.sh', 'scripts/window-env.ts', 'package.json', 'package-lock.json', 'tsconfig.json',
    'vitest.config.ts', 'tests/safety-surfaces-lint.test.ts', '.git/config', 'data.sqlite', 'data.sqlite-wal', 'node_modules/x/y.js',
    '../outside.ts', '/etc/passwd', 'SECRETS/x', 'Src/Heal/Gate.ts', './src/heal/gate.ts', 'src\\heal\\gate.ts', 'src/ok/../heal/x.ts', '', 'a\0b',
  ];
  for (const p of denied) it(`refuses ${JSON.stringify(p)}`, () => expect(denyReason(p), p).not.toBeNull());
  it('allows ordinary source, script and test files and window role files other than the fixer', () => {
    for (const p of ['src/linkedin/discover.ts', 'src/browserctl/snapshot.ts', 'scripts/status.ts', 'tests/linkedin-x.test.ts', 'config/windows/linkedin.md', 'config/linkedin-discovery.json', 'src/mcp/linkedin.ts']) expect(denyReason(p), p).toBeNull();
  });
});

describe('evaluateDiff (pure)', () => {
  const ent = (p: string, s = 'M', nm = '100644') => ({ status: s, path: p, oldMode: '100644', newMode: nm });
  const stat = (p: string, n: number) => ({ path: p, added: n, deleted: 0, binary: false });
  const tp = (p: string, add: number, rem = 0, skips = 0) => ({ path: p, addedExpects: add, removedExpects: rem, addedSkips: skips });
  it('passes a small fix with a test', () => {
    expect(evaluateDiff([ent('src/a.ts'), ent('tests/a.test.ts')], [stat('src/a.ts', 3), stat('tests/a.test.ts', 20)], [tp('tests/a.test.ts', 2)]).ok).toBe(true);
  });
  it('refuses: no test, a test with no expect, too many files, too many lines, binary, symlink, submodule, deleted test, weakened test, skip marker, no changes', () => {
    const r = (e: ReturnType<typeof ent>[], s: ReturnType<typeof stat>[], p: ReturnType<typeof tp>[]) => evaluateDiff(e, s, p).reasons.join(' | ');
    expect(r([ent('src/a.ts')], [stat('src/a.ts', 1)], [])).toMatch(/no new or changed test/);
    expect(r([ent('src/a.ts'), ent('tests/a.test.ts')], [], [tp('tests/a.test.ts', 0)])).toMatch(/add no expect/);
    const many = Array.from({ length: 13 }, (_, i) => ent(`src/f${i}.ts`));
    expect(r([...many, ent('tests/a.test.ts')], [], [tp('tests/a.test.ts', 1)])).toMatch(/too many files/);
    expect(r([ent('src/a.ts'), ent('tests/a.test.ts')], [stat('src/a.ts', 401)], [tp('tests/a.test.ts', 1)])).toMatch(/too many changed lines/);
    expect(evaluateDiff([ent('src/a.ts'), ent('tests/a.test.ts')], [stat('src/a.ts', 400)], [tp('tests/a.test.ts', 1)]).ok).toBe(true);
    expect(r([ent('src/a.ts'), ent('tests/a.test.ts')], [{ path: 'x.png', added: 0, deleted: 0, binary: true }], [tp('tests/a.test.ts', 1)])).toMatch(/binary/);
    expect(r([ent('src/link.ts', 'A', '120000'), ent('tests/a.test.ts')], [], [tp('tests/a.test.ts', 1)])).toMatch(/symlink/);
    expect(r([ent('src/sub', 'A', '160000'), ent('tests/a.test.ts')], [], [tp('tests/a.test.ts', 1)])).toMatch(/submodule/);
    expect(r([ent('tests/a.test.ts', 'D'), ent('tests/b.test.ts')], [], [tp('tests/b.test.ts', 1)])).toMatch(/test file deleted/);
    expect(r([ent('src/a.ts'), ent('tests/a.test.ts')], [], [tp('tests/a.test.ts', 1, 3)])).toMatch(/weakened test/);
    expect(r([ent('src/a.ts'), ent('tests/a.test.ts')], [], [tp('tests/a.test.ts', 2, 0, 1)])).toMatch(/skip marker/);
    expect(r([], [], [])).toMatch(/no changes/);
    expect(r([ent('src/safety/x.ts'), ent('tests/a.test.ts')], [], [tp('tests/a.test.ts', 1)])).toMatch(/denied path src\/safety\/x.ts/);
  });
  it('counts expect lines and skip markers in a -U0 patch, equal removal and addition is allowed', () => {
    const p = countPatch('tests/a.test.ts', '--- a/x\n+++ b/x\n@@\n-  expect(1).toBe(1);\n-  expect(2).toBe(2);\n+  expect(1).toBe(1);\n+  expect(x).toEqual(2);\n+it.skip("z", () => {});\n');
    expect(p).toMatchObject({ removedExpects: 2, addedExpects: 2, addedSkips: 1 });
    expect(countPatch('t', '+  expect.soft(1)\n').addedExpects).toBe(1);
  });
  it('parses git raw and numstat output', () => {
    expect(parseRaw(':100644 100644 aaaaaaa bbbbbbb M\0src/a.ts\0:000000 120000 0000000 ccccccc A\0src/l\0')).toEqual([
      { oldMode: '100644', newMode: '100644', status: 'M', path: 'src/a.ts' }, { oldMode: '000000', newMode: '120000', status: 'A', path: 'src/l' }]);
    expect(parseNumstat('3\t1\tsrc/a.ts\0-\t-\tx.png\0')).toEqual([{ path: 'src/a.ts', added: 3, deleted: 1, binary: false }, { path: 'x.png', added: 0, deleted: 0, binary: true }]);
  });
});

describe('gateBranch on a real temp repo', () => {
  it('accepts a good fix', async () => {
    branch('heal/good', GOOD);
    const r = await gate('heal/good');
    expect(r.ok, r.reasons.join()).toBe(true);
    expect(r.files.sort()).toEqual(['src/a.ts', 'tests/a.test.ts']);
  });
  it('refuses each denied path class, even next to a good change', async () => {
    const paths = ['.env.local', 'secrets/k.json', '.claude/hooks/x.cjs', '.claude/settings.json', 'config/permission-sets.json', 'config/run-profiles.json', 'config/worker-tools.json',
      'config/manager-windows.json', 'config/windows/fixer.md', 'src/heal/x.ts', 'src/safety/x.ts', 'src/outreach/limits.ts', 'src/scheduler/control.ts', 'scripts/jobber-control.ts', 'package.json'];
    let i = 0;
    for (const p of paths) {
      branch(`heal/d${i}`, { ...GOOD, [p]: 'x\n' });
      const r = await gate(`heal/d${i++}`);
      expect(r.ok, p).toBe(false);
      expect(r.reasons.join(), p).toMatch(/denied path/);
    }
  });
  it('refuses a weakened test (fewer expects), a deleted test, a skip marker, and a change with no test', async () => {
    branch('heal/weak', { 'src/a.ts': 'export const a = 3;\n', 'tests/a.test.ts': "import { it, expect } from 'vitest';\nit('a', () => {\n  expect(1).toBe(1);\n});\n" });
    expect((await gate('heal/weak')).reasons.join()).toMatch(/weakened test/);
    branch('heal/del', { 'src/a.ts': 'export const a = 4;\n', 'tests/a.test.ts': null, 'tests/b.test.ts': "import { it, expect } from 'vitest';\nit('b', () => { expect(1).toBe(1); });\n" });
    expect((await gate('heal/del')).reasons.join()).toMatch(/test file deleted/);
    branch('heal/skip', { 'src/a.ts': 'export const a = 5;\n', 'tests/a.test.ts': `${TEST_V1}it.skip('c', () => { expect(1).toBe(1); });\n` });
    expect((await gate('heal/skip')).reasons.join()).toMatch(/skip marker/);
    branch('heal/notest', { 'src/a.ts': 'export const a = 6;\n' });
    expect((await gate('heal/notest')).reasons.join()).toMatch(/no new or changed test/);
  });
  it('refuses a symlink, an oversize change, a merge commit, a branch off another base, and bad inputs', async () => {
    g(['checkout', '-q', '-b', 'heal/link']);
    execFileSync('ln', ['-s', '/etc/passwd', 'src/l.ts'], { cwd: dir }); write('tests/a.test.ts', `${TEST_V1}it('b', () => { expect(3).toBe(3); });\n`);
    g(['add', '-A']); g(['commit', '-qm', 'l']); g(['checkout', '-q', 'main']);
    expect((await gate('heal/link')).reasons.join()).toMatch(/symlink/);
    branch('heal/big', { ...GOOD, 'src/big.ts': Array.from({ length: 450 }, (_, i) => `export const v${i} = ${i};`).join('\n') });
    expect((await gate('heal/big')).reasons.join()).toMatch(/too many changed lines/);
    g(['checkout', '-q', '-b', 'heal/merge']);
    write('src/m1.ts', 'x\n'); g(['add', '-A']); g(['commit', '-qm', 'm1']);
    g(['checkout', '-q', 'main']); g(['checkout', '-q', '-b', 'side']); write('src/m2.ts', 'y\n'); g(['add', '-A']); g(['commit', '-qm', 'm2']);
    g(['checkout', '-q', 'heal/merge']); g(['merge', '-q', '--no-ff', 'side', '-m', 'merge']); g(['checkout', '-q', 'main']);
    expect((await gate('heal/merge')).reasons.join()).toMatch(/merge commit/);
    const oldBase = baseHead();
    write('src/other.ts', 'o\n'); g(['add', '-A']); g(['commit', '-qm', 'main moved']);
    branch('heal/elsewhere', GOOD); // cut from the moved main: does not contain the OLD base? it does; use an orphan check instead
    g(['checkout', '-q', '--orphan', 'orph']); g(['commit', '-q', '--allow-empty', '-m', 'o']); g(['checkout', '-q', 'main']);
    expect((await gate('orph', oldBase)).reasons.join()).toMatch(/does not contain its base/);
    expect((await gate('heal/good', 'zzz')).reasons.join()).toMatch(/bad base/);
    expect((await gate('--evil', oldBase)).reasons.join()).toMatch(/bad branch/);
    expect((await gate('a..b', oldBase)).reasons.join()).toMatch(/bad branch/);
  });
});

describe('restartTargets', () => {
  it('maps changed files to windows and the scheduler; tests and docs alone restart nothing', () => {
    expect(restartTargets(['tests/a.test.ts', 'docs/x.md'])).toEqual({ windows: [], scheduler: false });
    expect(restartTargets(['src/linkedin/discover.ts', 'tests/x.test.ts'])).toEqual({ windows: ['linkedin', 'apply'], scheduler: true });
    expect(restartTargets(['src/naukri/x.ts']).windows).toEqual(['apply', 'boards'].sort((a, b) => ['mail', 'linkedin', 'sources', 'pipeline', 'boards', 'apply'].indexOf(a) - ['mail', 'linkedin', 'sources', 'pipeline', 'boards', 'apply'].indexOf(b)));
    expect(restartTargets(['src/db.ts']).windows.length).toBe(6);
    expect(restartTargets(['config/windows/mail.md'])).toEqual({ windows: ['mail'], scheduler: false });
    expect(restartTargets(['config/windows/fixer.md']).windows).toEqual([]);
  });
});

// ---- the flow ----

interface Rig { d: HealDeps; db: ReturnType<typeof openDb>; calls: string[]; alerts: string[]; tmuxWindows: string[]; verifyCalls: string[]; setNow: (t: Date) => void }
function rig(over: Partial<HealDeps> = {}): Rig {
  const db = openDb(':memory:');
  migrateHealTables(db);
  const calls: string[] = []; const alerts: string[] = []; const verifyCalls: string[] = [];
  const r: Rig = { d: undefined as unknown as HealDeps, db, calls, alerts, tmuxWindows: ['scheduler'], verifyCalls, setNow: () => undefined };
  let now = new Date();
  r.setNow = (t) => { now = t; };
  const run: Run = async (cmd, args, opts) => {
    if (cmd === 'git') return realRun(cmd, args, { ...opts, cwd: opts?.cwd ?? dir });
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'tmux' && args[0] === 'list-windows') return { stdout: r.tmuxWindows.map((n, i) => `${i}|${n}|0|claude`).join('\n'), code: 0 };
    return { stdout: '', code: 0 };
  };
  r.d = {
    root: dir, env: {}, run, db, now: () => now, sleep: async () => undefined, alert: async (t) => { alerts.push(t); }, killed: () => false,
    windowSession: 'Jobber', stackSession: 'Jobber', idleWaitMs: 0, idlePollMs: 1,
    verify: async (cwd) => { verifyCalls.push(cwd); return { ok: true }; }, bootCheck: async () => true,
    liveCheck: async (_c, id) => ({ ledger_id: id, testability: 'live_until_commit', ran: true, result: 'pass', evidence: 'ok' }), ...over,
  };
  return r;
}

let seq = 0;
/** A ledger row + a ready attempt on a good branch. */
function readyAttempt(r: Rig, sig = 'apply:easy_apply:resume_upload_failed', edits: Record<string, string | null> = GOOD): { ledgerId: number; attemptId: number; base: string; head: string } {
  const base = baseHead();
  const bn = `heal/fix${++seq}`;
  const head = branch(bn, edits);
  const l = recordSighting(r.db, classify(sig), { runs: ['r'], queue: [] }, new Date());
  const attemptId = startAttempt(r.db, l.id, { mode: 'auto', branch: bn, worktree: '', baseHead: base, at: new Date() });
  updateAttempt(r.db, attemptId, { outcome: 'ready', head });
  r.db.prepare("UPDATE heal_ledger SET state = 'ready' WHERE id = ?").run(l.id);
  return { ledgerId: l.id, attemptId, base, head };
}

describe('landing', () => {
  it('lands by ff-only, records prev_head, verifies first, queues the restart and alerts', async () => {
    const r = rig();
    const a = readyAttempt(r);
    const prev = g(['rev-parse', 'HEAD']);
    const res = await landAttempt(r.d, a.attemptId);
    expect(res.ok).toBe(true);
    expect(g(['rev-parse', 'HEAD'])).toBe(a.head);
    expect(g(['rev-list', '--count', 'main'])).toBe('2');
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    const att = getAttempt(r.db, a.attemptId);
    expect(att).toMatchObject({ outcome: 'landed', prev_head: prev, landed_head: a.head, restart_state: 'pending' });
    expect(JSON.parse(att?.restart_targets as string)).toEqual({ windows: ['mail', 'linkedin', 'sources', 'pipeline', 'boards', 'apply'], scheduler: true });
    expect(getLedger(r.db, a.ledgerId)?.state).toBe('landed');
    expect(r.verifyCalls.length).toBe(1);
    expect(r.alerts.join()).toContain('Fix landed');
    expect(r.alerts.join()).toContain('2 files');
  });
  it('refuses to land when the gate fails (a denied file slipped in after the report), nothing merges', async () => {
    const r = rig();
    const a = readyAttempt(r, 'run:failed:x', { ...GOOD, 'config/permission-sets.json': '{}\n' });
    const res = await landAttempt(r.d, a.attemptId);
    expect(res.ok).toBe(false);
    expect(g(['rev-parse', 'HEAD'])).toBe(a.base);
    expect(getAttempt(r.db, a.attemptId)?.outcome).toBe('gate_failed');
    expect(getLedger(r.db, a.ledgerId)?.state).toBe('gave_up');
    expect(r.verifyCalls.length).toBe(0);
  });
  it('refuses when the branch moved after the gate', async () => {
    const r = rig();
    const a = readyAttempt(r);
    g(['checkout', '-q', `heal/fix${seq}`]); write('src/extra.ts', 'z\n'); g(['add', '-A']); g(['commit', '-qm', 'later']); g(['checkout', '-q', 'main']);
    expect((await landAttempt(r.d, a.attemptId)).ok).toBe(false);
    expect(g(['rev-parse', 'HEAD'])).toBe(a.base);
  });
  it('a failing verify (tsc or tests) stops before the merge', async () => {
    const r = rig({ verify: async () => ({ ok: false, step: 'vitest', tail: '1 failed' }) });
    const a = readyAttempt(r);
    const res = await landAttempt(r.d, a.attemptId);
    expect(res).toMatchObject({ ok: false });
    expect(g(['rev-parse', 'HEAD'])).toBe(a.base);
    expect(getAttempt(r.db, a.attemptId)?.outcome).toBe('verify_failed');
  });
  it('the live branch moved on: no merge, the signature reopens for a fresh heal', async () => {
    const r = rig();
    const a = readyAttempt(r);
    write('src/owner.ts', 'owner work\n'); g(['add', '-A']); g(['commit', '-qm', 'owner']);
    const res = await landAttempt(r.d, a.attemptId);
    expect(res.ok).toBe(false);
    expect(getAttempt(r.db, a.attemptId)?.outcome).toBe('stale_base');
    expect(getLedger(r.db, a.ledgerId)?.state).toBe('open');
    expect(g(['log', '--format=%s', '-1'])).toBe('owner');
  });
  it('a detached live HEAD, the kill switch and a non-ready attempt all refuse', async () => {
    const r = rig();
    const a = readyAttempt(r);
    g(['checkout', '-q', '--detach']);
    expect((await landAttempt(r.d, a.attemptId)).ok).toBe(false);
    g(['checkout', '-q', 'main']);
    const k = rig({ killed: () => true });
    const b = readyAttempt(k, 'run:failed:y', GOOD);
    expect(await landAttempt(k.d, b.attemptId)).toMatchObject({ ok: false, reason: 'kill switch is on' });
    updateAttempt(r.db, a.attemptId, { outcome: 'running' });
    expect((await landAttempt(r.d, a.attemptId)).ok).toBe(false);
    expect((await landAttempt(r.d, 9999)).ok).toBe(false);
  });
  it('a boot check that fails after the merge reverts it at once, with no restart', async () => {
    const r = rig({ bootCheck: async () => false });
    const a = readyAttempt(r);
    const res = await landAttempt(r.d, a.attemptId);
    expect(res.ok).toBe(false);
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(g(['log', '--format=%s', '-1'])).toMatch(/^Revert/);
    expect(getAttempt(r.db, a.attemptId)).toMatchObject({ outcome: 'rolled_back', restart_state: 'done' });
    expect(getLedger(r.db, a.ledgerId)?.state).toBe('rolled_back');
  });
});

describe('restart only when idle', () => {
  const landed = async (r: Rig) => { const a = readyAttempt(r); await landAttempt(r.d, a.attemptId); return a; };
  const setTargets = (r: Rig, id: number, t: object) => updateAttempt(r.db, id, { restart_targets: JSON.stringify(t), restart_state: 'pending' });
  it('a running scheduler_runs row postpones the restart (nothing is killed); once it ends the restart happens and the watch starts', async () => {
    const r = rig();
    const a = await landed(r);
    setTargets(r, a.attemptId, { windows: [], scheduler: true });
    startRun(r.db, { id: 'busy', at: new Date(), trigger: 'wake', dryRun: false, tasks: [], status: 'running' });
    expect(await runPendingRestart(r.d, a.attemptId)).toBe('postponed');
    expect(r.calls.some((c) => c.includes('respawn-window') || c.includes('kill-window'))).toBe(false);
    expect(getAttempt(r.db, a.attemptId)?.restart_state).toBe('postponed');
    expect(r.alerts.filter((t) => t.includes('Restart postponed')).length).toBe(1);
    expect(pendingRestarts(r.db).length).toBe(1);
    expect(await runPendingRestart(r.d, a.attemptId)).toBe('postponed');
    expect(r.alerts.filter((t) => t.includes('Restart postponed')).length).toBe(1); // told once
    finishRun(r.db, 'busy', { at: new Date(), status: 'ok' });
    expect(await runPendingRestart(r.d, a.attemptId)).toBe('done');
    const resp = r.calls.find((c) => c.includes('respawn-window')) as string;
    expect(resp).toContain('=Jobber:=scheduler');
    expect(resp).toContain('--daemon');
    const att = getAttempt(r.db, a.attemptId);
    expect(att?.restart_state).toBe('done');
    expect(Date.parse(att?.watch_until as string)).toBeGreaterThan(Date.parse(att?.restart_at as string));
  });
  it('a held window lock (an item is running there) postpones that window restart; the run lock postpones everything', async () => {
    const r = rig();
    r.tmuxWindows = ['scheduler', 'mail'];
    const a = await landed(r);
    setTargets(r, a.attemptId, { windows: ['mail'], scheduler: false });
    const lock = takeWindowLock(dir, 'mail', 'test');
    expect(await runPendingRestart(r.d, a.attemptId)).toBe('postponed');
    expect(r.calls.some((c) => c.includes('kill-window'))).toBe(false);
    lock?.release();
  });
  it('the kill switch postpones; a scheduler that is not a tmux window asks the owner instead of guessing', async () => {
    const r2 = rig();
    const b = await landed(r2);
    setTargets(r2, b.attemptId, { windows: [], scheduler: true });
    r2.tmuxWindows = [];
    expect(await runPendingRestart(r2.d, b.attemptId)).toBe('manual');
    expect(r2.alerts.join()).toContain('Restart needed');
    expect(r2.calls.some((c) => c.includes('respawn-window'))).toBe(false);  });
  it('tests-only changes restart nothing', async () => {
    const r = rig();
    const a = readyAttempt(r, 'run:failed:t', { 'tests/a.test.ts': `${TEST_V1}it('b', () => { expect(3).toBe(3); });\n` });
    expect((await landAttempt(r.d, a.attemptId)).ok).toBe(true);
    expect(await runPendingRestart(r.d, a.attemptId)).toBe('nothing');
    expect(getAttempt(r.db, a.attemptId)?.restart_state).toBe('done');
    expect(r.calls.filter((c) => c.startsWith('tmux') && !c.includes('list-windows')).length).toBe(0);
  });
});

describe('auto rollback by revert', () => {
  async function watched(r: Rig) {
    const a = readyAttempt(r);
    await landAttempt(r.d, a.attemptId);
    const t0 = new Date();
    updateAttempt(r.db, a.attemptId, { restart_state: 'done', restart_at: t0.toISOString(), watch_until: new Date(t0.getTime() + 30 * 60_000).toISOString(), note: 'landed boot_ok' });
    return { ...a, t0 };
  }
  it('the same signature recurring inside the watch window reverts the landed commits (never reset --hard), restarts again and marks rolled_back', async () => {
    const r = rig();
    const a = await watched(r);
    const ownerCommit = (): void => { write('src/owner.ts', 'owner\n'); g(['add', '-A']); g(['commit', '-qm', 'owner after landing']); };
    ownerCommit();
    recordSighting(r.db, classify('apply:easy_apply:resume_upload_failed'), {}, new Date(a.t0.getTime() + 60_000));
    await watchPass(r.d);
    expect(getAttempt(r.db, a.attemptId)).toMatchObject({ outcome: 'rolled_back', restart_state: 'pending' });
    expect(getLedger(r.db, a.ledgerId)?.state).toBe('rolled_back');
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(readFileSync(path.join(dir, 'src/owner.ts'), 'utf8')).toBe('owner\n'); // owner work kept
    expect(g(['log', '--format=%s', '-1'])).toMatch(/^Revert/);
    expect(r.alerts.join()).toContain('Fix rolled back');
    expect(await runPendingRestart(r.d, a.attemptId)).toBe('done');
    expect(r.calls.some((c) => c.includes('respawn-window'))).toBe(true);
    expect(getAttempt(r.db, a.attemptId)?.watch_until).toBeNull();
  });
  it('a new crashed run reverts; an orphaned crash (daemon restart) and an old failure do not', async () => {
    const r = rig();
    const a = await watched(r);
    startRun(r.db, { id: 'o', at: new Date(), trigger: 'wake', dryRun: false, tasks: [], status: 'running' });
    r.db.prepare("UPDATE scheduler_runs SET status = 'crashed', ended_at = ?, stop_reason = 'orphaned' WHERE id = 'o'").run(new Date(a.t0.getTime() + 1000).toISOString());
    recordSighting(r.db, classify('apply:easy_apply:resume_upload_failed'), {}, new Date(a.t0.getTime() - 60_000));
    await watchPass(r.d);
    expect(getAttempt(r.db, a.attemptId)?.outcome).toBe('landed');
    startRun(r.db, { id: 'c', at: new Date(), trigger: 'wake', dryRun: false, tasks: [], status: 'running' });
    finishRun(r.db, 'c', { at: new Date(a.t0.getTime() + 2000), status: 'crashed', stopReason: 'dispatch_error' });
    await watchPass(r.d);
    expect(getAttempt(r.db, a.attemptId)?.outcome).toBe('rolled_back');
  });
  it('a failing post-restart boot check reverts; a quiet watch window ends stable', async () => {
    const bad = rig({ bootCheck: async (_c, ph) => ph === 'pre_restart' });
    const a = readyAttempt(bad);
    await landAttempt(bad.d, a.attemptId);
    const t0 = new Date();
    updateAttempt(bad.db, a.attemptId, { restart_state: 'done', restart_at: t0.toISOString(), watch_until: new Date(t0.getTime() + 60_000).toISOString() });
    await watchPass(bad.d);
    expect(getAttempt(bad.db, a.attemptId)?.outcome).toBe('rolled_back');
    const r = rig();
    const w = await watched(r);
    r.setNow(new Date(w.t0.getTime() + 31 * 60_000));
    await watchPass(r.d);
    expect(getAttempt(r.db, w.attemptId)?.outcome).toBe('stable');
    expect(r.alerts.join()).toContain('Fix stable');
  });
  it('if the revert conflicts it is aborted, the tree stays clean and the owner is told the command', async () => {
    const r = rig();
    const a = await watched(r);
    write('src/a.ts', 'export const a = 99;\n'); g(['add', '-A']); g(['commit', '-qm', 'owner edits same line']);
    const ok = await rollbackAttempt(r.d, getAttempt(r.db, a.attemptId) as never, 'test');
    expect(ok).toBe(false);
    expect(g(['status', '--porcelain'])).toBe('');
    expect(r.alerts.join()).toContain('revert by hand');
    expect(getLedger(r.db, a.ledgerId)?.state).toBe('gave_up');
  });
});

describe('requeue rule', () => {
  const addRow = (r: Rig, job: string, note = 'easy_apply:resume_upload_failed - x', status = 'needs_owner'): number =>
    Number(r.db.prepare("INSERT INTO outreach_queue (job_id, apply_platform, apply_status, apply_note) VALUES (?, 'linkedin', ?, ?)").run(job, status, note).lastInsertRowid);
  it('puts back at most 3 parked rows of this signature, never one with an application or an outcome, never another signature', () => {
    const r = rig();
    const ids = [addRow(r, 'j1'), addRow(r, 'j2'), addRow(r, 'j3'), addRow(r, 'j4'), addRow(r, 'j5'), addRow(r, 'j6', 'external:no_popup'), addRow(r, 'j7', 'easy_apply:resume_upload_failed', 'needs_human')];
    r.db.prepare("INSERT INTO applications (job_id, status) VALUES ('j2', 'submitted')").run();
    r.db.prepare("INSERT INTO job_outcomes (job_id, outcome) VALUES ('j3', 'replied')").run();
    const l = recordSighting(r.db, classify('apply:easy_apply:resume_upload_failed'), { queue: ids }, new Date());
    expect(l.requeue_safe).toBe(1);
    const n = requeueSafeRows(r.d, getLedger(r.db, l.id) as never);
    expect(n).toBe(3);
    const st = (id: number) => (r.db.prepare('SELECT apply_status s, status FROM outreach_queue WHERE id = ?').get(id) as { s: string | null; status: string });
    expect([st(ids[0]).s, st(ids[1]).s, st(ids[2]).s, st(ids[3]).s, st(ids[4]).s]).toEqual([null, 'needs_owner', 'needs_owner', null, null]);
    expect(st(ids[5]).s).toBe('needs_owner');
    expect(st(ids[6]).s).toBe('needs_human');
    expect(requeueSafeRows(r.d, getLedger(r.db, l.id) as never)).toBe(0); // idempotent
  });
  it('a signature not marked requeue_safe puts nothing back', () => {
    const r = rig();
    const id = addRow(r, 'j9', 'external:host_x_parse');
    const l = recordSighting(r.db, classify('apply:external:no_popup'), { queue: [id] }, new Date());
    expect(l.requeue_safe).toBe(1);
    const l2 = recordSighting(r.db, classify('run:crashed:dispatch_error'), { queue: [id] }, new Date());
    expect(requeueSafeRows(r.d, l2)).toBe(0);
  });
  it('runs after the restart of a landing, and not after a rollback', async () => {
    const r = rig();
    const id = addRow(r, 'jq');
    const a = readyAttempt(r);
    r.db.prepare('UPDATE heal_ledger SET evidence = ? WHERE id = ?').run(JSON.stringify({ runs: [], queue: [id], diag: [], note: '' }), a.ledgerId);
    r.db.prepare('UPDATE heal_ledger SET requeue_safe = 1 WHERE id = ?').run(a.ledgerId);
    await landAttempt(r.d, a.attemptId);
    expect(await runPendingRestart(r.d, a.attemptId)).toBe('done');
    expect(getAttempt(r.db, a.attemptId)?.requeued).toBe(1);
    expect((r.db.prepare('SELECT apply_status s FROM outreach_queue WHERE id = ?').get(id) as { s: string | null }).s).toBeNull();
  });
});

// ---- modes: a fake fixer window that really edits a worktree ----

function fakeFixer(r: Rig, edits: Record<string, string | null>, verdict = 'ready') {
  const seen: string[] = [];
  return {
    seen,
    dispatch: async (i: { promptText: string; window: string }) => {
      seen.push(i.window);
      const wt = /worktree: (\S+)/.exec(i.promptText)?.[1] as string;
      const br = /branch: (\S+)/.exec(i.promptText)?.[1] as string;
      const lid = Number(/ledger (\d+)/.exec(i.promptText)?.[1]);
      for (const [f, t] of Object.entries(edits)) write(f, t as string, wt);
      g(['add', '-A', '--', '.', ':(exclude)node_modules'], wt); // committed by code when left over; here leave it dirty on purpose
      const report = JSON.stringify({ ledger_id: lid, branch: br, head: 'x', files: Object.keys(edits), tests_added: 1, full_suite: 'pass', mutation_check: 'pass', verdict, notes: 'ok' });
      return { status: 'ok' as const, stopReason: 'end_turn', summary: `done\n${report}`, toolCalls: 3, runId: 'fx1' };
    },
    finish: async () => undefined,
  };
}
function addFailedRun(r: Rig, stop = 'dispatch_error'): void {
  startRun(r.db, { id: `f${Math.random()}`.slice(0, 8), at: new Date(Date.now() - 60_000), trigger: 'wake', dryRun: false, tasks: [], status: 'running', window: 'linkedin' });
  r.db.prepare("UPDATE scheduler_runs SET status = 'crashed', ended_at = ?, stop_reason = ? WHERE status = 'running'").run(new Date().toISOString(), stop);
}
const tickDeps = (r: Rig, env: NodeJS.ProcessEnv, windows?: ReturnType<typeof fakeFixer>) =>
  ({ ...r.d, env, dryRun: () => false, inQuiet: () => false, everyMs: 0, ...(windows ? { windows } : {}) });

describe('modes', () => {
  it('off does nothing: no ledger, no worktree, no dispatch', async () => {
    const r = rig(); addFailedRun(r);
    const fx = fakeFixer(r, GOOD);
    const t = healTick(tickDeps(r, { HEAL_MODE: 'off' }, fx));
    await t(); await t.idle();
    expect(r.db.prepare('SELECT COUNT(*) n FROM heal_ledger').get()).toEqual({ n: 0 });
    expect(fx.seen).toEqual([]);
    expect(g(['worktree', 'list']).split('\n').length).toBe(1);
  });
  it('the kill switch and a dry run stop it before detection', async () => {
    const r = rig({ killed: () => true }); addFailedRun(r);
    const t = healTick(tickDeps(r, { HEAL_MODE: 'auto' }, fakeFixer(r, GOOD)));
    await t(); await t.idle();
    expect(r.db.prepare('SELECT COUNT(*) n FROM heal_ledger').get()).toEqual({ n: 0 });
    const r2 = rig(); addFailedRun(r2);
    const t2 = healTick({ ...tickDeps(r2, { HEAL_MODE: 'auto' }, fakeFixer(r2, GOOD)), dryRun: () => true });
    await t2(); await t2.idle();
    expect(r2.db.prepare('SELECT COUNT(*) n FROM heal_ledger').get()).toEqual({ n: 0 });
  });
  it('a never-heal failure is recorded but never reaches the fixer', async () => {
    const r = rig(); addFailedRun(r, 'api_error');
    const fx = fakeFixer(r, GOOD);
    const t = healTick(tickDeps(r, { HEAL_MODE: 'auto' }, fx));
    await t(); await t.idle();
    expect(fx.seen).toEqual([]);
    expect(getLedgerBySignature(r.db, 'run:crashed:api_error')?.state).toBe('ignored');
  });
  it('suggest: runs the fixer on a heal/ branch in a worktree, gates it, then STOPS before merge and restart and says how to land', async () => {
    const r = rig(); addFailedRun(r);
    const fx = fakeFixer(r, GOOD);
    const before = g(['rev-parse', 'HEAD']);
    const t = healTick(tickDeps(r, {}, fx));
    await t(); await t.idle();
    expect(fx.seen).toEqual(['fixer']);
    const l = getLedgerBySignature(r.db, 'run:crashed:dispatch_error');
    expect(l?.state).toBe('ready');
    const att = getAttempt(r.db, l?.last_heal_id as number);
    expect(att?.branch).toMatch(/^heal\/run-crashed-dispatch-error-\d{8}$/);
    expect(att?.outcome).toBe('ready');
    expect(g(['rev-parse', 'HEAD'])).toBe(before); // live checkout untouched
    expect(g(['branch', '--show-current'])).toBe('main');
    expect(g(['rev-parse', att?.branch as string])).not.toBe(before);
    expect(r.verifyCalls.length).toBe(0);
    expect(r.calls.some((c) => c.startsWith('tmux') && !c.includes('list-windows'))).toBe(false);
    expect(r.alerts.join()).toContain(`npm run heal -- land ${l?.id}`);
    // another tick in suggest mode never lands it
    await t(); await t.idle();
    expect(g(['rev-parse', 'HEAD'])).toBe(before);
    // the owner lands it
    const out = await runHealCommand(r.d, ['land', String(l?.id)]);
    expect(out.code).toBe(0);
    expect(g(['rev-parse', 'HEAD'])).toBe(g(['rev-parse', att?.branch as string]));
  });
  it('auto: the same flow lands on the next tick, then restarts when idle', async () => {
    const r = rig(); addFailedRun(r);
    const t = healTick(tickDeps(r, { HEAL_MODE: 'auto' }, fakeFixer(r, GOOD)));
    await t(); await t.idle();
    const l = getLedgerBySignature(r.db, 'run:crashed:dispatch_error');
    expect(l?.state).toBe('ready');
    await t(); await t.idle();
    expect(getLedger(r.db, l?.id as number)?.state).toBe('landed');
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(getAttempt(r.db, l?.last_heal_id as number)?.restart_state).toBe('done');
    expect(r.calls.some((c) => c.includes('respawn-window'))).toBe(true);
  });
  it('a fixer that touches a denied path is thrown away: never ready, never landed', async () => {
    const r = rig(); addFailedRun(r);
    const t = healTick(tickDeps(r, { HEAL_MODE: 'auto' }, fakeFixer(r, { ...GOOD, '.claude/hooks/tamper-guard.cjs': '// off\n' })));
    await t(); await t.idle(); await t(); await t.idle();
    const l = getLedgerBySignature(r.db, 'run:crashed:dispatch_error');
    expect(l?.state).toBe('gave_up');
    expect(getAttempt(r.db, l?.last_heal_id as number)?.outcome).toBe('gate_failed');
    expect(g(['rev-parse', 'HEAD'])).not.toBe('');
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });
  it('an abandon verdict and a fixer that is unavailable are handled: abandon gives up, unavailable forgets the attempt', async () => {
    const r = rig(); addFailedRun(r);
    const t = healTick(tickDeps(r, { HEAL_MODE: 'auto' }, fakeFixer(r, GOOD, 'abandon')));
    await t(); await t.idle();
    expect(getLedgerBySignature(r.db, 'run:crashed:dispatch_error')?.state).toBe('gave_up');
    const r2 = rig(); addFailedRun(r2);
    const down = { dispatch: async () => ({ status: 'unavailable' as const, stopReason: 'window_unavailable', summary: '', toolCalls: 0 }), finish: async () => undefined };
    const t2 = healTick(tickDeps(r2, { HEAL_MODE: 'auto' }, down as never));
    await t2(); await t2.idle();
    expect(getLedgerBySignature(r2.db, 'run:crashed:dispatch_error')?.state).toBe('open');
    expect(r2.db.prepare('SELECT COUNT(*) n FROM heal_attempts').get()).toEqual({ n: 0 });
    await t2(); await t2.idle(); // backoff: no second try right away
    expect(r2.db.prepare('SELECT COUNT(*) n FROM heal_attempts').get()).toEqual({ n: 0 });
  });
  it('quiet hours start no new heal', async () => {
    const r = rig(); addFailedRun(r);
    const fx = fakeFixer(r, GOOD);
    const t = healTick({ ...tickDeps(r, {}, fx), inQuiet: () => true });
    await t(); await t.idle();
    expect(fx.seen).toEqual([]);
    expect(getLedgerBySignature(r.db, 'run:crashed:dispatch_error')?.state).toBe('open');
  });
});

describe('owner CLI', () => {
  it('status and list print; ignore stops a signature; land and revert refuse with the kill switch, HEAL_MODE=off and a wrong state', async () => {
    const r = rig();
    const a = readyAttempt(r);
    expect((await runHealCommand(r.d, ['status'])).lines.join('\n')).toContain('mode: suggest');
    expect((await runHealCommand(r.d, ['list'])).lines.join('\n')).toContain('apply:easy_apply:resume_upload_failed');
    expect((await runHealCommand(r.d, ['bogus'])).code).toBe(2);
    expect((await runHealCommand(r.d, ['land'])).code).toBe(2);
    expect((await runHealCommand(r.d, ['land', 'abc'])).code).toBe(2);
    expect((await runHealCommand({ ...r.d, killed: () => true }, ['land', String(a.ledgerId)])).code).toBe(3);
    expect((await runHealCommand({ ...r.d, env: { HEAL_MODE: 'off' } }, ['land', String(a.ledgerId)])).code).toBe(3);
    expect((await runHealCommand(r.d, ['revert', String(a.ledgerId)])).code).toBe(1); // nothing landed yet
    expect((await runHealCommand(r.d, ['ignore', 'run:failed:x'])).code).toBe(0);
    expect(getLedgerBySignature(r.db, 'run:failed:x')?.state).toBe('ignored');
    expect((await runHealCommand(r.d, ['ignore', 'Bad Sig!'])).code).toBe(2);
    const landed = await runHealCommand(r.d, ['land', String(a.ledgerId)]);
    expect(landed.code).toBe(0);
    expect((await runHealCommand(r.d, ['land', String(a.ledgerId)])).code).toBe(1); // already landed
    const rev = await runHealCommand(r.d, ['revert', String(a.ledgerId)]);
    expect(rev.code).toBe(0);
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(getLedger(r.db, a.ledgerId)?.state).toBe('rolled_back');
  });
});
