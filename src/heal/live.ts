// src/heal/live.ts
// The LIVE TRY runner behind `npm run heal:live -- <ledger_id>` (scripts/heal-live.ts). It runs from a fixer worktree, so it loads the
// WORKTREE code, and tries the real action of a failure signature with the shared browser (the project's own MCP handlers, an own tab).
// Hard rules, enforced here in code and covered by tests:
//   - it works on a TEMP COPY of the SQLite database (assertTempDb refuses anything else); the live data.sqlite is only read to make the copy
//   - it can never commit: the handler proxy refuses every arm, submit, send, attach and raw click tool; the only click is clickByName,
//     which refuses a control named submit, send, connect, post, confirm, done, apply (alone) and so on, and the check stops before the commit
//     control and discards the modal
//   - it refuses (verdict `skipped`) when the kill switch or a halt is on, outside LINKEDIN_ACTIVE_HOURS (LinkedIn), and while the live stack
//     holds a run or a window item for the same platform (two sessions on one account), so landing waits for the next tick
//   - at most ONE page load per check (open, search, discover, JD read count); a second load throws
// The verdict is {ledger_id, testability, ran, result: pass|fail|skipped, evidence}. A check that cannot run or errors is `skipped`, never
// `fail` (a skip only delays landing; a wrong fail would throw a good fix away). The real checks are UNVERIFIED against the live site.
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowLockHeld } from '../platform/windowLock.js';
import { classify, type Testability } from './signature.js';

export interface LiveVerdict {
  ledger_id: number;
  testability: Testability;
  ran: boolean;
  result: 'pass' | 'fail' | 'skipped';
  evidence: string;
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
export type Handlers = Record<string, Handler>;

// ---- the live root and the temp database ----

/** The live checkout of a fixer worktree (`<root>/.jobber/heal/wt/<name>`), or the directory itself when it is not a worktree. */
export function liveRootOf(cwd: string): string {
  const sep = path.sep;
  const mark = `${sep}.jobber${sep}heal${sep}wt${sep}`;
  const i = cwd.indexOf(mark);
  return i >= 0 ? cwd.slice(0, i) : cwd;
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/** Throws unless `file` is a path under the OS temp directory and not the live database. */
export function assertTempDb(file: string, liveFile: string): void {
  const f = path.resolve(file);
  const tmp = real(tmpdir());
  const within = real(path.dirname(f)).startsWith(tmp + path.sep) || real(path.dirname(f)) === tmp;
  if (!within) throw new Error('live check: the database must be a temp copy');
  if (real(path.dirname(f)) + path.sep + path.basename(f) === real(path.dirname(liveFile)) + path.sep + path.basename(liveFile)) throw new Error('live check: refusing the live database');
}

/** Copies the live database with SQLite's backup API (the live file is opened read-only). */
export async function copyDbToTemp(liveFile: string): Promise<{ file: string; cleanup: () => void }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'heal-live-'));
  const file = path.join(dir, 'data.sqlite');
  assertTempDb(file, liveFile);
  const src = new Database(liveFile, { readonly: true, fileMustExist: true });
  try { await src.backup(file); } finally { src.close(); }
  return { file, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

// ---- the commit guard and the one-load limit ----

export class CommitRefused extends Error {}
export class LoadLimit extends Error {}

/** Tools that arm, commit, send, attach or apply: never callable by a live check. */
export const COMMIT_TOOL_RE = /(arm_send|arm_apply|apply_submit|apply_next|apply_fill|apply_autofill|send_email|attach_file|easy_apply_fill|check_and_increment|click_at|resolve_external|site_login|site_signup)/;
/** Raw page actions: only clickByName may click; typing and keys are refused. */
const RAW_ACTION_RE = /_(click|type|press_key)$/;
/** Tools that load a page: counted against the one-load limit. */
const LOAD_RE = /_(open|search_jobs|search_posts|discover|fetch_jd|manual_job|search|read_thread)$/;
/** Control names that commit something: never clicked. The Easy Apply opener and the review step are not in this list. */
export const COMMIT_NAME_RE = /\b(submit( application)?|send( now| invitation| without a note| message)?|connect|post|publish|confirm|finish|done|follow|accept)\b|^apply$|apply now/i;
const EASY_OPEN_RE = /^easy apply\b/i;

export interface Guarded {
  handlers: Handlers;
  loads: () => number;
  clickByName: (platform: string, snapshot: unknown, name: RegExp) => Promise<{ clicked: boolean; name: string }>;
}

/** Finds the first `{ref, name}` pair in a snapshot-like object whose name matches. */
export function findRef(snapshot: unknown, name: RegExp): { ref: string; name: string } | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): { ref: string; name: string } | null => {
    if (v === null || typeof v !== 'object' || depth > 12 || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.ref === 'string' && typeof o.name === 'string' && name.test(o.name)) return { ref: o.ref, name: o.name };
    for (const x of Array.isArray(v) ? v : Object.values(o)) { const r = walk(x, depth + 1); if (r) return r; }
    return null;
  };
  return walk(snapshot, 0);
}

export function guardHandlers(raw: Handlers, o: { maxLoads?: number } = {}): Guarded {
  const max = o.maxLoads ?? 1;
  let loads = 0;
  let clickOk = false;
  const handlers = new Proxy(raw, {
    get(target, prop) {
      const name = String(prop);
      const fn = target[name];
      if (typeof fn !== 'function') return fn;
      return async (args: Record<string, unknown> = {}) => {
        if (COMMIT_TOOL_RE.test(name)) throw new CommitRefused(`live check may not call ${name}`);
        if (RAW_ACTION_RE.test(name) && !(clickOk && name.endsWith('_click'))) throw new CommitRefused(`live check may not call ${name} directly`);
        if (LOAD_RE.test(name)) {
          loads += 1;
          if (loads > max) throw new LoadLimit(`live check: at most ${max} page load per check`);
        }
        return fn(args);
      };
    },
  }) as Handlers;
  const clickByName = async (platform: string, snapshot: unknown, nameRe: RegExp): Promise<{ clicked: boolean; name: string }> => {
    const hit = findRef(snapshot, nameRe);
    if (!hit) return { clicked: false, name: '' };
    if (COMMIT_NAME_RE.test(hit.name) && !EASY_OPEN_RE.test(hit.name)) throw new CommitRefused(`refusing to click "${hit.name.slice(0, 40)}"`);
    clickOk = true;
    try { await handlers[`${platform}_click`]({ ref: hit.ref }); } finally { clickOk = false; }
    return { clicked: true, name: hit.name };
  };
  return { handlers, loads: () => loads, clickByName };
}

// ---- policy ----

/** The worker windows that use one platform's account: a run or item of one of them blocks a live check. */
export const PLATFORM_WINDOWS: Record<string, string[]> = { linkedin: ['linkedin', 'apply'], naukri: ['boards', 'apply'], wellfound: ['boards', 'apply'], scout: ['sources'] };

type Db = Database.Database;

/** A reason to skip, or null. `db` is the temp copy (it holds the halts and the scheduler_runs rows as of the copy). */
export function refusalReason(o: {
  platform: string; db: Db; liveRoot: string; env: NodeJS.ProcessEnv; now: Date; killed: boolean; haltedPlatform: boolean; activeNow: boolean;
}): string | null {
  if (o.killed) return 'kill_switch_or_halt';
  if (o.haltedPlatform) return 'platform_halted';
  if (o.platform === 'linkedin' && !o.activeNow) return 'outside_active_hours';
  const wins = PLATFORM_WINDOWS[o.platform] ?? [];
  try {
    for (const r of o.db.prepare("SELECT window, trigger FROM scheduler_runs WHERE status = 'running'").all() as Array<{ window: string | null; trigger: string }>) {
      if (r.trigger === 'heal') continue;
      if (r.window && wins.includes(r.window)) return 'platform_busy';
    }
  } catch { return 'scheduler_runs_unreadable'; }
  for (const w of wins) if (windowLockHeld(o.liveRoot, w)) return 'platform_busy';
  return null;
}

// ---- the checks ----

export interface CheckCtx {
  g: Guarded;
  db: Db;
  worktree: string;
  ledgerQueueIds: number[];
}
export type CheckResult = { result: 'pass' | 'fail' | 'skipped'; evidence: string };
export type LiveCheck = (c: CheckCtx) => Promise<CheckResult>;

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const skip = (evidence: string): CheckResult => ({ result: 'skipped', evidence });
const SKIP_STATUSES = new Set(['halted', 'rate_limited', 'refused', 'dry_run']);

/** LinkedIn job search (read only): the first configured job search must return cards. */
const discoverSearch: LiveCheck = async (c) => {
  const cfg = await import(pathToFileURL(path.join(c.worktree, 'src/linkedin/discoveryConfig.ts')).href) as { loadDiscoveryConfig: () => { jobs: Array<{ name: string }> } };
  const name = cfg.loadDiscoveryConfig().jobs[0]?.name;
  if (!name) return skip('no named job search configured');
  const r = rec(await c.g.handlers.linkedin_search_jobs({ search: name }));
  const status = String(r.status ?? ''); const code = String(r.code ?? '');
  if (SKIP_STATUSES.has(status) || code === 'logged_out') return skip(`search not run: ${status}/${code}`);
  if (status === 'ok' && Number(r.fetched ?? 0) > 0) return { result: 'pass', evidence: `search ${name}: ${r.fetched} cards, parser ${String(r.parser ?? 'primary')}` };
  return { result: 'fail', evidence: `search ${name}: status ${status}, code ${code || 'none'}, fetched ${Number(r.fetched ?? 0)}` };
};

/** LinkedIn JD read: the typed tool picks the next waiting job from the temp copy (nothing is sent). */
const jdRead: LiveCheck = async (c) => {
  const r = rec(await c.g.handlers.linkedin_fetch_jd({}));
  const status = String(r.status ?? ''); const code = String(r.code ?? '');
  if (code === 'none' || SKIP_STATUSES.has(status)) return skip(`no JD read: ${status}/${code}`);
  if (status === 'ok' && !/incomplete|truncat/i.test(code)) return { result: 'pass', evidence: `JD read ok (${code || 'complete'})` };
  return { result: 'fail', evidence: `JD read: status ${status}, code ${code}` };
};

/** Easy Apply up to the first dialog (never past it): open the parked job, open the dialog, look for the resume upload control, discard. */
const easyApplyReview: LiveCheck = async (c) => {
  const ids = c.ledgerQueueIds.length > 0 ? c.ledgerQueueIds : [];
  const row = (ids.length > 0
    ? c.db.prepare(`SELECT COALESCE(j.apply_url, j.url) AS url FROM outreach_queue q JOIN jobs j ON j.id = q.job_id WHERE q.id IN (${ids.map(() => '?').join(',')}) AND COALESCE(j.apply_url, j.url) LIKE 'https://%linkedin.com/%' ORDER BY q.id DESC LIMIT 1`).get(...ids)
    : c.db.prepare("SELECT COALESCE(j.apply_url, j.url) AS url FROM outreach_queue q JOIN jobs j ON j.id = q.job_id WHERE q.apply_note LIKE 'easy_apply:%' AND COALESCE(j.apply_url, j.url) LIKE 'https://%linkedin.com/%' ORDER BY q.updated_at DESC LIMIT 1").get()
  ) as { url: string } | undefined;
  if (!row) return skip('no parked Easy Apply job to try');
  const opened = rec(await c.g.handlers.linkedin_open({ url: row.url }));
  if (opened.ok === false) return skip(`job page did not open: ${String(opened.code ?? 'unknown')}`);
  const snap1 = await c.g.handlers.linkedin_snapshot({});
  let outcome: CheckResult;
  try {
    const click = await c.g.clickByName('linkedin', snap1, /^easy apply\b/i);
    if (!click.clicked) return skip('no Easy Apply control on the page (closed or changed posting)');
    const snap2 = await c.g.handlers.linkedin_snapshot({});
    if (findRef(snap2, /upload|choose file|resume/i)) outcome = { result: 'pass', evidence: 'Easy Apply dialog opened and the resume upload control is present (stopped before any Next, Review or Submit)' };
    else if (findRef(snap2, /^(dismiss|close|discard)/i)) outcome = { result: 'fail', evidence: 'Easy Apply dialog opened without a resume upload control' };
    else outcome = { result: 'fail', evidence: 'no Easy Apply dialog after the click' };
    // discard the modal: Dismiss, then the Discard confirm when LinkedIn asks
    const after = await c.g.clickByName('linkedin', snap2, /^(dismiss|close)$/i);
    if (after.clicked) {
      const snap3 = await c.g.handlers.linkedin_snapshot({});
      await c.g.clickByName('linkedin', snap3, /^discard$/i);
    }
  } catch (e) {
    if (e instanceof CommitRefused || e instanceof LoadLimit) throw e;
    return skip(`Easy Apply try could not run: ${(e as Error).message.slice(0, 80)}`);
  }
  return outcome;
};

export const LIVE_CHECKS: Record<string, LiveCheck> = {
  'linkedin:discover_search': discoverSearch,
  'linkedin:jd_read': jdRead,
  'linkedin:easy_apply_review': easyApplyReview,
};

// ---- the runner ----

export interface LiveDeps {
  ledgerId: number;
  /** The fixer worktree (cwd of the runner). */
  worktree: string;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Reads the ledger row of the live database: signature and queue evidence. */
  readLedger: (liveDbFile: string, id: number) => { signature: string; queue: number[] } | null;
  liveDbFile: string;
  /** Kill switch (`.jobber/STOP`, JOBBER_KILL) of the LIVE root. */
  killed: () => boolean;
  /** Halt state of a platform in the temp copy. */
  haltedOn: (db: Db, platform: string) => { all: boolean; platform: boolean };
  activeNow: (env: NodeJS.ProcessEnv, at: Date) => boolean;
  /** Builds the handlers over the TEMP database handle. Default: the worktree's own MCP module for the platform. */
  makeHandlers?: (platform: string, db: Db, worktree: string) => Promise<{ handlers: Handlers; shutdown: () => Promise<void> }>;
  checks?: Record<string, LiveCheck>;
  copyDb?: (liveFile: string) => Promise<{ file: string; cleanup: () => void }>;
}

async function defaultMakeHandlers(platform: string, db: Db, worktree: string): Promise<{ handlers: Handlers; shutdown: () => Promise<void> }> {
  if (platform !== 'linkedin') throw new Error(`no handlers for ${platform}`);
  process.env.LINKEDIN_NO_MAIN = '1';
  const mod = await import(pathToFileURL(path.join(worktree, 'src/mcp/linkedin.ts')).href) as {
    buildHandlers: (d: { db: Db }) => Handlers; shutdownHandlers: (h: object) => Promise<void>;
  };
  const handlers = mod.buildHandlers({ db });
  return { handlers, shutdown: () => mod.shutdownHandlers(handlers) };
}

/** Runs the live check of a ledger row and returns its verdict. Never throws; never commits; works on a temp copy only. */
export async function runLiveCheck(d: LiveDeps): Promise<LiveVerdict> {
  const base: LiveVerdict = { ledger_id: d.ledgerId, testability: 'not_testable', ran: false, result: 'skipped', evidence: '' };
  const out = (p: Partial<LiveVerdict>): LiveVerdict => ({ ...base, ...p });
  const led = d.readLedger(d.liveDbFile, d.ledgerId);
  if (!led) return out({ evidence: 'unknown ledger id' });
  const v = classify(led.signature);
  if (!v.heal || v.testability === 'not_testable' || !v.liveCheck || !v.platform) return out({ evidence: 'not testable: tests and the watch window only' });
  const withT = (p: Partial<LiveVerdict>): LiveVerdict => out({ testability: v.testability, ...p });
  if (d.killed()) return withT({ evidence: 'skipped: kill_switch_or_halt' });
  const check = (d.checks ?? LIVE_CHECKS)[`${v.platform}:${v.liveCheck}`];
  if (!check) return withT({ evidence: 'skipped: no live check for this platform yet' });
  const now = (d.now ?? (() => new Date()))();
  let copy: { file: string; cleanup: () => void } | null = null;
  let db: Db | null = null;
  let shutdown: (() => Promise<void>) | null = null;
  try {
    copy = await (d.copyDb ?? copyDbToTemp)(d.liveDbFile);
    assertTempDb(copy.file, d.liveDbFile);
    db = new Database(copy.file);
    const halt = d.haltedOn(db, v.platform);
    const why = refusalReason({ platform: v.platform, db, liveRoot: liveRootOf(d.worktree), env: d.env, now, killed: d.killed() || halt.all, haltedPlatform: halt.platform, activeNow: d.activeNow(d.env, now) });
    if (why) return withT({ evidence: `skipped: ${why}` });
    process.env.JOBAPPLIER_DB = copy.file; // anything the worktree code opens by itself also lands on the copy
    const mk = await (d.makeHandlers ?? defaultMakeHandlers)(v.platform, db, d.worktree);
    shutdown = mk.shutdown;
    const g = guardHandlers(mk.handlers, { maxLoads: 1 });
    const r = await check({ g, db, worktree: d.worktree, ledgerQueueIds: led.queue });
    return withT({ ran: r.result !== 'skipped', result: r.result, evidence: r.evidence.slice(0, 300) });
  } catch (e) {
    if (e instanceof CommitRefused) return withT({ ran: true, result: 'fail', evidence: `commit guard: ${e.message}`.slice(0, 300) });
    return withT({ evidence: `skipped: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)}` });
  } finally {
    try { await shutdown?.(); } catch { /* ignore */ }
    try { db?.close(); } catch { /* ignore */ }
    copy?.cleanup();
  }
}
