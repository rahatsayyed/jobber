// src/heal/gate.ts
// THE LANDING GATE (code, never the model). Checks a heal branch against the base it was cut from:
//   (i)   no changed path touches the DENYLIST (the tamper guard's own protected list is reused, plus the extras below); no symlink or
//         submodule entry; no merge commit; the branch contains its base;
//   (ii)  size: at most MAX_FILES files and MAX_CHANGED_LINES changed lines, at least one new or changed test with a new `expect(`;
//   (iii) no test is weakened: a changed existing test file may not lose more `expect(` lines than it gains, may not be deleted, and may
//         not gain a skip / todo / only marker.
// Everything fails closed: a git error is a refusal. The pure parts (denyReason, evaluateDiff) take plain data so they are easy to test.
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Run } from '../platform/tmux.js';
import { MAX_CHANGED_LINES, MAX_FILES } from './config.js';

const require_ = createRequire(import.meta.url);
interface TamperGuard { PROTECTED: string[]; SECRET_DIRS: string[] }
const tamper = (): TamperGuard => require_(path.resolve(import.meta.dirname, '..', '..', '.claude', 'hooks', 'tamper-guard.cjs')) as TamperGuard;

/** Paths the healer may never change, beyond what the tamper guard already protects. Prefix (ends with /) or exact, lower case. */
export const EXTRA_DENY: ReadonlyArray<{ path: string; reason: string }> = [
  { path: '.jobber/', reason: 'runtime state (kill switch, locks, work files)' },
  { path: '.claude/', reason: 'hooks, settings, agents and skills guard the windows' },
  { path: '.git/', reason: 'git internals' },
  { path: '.github/', reason: 'CI configuration' },
  { path: 'node_modules/', reason: 'dependencies' },
  { path: 'config/permission-sets', reason: 'permission sets' },
  { path: 'config/run-profiles.json', reason: 'run profiles' },
  { path: 'config/runner/', reason: 'runner configuration' },
  { path: 'config/worker-tools.json', reason: 'tool lists of the subagents' },
  { path: 'config/manager-windows.json', reason: 'window allowlist and environment' },
  { path: 'config/windows/fixer.md', reason: 'the fixer role file (the healer never edits itself)' },
  { path: 'src/heal/', reason: 'the healer never edits itself' },
  { path: 'scripts/heal.ts', reason: 'the healer never edits itself' },
  { path: 'scripts/heal-live.ts', reason: 'the live-try runner is code-owned (the healer never edits itself)' },
  { path: 'tests/heal', reason: 'tests of the healer' },
  { path: 'src/safety/', reason: 'gates, dry run, kill switch, field, input and output gates' },
  { path: 'src/outreach/limits.ts', reason: 'ceilings' },
  { path: 'src/setup/limitscatalog.ts', reason: 'caps and ceilings catalog' },
  { path: 'src/settings/envcatalog.ts', reason: 'env catalog tiers and defaults' },
  { path: 'src/scheduler/control.ts', reason: 'halt and control state' },
  { path: 'src/scheduler/killswitch.ts', reason: 'kill switch' },
  { path: 'scripts/killswitch.ts', reason: 'kill switch' },
  { path: 'scripts/jobber-control.ts', reason: 'owner control commands' },
  { path: 'scripts/permissions.ts', reason: 'permission sets' },
  { path: 'scripts/claude-window.sh', reason: 'window launcher' },
  { path: 'scripts/window-env.ts', reason: 'window environment allowlist' },
  { path: 'src/platform/windowenv.ts', reason: 'window environment allowlist' },
  { path: 'src/platform/windowlaunch.ts', reason: 'window launch' },
  { path: 'src/platform/launchcheck.ts', reason: 'classifier launch check' },
  { path: 'package.json', reason: 'scripts and dependencies' },
  { path: 'package-lock.json', reason: 'dependencies' },
  { path: 'tsconfig.json', reason: 'type check settings' },
  { path: 'vitest.config.ts', reason: 'test settings' },
  { path: 'tests/safety-surfaces-lint.test.ts', reason: 'allowlist of the screened surfaces' },
];

/** Why a changed path is refused, or null when the healer may change it. `rel` is relative to the project root. */
export function denyReason(rel: string): string | null {
  const raw = String(rel ?? '');
  if (raw === '' || raw.includes('\0')) return 'empty or unsafe path';
  const p = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
  if (p.startsWith('/') || /^[a-z]:\//.test(p)) return 'absolute path';
  const segs = p.split('/').filter((s) => s !== '');
  if (segs.some((s) => s === '..')) return 'path escapes the project';
  if (segs.length === 0) return 'empty or unsafe path';
  for (const d of tamper().SECRET_DIRS) if (segs[0] === d) return `${d}/ is never touched`;
  if (segs.some((s) => s.startsWith('.env'))) return '.env files are never touched';
  if (segs.some((s) => s === '.git' || s === '.ssh' || s === '.aws' || s === '.gnupg')) return 'git or credential directory';
  if ((segs[segs.length - 1] ?? '').startsWith('data.sqlite')) return 'the database';
  if (/^\.claude\/settings/.test(p)) return 'Claude settings';
  const norm = segs.join('/');
  for (const q of tamper().PROTECTED) {
    const pq = q.toLowerCase();
    if (norm === pq || norm.startsWith(`${pq}/`)) return `protected by the tamper guard (${q})`;
  }
  for (const e of EXTRA_DENY) {
    if (e.path.endsWith('/') ? norm.startsWith(e.path) || `${norm}/` === e.path : norm === e.path || norm.startsWith(e.path)) return e.reason;
  }
  return null;
}

export interface DiffEntry { status: string; path: string; oldMode: string; newMode: string }
export interface NumStat { path: string; added: number; deleted: number; binary: boolean }
export interface TestPatch { path: string; removedExpects: number; addedExpects: number; addedSkips: number }

export interface GateResult {
  ok: boolean;
  reasons: string[];
  files: string[];
  changedLines: number;
  testFiles: string[];
}

export const isTestFile = (rel: string): boolean => /^tests\/.+\.test\.[cm]?[jt]sx?$/i.test(rel.replace(/\\/g, '/'));

const EXPECT_RE = /\bexpect\s*[.(]/;
const SKIP_RE = /\b(?:it|test|describe)\.(?:skip|todo|only|fails)\b|\bx(?:it|test|describe)\s*\(/;

/** Counts expect( lines and skip markers in a `git diff -U0` patch of one file. */
export function countPatch(rel: string, patch: string): TestPatch {
  const out: TestPatch = { path: rel, removedExpects: 0, addedExpects: 0, addedSkips: 0 };
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('-')) { if (EXPECT_RE.test(l)) out.removedExpects++; }
    else if (l.startsWith('+')) {
      if (EXPECT_RE.test(l)) out.addedExpects++;
      if (SKIP_RE.test(l)) out.addedSkips++;
    }
  }
  return out;
}

/** The pure decision over the collected facts. */
export function evaluateDiff(entries: DiffEntry[], stats: NumStat[], patches: TestPatch[], limits: { maxFiles: number; maxLines: number } = { maxFiles: MAX_FILES, maxLines: MAX_CHANGED_LINES }): GateResult {
  const reasons: string[] = [];
  const files = [...new Set(entries.map((e) => e.path))];
  if (files.length === 0) reasons.push('no changes');
  for (const e of entries) {
    const why = denyReason(e.path);
    if (why) reasons.push(`denied path ${e.path}: ${why}`);
    if (e.newMode === '120000' || e.oldMode === '120000') reasons.push(`symlink entry ${e.path}`);
    if (e.newMode === '160000' || e.oldMode === '160000') reasons.push(`submodule entry ${e.path}`);
  }
  if (files.length > limits.maxFiles) reasons.push(`too many files (${files.length} > ${limits.maxFiles})`);
  let changed = 0;
  for (const s of stats) {
    if (s.binary) reasons.push(`binary change ${s.path}`);
    changed += s.added + s.deleted;
  }
  if (changed > limits.maxLines) reasons.push(`too many changed lines (${changed} > ${limits.maxLines})`);
  const testFiles = entries.filter((e) => isTestFile(e.path) && e.status !== 'D').map((e) => e.path);
  for (const e of entries) if (isTestFile(e.path) && e.status === 'D') reasons.push(`test file deleted: ${e.path}`);
  if (testFiles.length === 0) reasons.push('no new or changed test');
  for (const p of patches) {
    if (p.removedExpects > p.addedExpects) reasons.push(`weakened test ${p.path}: removes ${p.removedExpects} expect( lines, adds ${p.addedExpects}`);
    if (p.addedSkips > 0) reasons.push(`skip marker added in ${p.path}`);
  }
  if (testFiles.length > 0 && !patches.some((p) => p.addedExpects > 0 && testFiles.includes(p.path))) reasons.push('the changed tests add no expect( line');
  return { ok: reasons.length === 0, reasons, files, changedLines: changed, testFiles };
}

/** Parses `git diff --raw -z --no-renames` output. */
export function parseRaw(out: string): DiffEntry[] {
  const t = out.split('\0');
  const res: DiffEntry[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(t[i] ?? '');
    if (!m) continue;
    res.push({ oldMode: m[1] as string, newMode: m[2] as string, status: m[3] as string, path: t[i + 1] as string });
  }
  return res;
}

/** Parses `git diff --numstat -z --no-renames` output. */
export function parseNumstat(out: string): NumStat[] {
  const res: NumStat[] = [];
  for (const rec of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    res.push({ path: m[3] as string, added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
  }
  return res;
}

export interface GitCtx { run: Run; cwd: string }

async function git(g: GitCtx, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  const r = await g.run('git', args, { cwd: g.cwd, timeoutMs });
  return { ok: r.code === 0, out: r.stdout };
}

/** Collects the facts of `base..branch` through git and runs the decision. Any git failure is a refusal. */
export async function gateBranch(g: GitCtx, base: string, branch: string): Promise<GateResult> {
  const fail = (why: string): GateResult => ({ ok: false, reasons: [why], files: [], changedLines: 0, testFiles: [] });
  if (!/^[0-9a-f]{7,64}$/.test(base)) return fail('bad base commit');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(branch) || branch.includes('..')) return fail('bad branch name');
  const anc = await g.run('git', ['merge-base', '--is-ancestor', base, branch], { cwd: g.cwd, timeoutMs: 30_000 });
  if (anc.code !== 0) return fail('branch does not contain its base commit');
  const merges = await git(g, ['rev-list', '--merges', `${base}..${branch}`]);
  if (!merges.ok) return fail('git rev-list failed');
  if (merges.out.trim() !== '') return fail('branch contains a merge commit');
  const range = `${base}..${branch}`;
  const raw = await git(g, ['diff', '--raw', '-z', '--no-renames', range]);
  const num = await git(g, ['diff', '--numstat', '-z', '--no-renames', range]);
  if (!raw.ok || !num.ok) return fail('git diff failed');
  const entries = parseRaw(raw.out);
  const stats = parseNumstat(num.out);
  const patches: TestPatch[] = [];
  for (const e of entries) {
    if (!isTestFile(e.path) || e.status === 'D') continue;
    const p = await git(g, ['diff', '-U0', '--no-renames', range, '--', e.path]);
    if (!p.ok) return fail(`git diff failed for ${e.path}`);
    patches.push(countPatch(e.path, p.out));
  }
  return evaluateDiff(entries, stats, patches);
}
