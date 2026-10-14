// Locked headless LinkedIn session: one browser, one serial queue, idle auto-close. Free-form
// click/type refuse every irreversible control; sending lives only in the typed tools.
import type BetterSqlite3 from 'better-sqlite3';
import { launchRealChrome, LINKEDIN_CONTEXT_OPTIONS } from './browser.js';
import { acquireLock, checkSessionFile, saveStateAtomic, DEFAULT_LOCK_PATH, DEFAULT_SESSION_PATH, type LockHandle } from './session.js';
import { SELECTORS } from './selectors.js';
import { SNAPSHOT_SRC } from './snapshot.js';
import { detectBlock, formatState, type BlockKind } from './state.js';
import { isBlockedPath, isLinkedInUrl } from './urls.js';
import { haltPlatform, haltReason } from '../outreach/limits.js';
import type { LiBrowser, LiContext, LiLauncher, LiPage, RawSnapshot } from './types.js';

type Db = BetterSqlite3.Database;

export interface RuntimeDeps {
  db: Db; launcher?: LiLauncher; now?: () => Date; env?: NodeJS.ProcessEnv;
  sessionPath?: string; lockPath?: string; settleMs?: number; idleMs?: number;
}
export interface ActionResult { ok: boolean; code: string; reason?: string; state?: string }
export interface Runtime {
  open(url: string): Promise<{ ok: true; snapshot: RawSnapshot } | { ok: false; code: string; reason: string }>;
  snapshot(): Promise<RawSnapshot | null>;
  page(): LiPage | null;
  context(): LiContext | null;
  click(text: string): Promise<ActionResult>;
  type(text: string, opts?: { submit?: boolean }): Promise<ActionResult>;
  scroll(dir: 'down' | 'up'): Promise<void>;
  screenshot(): Promise<{ ok: true; base64: string } | { ok: false; reason: string }>;
  close(): Promise<boolean>;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  afterNavigation(snap: RawSnapshot): BlockKind | null;
}

export const CLICKABLE_SELECTOR = 'a, button, [role=button], [role=menuitem], [role=tab]';
export const SEARCH_INPUT_SELECTOR = 'input[type=search], input[placeholder*="Search" i]';
export const MAX_TYPE_CHARS = 200;
export const TYPED_TOOL_ONLY_REASON = 'use linkedin_connect_send / linkedin_send_message / linkedin_accept_invite';

const REFUSED_WORDS = [
  'send', 'send now', 'send invitation', 'connect', 'invite', 'message', 'accept', 'ignore', 'withdraw',
  'remove connection', 'remove', 'post', 'follow', 'unfollow', 'block', 'report', 'sign out', 'delete',
  'apply', 'easy apply', 'submit',
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REFUSED_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${REFUSED_WORDS.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const INVITE_ARIA_RE = /^Invite .* to connect$/i;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** True when a control's visible text or aria-label names an irreversible action. */
export function isRefusedControl(text: string, aria: string): boolean {
  return REFUSED_RE.test(text) || REFUSED_RE.test(aria) || INVITE_ARIA_RE.test(aria.trim()) || INVITE_ARIA_RE.test(text.trim());
}

interface Candidate { i: number; text: string; aria: string }
type Pick = { kind: 'one'; c: Candidate } | { kind: 'ambiguous' } | { kind: 'none' };

export function pickCandidate(cands: Candidate[], query: string): Pick {
  const q = norm(query);
  if (!q) return { kind: 'none' };
  const label = (c: Candidate) => norm(c.text || c.aria);
  const exact = cands.filter((c) => label(c) === q || norm(c.aria) === q);
  if (exact.length === 1) return { kind: 'one', c: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous' };
  const part = cands.filter((c) => label(c).includes(q) || norm(c.aria).includes(q));
  if (part.length === 1) return { kind: 'one', c: part[0] };
  if (part.length > 1) return { kind: 'ambiguous' };
  return { kind: 'none' };
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;

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
    session.idle = setTimeout(() => { void closeSession(); }, idleMs);
    session.idle.unref?.();
  }

  async function closeSession(): Promise<boolean> {
    const s = session;
    if (!s) return false;
    session = null;
    process.off('beforeExit', onExit);
    if (s.idle) clearTimeout(s.idle);
    try {
      const state = await s.context.storageState();
      try { saveStateAtomic(sessionPath, state); } catch { /* logged out or unwritable: leave the file alone */ }
    } catch { /* ignore */ }
    await s.browser.close().catch(() => undefined);
    s.lock.release();
    return true;
  }
  const onExit = () => { void closeSession(); };

  const rawSnapshot = async (): Promise<RawSnapshot | null> => {
    if (!session) return null;
    try { return (await session.page.evaluate<RawSnapshot>(SNAPSHOT_SRC)) ?? null; } catch { return null; }
  };

  function afterNavigation(snap: RawSnapshot): BlockKind | null {
    const kind = detectBlock(snap);
    if (kind) haltPlatform(deps.db, 'linkedin', `${kind}: ${pathOnly(snap.url)}`, now());
    return kind;
  }

  const stateText = (snap: RawSnapshot): string =>
    formatState(snap, { halted: halted(), dryRun: env.LINKEDIN_DRY_RUN !== 'false' }).text;

  /** Re-snapshot after an action; a block halts and is reported as `halted`. */
  async function finish(code: string, extra?: { reason?: string }): Promise<ActionResult> {
    const snap = await rawSnapshot();
    if (snap && afterNavigation(snap)) return { ok: false, code: 'halted', reason: halted() ?? 'block page' };
    return { ok: true, code, ...(extra?.reason ? { reason: extra.reason } : {}), ...(snap ? { state: stateText(snap) } : {}) };
  }

  const haltedResult = (): ActionResult => ({ ok: false, code: 'halted', reason: halted() ?? 'halted' });

  async function open(url: string): ReturnType<Runtime['open']> {
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
      return { ok: false, code: 'chrome_unavailable', reason: (e as Error).message.slice(0, 160) };
    }
    try {
      const context = await browser.newContext({ ...LINKEDIN_CONTEXT_OPTIONS, storageState: sessionPath });
      const page = await context.newPage();
      session = { browser, context, page, lock: lock.handle, idle: null };
      process.once('beforeExit', onExit);
      touch();
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await settle(page);
      const snap = await rawSnapshot();
      if (!snap) { await closeSession(); return { ok: false, code: 'failed', reason: 'no snapshot' }; }
      if (afterNavigation(snap)) return { ok: false, code: 'halted', reason: halted() ?? 'block page' };
      return { ok: true, snapshot: snap };
    } catch (e) {
      if (session) await closeSession();
      else { await browser.close().catch(() => undefined); lock.handle.release(); }
      return { ok: false, code: 'failed', reason: `open failed: ${((e as Error).message ?? '').slice(0, 120)}` };
    }
  }

  async function click(text: string): Promise<ActionResult> {
    if (!session) return { ok: false, code: 'no_session', reason: 'call linkedin_open first' };
    if (halted()) return haltedResult();
    touch();
    const typedOnly: ActionResult = { ok: false, code: 'typed_tool_only', reason: TYPED_TOOL_ONLY_REASON };
    if (isRefusedControl(text, '')) return typedOnly;
    const { page, context } = session;
    const raw = await page.locator(CLICKABLE_SELECTOR).evaluateAll((els) =>
      els.map((el, i) => ({
        i,
        text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        aria: String((el.getAttribute && el.getAttribute('aria-label')) || '').trim().slice(0, 160),
        visible: !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)),
      })),
    );
    const cands: Candidate[] = (raw as Array<Candidate & { visible: boolean }>).filter((c) => c.visible && (c.text || c.aria));
    const pick = pickCandidate(cands, text);
    if (pick.kind === 'none') return { ok: false, code: 'no_match', reason: `no visible control matches "${text.slice(0, 40)}"` };
    if (pick.kind === 'ambiguous') return { ok: false, code: 'ambiguous', reason: `"${text.slice(0, 40)}" matches several controls; nothing clicked` };
    const c = pick.c;
    if (isRefusedControl(c.text, c.aria)) return typedOnly;
    const popupP = context.waitForEvent('page', { timeout: 1200 }).catch(() => null);
    try {
      await page.locator(CLICKABLE_SELECTOR).nth(c.i).click({ timeout: 8000 });
    } catch (e) {
      return { ok: false, code: 'failed', reason: `click failed: ${((e as Error).message ?? '').slice(0, 100)}` };
    }
    const popup = (await popupP) as { close?: () => Promise<void> } | null;
    if (popup) await popup.close?.().catch(() => undefined);
    await settle(page);
    if (!isLinkedInUrl(page.url())) {
      await page.goBack({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await settle(page);
      const r = await finish('left_linkedin_host');
      return { ...r, ok: false, code: r.code === 'halted' ? 'halted' : 'left_linkedin_host', reason: r.reason ?? 'navigated off LinkedIn, went back' };
    }
    return finish('clicked');
  }

  async function type(text: string, opts: { submit?: boolean } = {}): Promise<ActionResult> {
    if (!session) return { ok: false, code: 'no_session', reason: 'call linkedin_open first' };
    if (halted()) return haltedResult();
    touch();
    const refuse: ActionResult = { ok: false, code: 'typed_tool_only', reason: TYPED_TOOL_ONLY_REASON };
    if (text.length > MAX_TYPE_CHARS) return { ok: false, code: 'too_long', reason: `max ${MAX_TYPE_CHARS} characters` };
    const { page } = session;
    // Any visible compose box, note field or editable inside a dialog/overlay refuses typing (fail closed).
    const dialogs = SELECTORS.noteDialogContainer.split(',').map((s) => s.trim());
    const forbidden = [
      SELECTORS.messageComposeTextarea,
      SELECTORS.noteTextarea,
      ...dialogs.flatMap((d) => [`${d} textarea`, `${d} [contenteditable="true"]`, `${d} [contenteditable]`]),
    ];
    for (const sel of forbidden) {
      if ((await page.locator(sel).count().catch(() => 0)) > 0) return refuse;
    }
    const search = page.locator(SEARCH_INPUT_SELECTOR);
    if ((await search.count().catch(() => 0)) === 0) return { ok: false, code: 'no_match', reason: 'no search box on this page' };
    try {
      await search.first().fill(text, { timeout: 8000 });
      if (opts.submit) await page.keyboard.press('Enter');
    } catch (e) {
      return { ok: false, code: 'failed', reason: `type failed: ${((e as Error).message ?? '').slice(0, 100)}` };
    }
    await settle(page);
    return finish('typed');
  }

  async function scroll(dir: 'down' | 'up'): Promise<void> {
    if (!session || halted()) return;
    touch();
    await session.page.keyboard.press(dir === 'down' ? 'PageDown' : 'PageUp');
    await settle(session.page);
    const snap = await rawSnapshot();
    if (snap) afterNavigation(snap);
  }

  return {
    open: (url) => serial(() => open(url)),
    snapshot: async () => (session && !halted() ? serial(async () => { touch(); return rawSnapshot(); }) : null),
    page: () => session?.page ?? null,
    context: () => session?.context ?? null,
    click: (text) => serial(() => click(text)),
    type: (text, opts) => serial(() => type(text, opts)),
    scroll: (dir) => serial(() => scroll(dir)),
    screenshot: () =>
      serial(async () => {
        if (!session) return { ok: false as const, reason: 'no open session' };
        if (halted()) return { ok: false as const, reason: 'halted' };
        touch();
        try {
          return { ok: true as const, base64: (await session.page.screenshot({ type: 'png' })).toString('base64') };
        } catch (e) {
          return { ok: false as const, reason: ((e as Error).message ?? '').slice(0, 100) };
        }
      }),
    close: () => serial(() => closeSession()),
    serial,
    afterNavigation,
  };
}
