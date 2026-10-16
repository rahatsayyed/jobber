// Locked headless web session for company sites and ATS pages: one browser, one serial queue, idle
// auto-close, halt check, navigation guard, per-host gap and per-job budgets. Mirrors
// src/linkedin/runtime.ts. It never types, clicks or submits: those belong to the callers (and are
// dry-run gated there). Failure text is fixed and code-authored, never browser error text.
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { launchRealChrome, HEADLESS_CONTEXT_OPTIONS, type LiBrowser, type LiContext, type LiLauncher, type LiPage } from './launch.js';
import { loadWebConfig, type WebConfig } from './config.js';
import { acquireLock, checkSiteSessionFile, siteSessionPath, DEFAULT_SITE_SESSION_DIR, DEFAULT_WEB_LOCK_PATH, type LockHandle } from './session.js';
import { haltReason } from '../outreach/limits.js';

type Db = BetterSqlite3.Database;

export interface WebRuntimeDeps {
  db: Db;
  launcher?: LiLauncher;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  lockPath?: string;
  sessionDir?: string;
  config?: Partial<WebConfig>;
  /** Test seam for the per-host gap wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the code-drawn jitter, 0..1. */
  random?: () => number;
  idleMs?: number;
}

export interface OpenOptions {
  /** Hosts the job may touch; a host matches when equal or a subdomain. */
  allowedHosts: string[];
  /** Budgets are counted per job id; a new id resets them. */
  jobId: string;
  /** Host whose saved session file (secrets/site-sessions/<host>.json) is loaded; default: the URL host. */
  sessionHost?: string;
}

export type NavResult = { ok: true; url: string } | { ok: false; code: string; reason: string };

export interface WebRuntime {
  open(url: string, opts: OpenOptions): Promise<NavResult>;
  navigate(url: string): Promise<NavResult>;
  page(): LiPage | null;
  context(): LiContext | null;
  close(): Promise<boolean>;
  serial<T>(fn: () => Promise<T>): Promise<T>;
}

/** http(s) only, no embedded credentials, host equal to or a subdomain of an allowed host. */
export function hostAllowed(url: string, allowedHosts: string[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return allowedHosts.some((a) => {
    const x = a.trim().toLowerCase();
    return x !== '' && (h === x || h.endsWith(`.${x}`));
  });
}

const logErr = (where: string, e: unknown) =>
  console.error(`[webcore] ${where}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);

const hostOf = (url: string): string => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

interface Session {
  browser: LiBrowser; context: LiContext; page: LiPage; lock: LockHandle;
  idle: ReturnType<typeof setTimeout> | null;
  allowedHosts: string[];
}
interface Job { id: string; startedAt: number; calls: number }

export function createWebRuntime(deps: WebRuntimeDeps): WebRuntime {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const cfg: WebConfig = { ...loadWebConfig(env), ...(deps.config ?? {}) };
  const idleMs = deps.idleMs ?? cfg.idleMs;
  const lockPath = deps.lockPath ?? DEFAULT_WEB_LOCK_PATH;
  const sessionDir = deps.sessionDir ?? DEFAULT_SITE_SESSION_DIR;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  let session: Session | null = null;
  let job: Job | null = null;
  const lastNav = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const halted = (): string | null => haltReason(deps.db, 'web') ?? haltReason(deps.db, 'apply');
  const fail = (code: string, reason: string): NavResult => ({ ok: false, code, reason });

  function touch(): void {
    if (!session) return;
    if (session.idle) clearTimeout(session.idle);
    session.idle = setTimeout(() => { void serial(() => closeSession()); }, idleMs);
    session.idle.unref?.();
  }

  const onExit = () => { void closeSession(); };
  async function closeSession(): Promise<boolean> {
    const s = session;
    if (!s) return false;
    session = null;
    process.off('beforeExit', onExit);
    if (s.idle) clearTimeout(s.idle);
    await s.browser.close().catch(() => undefined);
    s.lock.release();
    return true;
  }

  /** Budget, host guard and per-host gap for one navigation; null means go ahead. */
  async function gate(url: string, allowedHosts: string[]): Promise<NavResult | null> {
    const h = halted();
    if (h) return fail('halted', h);
    if (!job) return fail('no_job', 'call open first');
    if (job.calls >= cfg.maxCallsPerJob) return fail('budget_calls', 'per-job call budget reached');
    if (now().getTime() - job.startedAt > cfg.maxJobMin * 60_000) return fail('budget_time', 'per-job time budget reached');
    if (!hostAllowed(url, allowedHosts)) return fail('refused', 'host_change');
    const host = hostOf(url);
    const last = lastNav.get(host);
    if (last !== undefined && cfg.minGapSec > 0) {
      const gapMs = cfg.minGapSec * 1000;
      const want = gapMs + Math.floor(random() * 0.25 * gapMs);
      const wait = want - (now().getTime() - last);
      if (wait > 0) await sleep(wait);
    }
    return null;
  }

  async function go(page: LiPage, url: string, allowedHosts: string[]): Promise<NavResult> {
    job!.calls++;
    lastNav.set(hostOf(url), now().getTime());
    try {
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(cfg.settleMs).catch(() => undefined);
    } catch (e) {
      logErr('goto', e);
      return fail('failed', 'navigation failed');
    }
    const finalUrl = page.url();
    if (!hostAllowed(finalUrl, allowedHosts)) {
      await closeSession();
      return fail('refused', 'host_change');
    }
    return { ok: true, url: finalUrl };
  }

  async function open(url: string, opts: OpenOptions): Promise<NavResult> {
    if (!job || job.id !== opts.jobId) job = { id: opts.jobId, startedAt: now().getTime(), calls: 0 };
    const blocked = await gate(url, opts.allowedHosts);
    if (blocked) return blocked;
    await closeSession();
    const sessionFile = siteSessionPath(opts.sessionHost ?? hostOf(url), sessionDir);
    let storageState: string | undefined;
    if (existsSync(sessionFile)) {
      const chk = checkSiteSessionFile(sessionFile);
      if (!chk.ok) return fail('session_invalid', chk.reason ?? 'session invalid');
      storageState = sessionFile;
    }
    const lock = acquireLock(lockPath);
    if (!lock.ok) return fail('session_locked', lock.reason);
    let browser: LiBrowser;
    try {
      browser = await launchRealChrome({ launcher: deps.launcher });
    } catch (e) {
      lock.handle.release();
      logErr('launch', e);
      return fail('chrome_unavailable', 'could not launch Chrome');
    }
    try {
      const context = await browser.newContext({ ...HEADLESS_CONTEXT_OPTIONS, ...(storageState ? { storageState } : {}) });
      const page = await context.newPage();
      session = { browser, context, page, lock: lock.handle, idle: null, allowedHosts: opts.allowedHosts };
      process.once('beforeExit', onExit);
      touch();
      return await go(page, url, opts.allowedHosts);
    } catch (e) {
      if (session) await closeSession();
      else { await browser.close().catch(() => undefined); lock.handle.release(); }
      logErr('open', e);
      return fail('failed', 'open failed');
    }
  }

  async function navigate(url: string): Promise<NavResult> {
    if (!session) return fail('no_session', 'call open first');
    const blocked = await gate(url, session.allowedHosts);
    if (blocked) return blocked;
    touch();
    return go(session.page, url, session.allowedHosts);
  }

  return {
    open: (url, opts) => serial(() => open(url, opts)),
    navigate: (url) => serial(() => navigate(url)),
    page: () => session?.page ?? null,
    context: () => session?.context ?? null,
    close: () => serial(() => closeSession()),
    serial,
  };
}
