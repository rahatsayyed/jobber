// Locked headless LinkedIn session: one browser, one serial queue, idle auto-close. It owns launch,
// lock and the session page; the browserctl engine (src/browserctl) acts on the same page through
// page(). Only open, snapshot and the data tools' reads live here, no action selectors.
import type BetterSqlite3 from 'better-sqlite3';
import { launchRealChrome, LINKEDIN_CONTEXT_OPTIONS } from './browser.js';
import { acquireLock, checkSessionFile, saveStateAtomic, DEFAULT_LOCK_PATH, DEFAULT_SESSION_PATH, type LockHandle } from './session.js';
import { SNAPSHOT_SRC } from './snapshot.js';
import { detectBlock, type BlockKind } from './state.js';
import { isBlockedPath, isLinkedInUrl } from './urls.js';
import { haltPlatform, haltReason } from '../outreach/limits.js';
import type { LayoutObserver } from '../layout/runtime.js';
import type { LiBrowser, LiContext, LiLauncher, LiPage, RawSnapshot } from './types.js';

type Db = BetterSqlite3.Database;

export interface RuntimeDeps {
  db: Db; launcher?: LiLauncher; now?: () => Date; env?: NodeJS.ProcessEnv;
  sessionPath?: string; lockPath?: string; settleMs?: number; idleMs?: number;
  /** Advisory layout observer: sees each fresh snapshot of open() and snapshot(); never fails a tool. */
  layout?: LayoutObserver;
  /** True while a tool call is in flight: the idle timer then re-arms instead of closing the session. */
  isBusy?: () => boolean;
}
export interface ActionResult { ok: boolean; code: string; reason?: string; state?: string }
export interface Runtime {
  open(url: string): Promise<{ ok: true; snapshot: RawSnapshot } | { ok: false; code: string; reason: string }>;
  snapshot(): Promise<RawSnapshot | null>;
  page(): LiPage | null;
  context(): LiContext | null;
  /** Keep the idle timer alive (the engine calls it on every action). */
  touch(): void;
  close(): Promise<boolean>;
  /** Close without saving the session file (a flagged session must never overwrite the good one). */
  discard(): Promise<boolean>;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  afterNavigation(snap: RawSnapshot): BlockKind | null;
  /** The layout observer, when one is attached (optional so test doubles need not provide it). */
  layout?: LayoutObserver;
}

/** Fixed, code-authored failure text: Playwright error text is never put in a result (injection channel). */
const logErr = (where: string, e: unknown) =>
  console.error(`[linkedin] ${where}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** `open` reads again (after another settle) while the page text is shorter than this, at most this many times. */
const OPEN_CONTENT_MIN_CHARS = 100;
const OPEN_CONTENT_RETRIES = 3;

interface Session { browser: LiBrowser; context: LiContext; page: LiPage; lock: LockHandle; idle: ReturnType<typeof setTimeout> | null }

export function createRuntime(deps: RuntimeDeps): Runtime {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const sessionPath = deps.sessionPath ?? DEFAULT_SESSION_PATH;
  const lockPath = deps.lockPath ?? DEFAULT_LOCK_PATH;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const settleMs = deps.settleMs ?? 1500;
  let session: Session | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const settle = (p: LiPage) => p.waitForTimeout(settleMs).catch(() => undefined);
  const halted = () => haltReason(deps.db, 'linkedin');
  const pathOnly = (url: string) => { try { return new URL(url).pathname; } catch { return 'unknown'; } };

  function touch(): void {
    if (!session) return;
    if (session.idle) clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      // Never close the session under a tool call that is still running (an arm plus click pair).
      if (deps.isBusy?.()) { touch(); return; }
      void serial(() => closeSession());
    }, idleMs);
    session.idle.unref?.();
  }

  async function closeSession(save = true): Promise<boolean> {
    const s = session;
    if (!s) return false;
    session = null;
    process.off('beforeExit', onExit);
    if (s.idle) clearTimeout(s.idle);
    if (save) {
      try {
        const state = await s.context.storageState();
        try { saveStateAtomic(sessionPath, state); } catch { /* logged out or unwritable: leave the file alone */ }
      } catch { /* ignore */ }
    }
    await s.browser.close().catch(() => undefined);
    s.lock.release();
    return true;
  }
  let pendingClose: Promise<unknown> = Promise.resolve();
  const onExit = () => { void closeSession(); };

  /** Advisory: an observer failure goes to stderr and never reaches the caller. */
  const observeLayout = (snap: RawSnapshot, block: BlockKind | null): void => {
    try { deps.layout?.observe(snap, block); } catch (e) { logErr('layout', e); }
  };

  const rawSnapshot = async (): Promise<RawSnapshot | null> => {
    if (!session) return null;
    try { return (await session.page.evaluate<RawSnapshot>(SNAPSHOT_SRC)) ?? null; } catch { return null; }
  };

  function afterNavigation(snap: RawSnapshot): BlockKind | null {
    const kind = detectBlock(snap);
    if (kind) {
      haltPlatform(deps.db, 'linkedin', `${kind}: ${pathOnly(snap.url)}`, now());
      // A flagged session must never overwrite the good session file: close without saving.
      pendingClose = closeSession(false);
    }
    return kind;
  }


  // One retry for a transient launch or navigation failure (a wake saw two `open failed` in a row that a later open did not).
  async function open(url: string): ReturnType<Runtime['open']> {
    const first = await openOnce(url);
    if (first.ok || first.code !== 'failed' || first.reason !== 'open failed') return first;
    await new Promise((r) => setTimeout(r, 1500));
    return openOnce(url);
  }

  async function openOnce(url: string): ReturnType<Runtime['open']> {
    if (!isLinkedInUrl(url)) return { ok: false, code: 'not_linkedin', reason: 'only https linkedin.com URLs may be opened' };
    const b = isBlockedPath(url);
    if (b.blocked) return { ok: false, code: 'blocked_path', reason: b.why ?? 'path is blocked' };
    const h = halted();
    if (h) return { ok: false, code: 'halted', reason: h };
    await closeSession();
    const chk = checkSessionFile(sessionPath, { now: now() });
    if (!chk.ok) return { ok: false, code: 'session_invalid', reason: chk.reason ?? 'session invalid' };
    const lock = acquireLock(lockPath);
    if (!lock.ok) return { ok: false, code: 'session_locked', reason: lock.reason };
    let browser: LiBrowser | null = null;
    try {
      browser = await launchRealChrome({ launcher: deps.launcher });
    } catch (e) {
      lock.handle.release();
      logErr('launch', e);
      return { ok: false, code: 'chrome_unavailable', reason: 'could not launch Chrome' };
    }
    try {
      const context = await browser.newContext({ ...LINKEDIN_CONTEXT_OPTIONS, storageState: sessionPath });
      const page = await context.newPage();
      session = { browser, context, page, lock: lock.handle, idle: null };
      process.once('beforeExit', onExit);
      touch();
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await settle(page);
      let snap = await rawSnapshot();
      // A single page app (the messaging page) can still be empty after the first settle and then redirect and render: read again a few times.
      for (let i = 0; i < OPEN_CONTENT_RETRIES && snap && snap.bodyText.length < OPEN_CONTENT_MIN_CHARS && !snap.hasPasswordInput; i++) {
        await settle(page);
        snap = await rawSnapshot();
      }
      if (!snap) { await closeSession(); return { ok: false, code: 'failed', reason: 'no snapshot' }; }
      const blk = afterNavigation(snap);
      observeLayout(snap, blk);
      if (blk) { await pendingClose; return { ok: false, code: 'halted', reason: halted() ?? 'block page' }; }
      if (!isLinkedInUrl(page.url()) || isBlockedPath(page.url()).blocked) {
        await closeSession(false);
        return { ok: false, code: 'blocked_path', reason: 'page redirected to a blocked or off-site URL' };
      }
      return { ok: true, snapshot: snap };
    } catch (e) {
      if (session) await closeSession();
      else { await browser.close().catch(() => undefined); lock.handle.release(); }
      logErr('open', e);
      return { ok: false, code: 'failed', reason: 'open failed' };
    }
  }

  return {
    open: (url) => serial(() => open(url)),
    snapshot: async () => (session && !halted()
      ? serial(async () => {
        touch();
        const snap = await rawSnapshot();
        if (snap) observeLayout(snap, detectBlock(snap));
        return snap;
      })
      : null),
    page: () => session?.page ?? null,
    context: () => session?.context ?? null,
    touch,
    close: () => serial(() => closeSession()),
    discard: () => serial(() => closeSession(false)),
    serial,
    afterNavigation,
    layout: deps.layout,
  };
}
