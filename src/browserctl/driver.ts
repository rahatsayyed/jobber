// browserctl driver: the only module that runs code inside a page. BcPage is a closed interface of
// fixed operations; there is no evaluate, no selector and no storage or cookie access for callers.
// Real implementation wraps the patchright page used across the project (LiPage structural type);
// tests supply a fake BcPage.
import type { LiLocator, LiPage } from '../linkedin/types.js';
import type { PageDiag } from './diag.js';
import { withLocatorDialogs, type LdPage } from './locatorDialogs.js';
import { bcScript, MAX_VALUE, type LiveNode, type RawTree } from './snapshot.js';

export type BcKey = 'Enter' | 'Escape' | 'Tab' | 'ArrowDown' | 'ArrowUp' | 'PageDown' | 'PageUp' | 'Backspace' | 'Space';
export const BC_KEYS: readonly BcKey[] = ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Backspace', 'Space'];

// What a commit click set off in the browser context: new pages and apply-ish network responses (paths only).
export interface BcWatch {
  // Pages the context opened since the watch started (url may still be about:blank while loading).
  popups(): { url: string }[];
  // Non-GET responses seen since the watch started whose path contains 'apply': path (no query) and status.
  responses(): { path: string; status: number }[];
  // Make the n-th popup the page every later BcPage call reads (a naukri.com chatbot or questionnaire).
  adopt(index: number): Promise<boolean>;
  stop(): void;
}

export interface BcPage {
  url(): string;
  title(): Promise<string>;
  /** Navigate. Used by open() only, after the platform URL allowlist. */
  goto(url: string): Promise<void>;
  /** Optional: wait for the load event (bounded, never throws). Absent in fakes. */
  waitForLoad?(timeoutMs: number): Promise<void>;
  /** Stamp ordinals and read the visible tree. */
  snapshot(): Promise<RawTree>;
  /** Re-read one stamped element live; null when it is gone or hidden. */
  describe(n: number): Promise<LiveNode | null>;
  /** Element (or its nearest actionable ancestor) under a viewport point; null when nothing usable. */
  describeAt(x: number, y: number): Promise<LiveNode | null>;
  /** The focused element, or null. */
  focused(): Promise<LiveNode | null>;
  // Optional: structure-only page facts for failure diagnostics (counts and short control names). Absent in fakes.
  diag?(): Promise<PageDiag | null>;
  // Optional: while on, a snapshot reads once and never waits for a filling dialog on its own (the caller polls). Absent in fakes.
  setOpenWatch?(on: boolean): void;
  // Optional: robust click of a stamped element: scroll into view, wait until enabled and stable, then a real
  // pointer click (move, down, up) at the box centre; one fallback through the locator click. Absent in fakes.
  robustClick?(n: number): Promise<void>;
  // Optional: start watching the context for popups and apply responses (call right before the click).
  watch?(): BcWatch;
  clickNode(n: number): Promise<void>;
  clickPoint(x: number, y: number): Promise<void>;
  /** Replace the value of a stamped text field with exactly this text. */
  fillNode(n: number, text: string): Promise<void>;
  press(key: BcKey): Promise<void>;
  scroll(direction: 'down' | 'up'): Promise<void>;
  screenshot(): Promise<Buffer>;
  waitForResponse(pred: (r: unknown) => boolean, timeoutMs: number): Promise<unknown>;
  waitMs(ms: number): Promise<void>;
}

type RealPage = LiPage & {
  mouse?: { click(x: number, y: number): Promise<void>; move?(x: number, y: number): Promise<void>; down?(): Promise<void>; up?(): Promise<void> };
  context?: () => { on(ev: string, fn: (x: any) => void): void; off?(ev: string, fn: (x: any) => void): void; removeListener?(ev: string, fn: (x: any) => void): void };
  bringToFront?: () => Promise<void>;
};

function ordinal(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 99999) throw new Error('browserctl: bad node ordinal');
  return n;
}
function coord(v: number): number {
  if (!Number.isFinite(v) || v < 0 || v > 20000) throw new Error('browserctl: bad coordinate');
  return v;
}

const CLICK_TIMEOUT_MS = 5000;

/**
 * opts.locatorDialogs (LinkedIn only): also read dialogs through Patchright locators, for modals in a closed
 * shadow root that the in-page walker cannot see (see locatorDialogs.ts).
 */
export function realBcPage(basePage: RealPage, opts: { locatorDialogs?: boolean } = {}): BcPage {
  const inner = realBcPageInner(basePage);
  return opts.locatorDialogs ? withLocatorDialogs(inner, () => basePage as unknown as LdPage) : inner;
}

function realBcPageInner(basePage: RealPage): BcPage {
  // Mutable: a followed popup replaces the page every call reads.
  let page: RealPage = basePage;
  const run = async <T>(mode: 'snapshot' | 'describe' | 'at' | 'focused' | 'diag', args: { n?: number; x?: number; y?: number } = {}): Promise<T | null> => {
    try {
      return (await page.evaluate<T | null>(bcScript(mode, args))) ?? null;
    } catch {
      return null;
    }
  };
  const sel = (n: number) => `[data-bc="${ordinal(n)}"]`;
  // Playwright CSS selectors pierce OPEN shadow roots by themselves; a same-origin iframe is a separate
  // frame, so when the main frame has no match the stamped element is looked up in the other frames.
  const locate = async (n: number): Promise<LiLocator> => {
    const main = page.locator(sel(n));
    try {
      if ((await main.count()) > 0) return main.first();
      const frames = (page as unknown as { frames?: () => { locator(s: string): LiLocator }[] }).frames?.() ?? [];
      for (const f of frames) {
        const l = f.locator(sel(n));
        if ((await l.count()) > 0) return l.first();
      }
    } catch { /* fall through to the main-frame locator, which then fails the way it always did */ }
    return main.first();
  };
  return {
    url: () => page.url(),
    title: () => page.title(),
    async goto(url) { await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }); },
    async waitForLoad(timeoutMs) {
      try { await (page as unknown as { waitForLoadState?: (s: string, o: { timeout: number }) => Promise<void> }).waitForLoadState?.('load', { timeout: timeoutMs }); } catch { /* bounded, best effort */ }
    },
    async snapshot() {
      const t = await run<RawTree>('snapshot');
      if (!t || !Array.isArray(t.nodes)) return { url: page.url(), title: '', nodes: [] };
      return t;
    },
    describe: (n) => run<LiveNode>('describe', { n: ordinal(n) }),
    describeAt: (x, y) => run<LiveNode>('at', { x: coord(x), y: coord(y) }),
    focused: () => run<LiveNode>('focused'),
    diag: () => run<PageDiag>('diag'),
    async clickNode(n) { await (await locate(n)).click({ timeout: CLICK_TIMEOUT_MS }); },
    async robustClick(n) {
      const loc = await locate(n);
      const ext = loc as unknown as {
        scrollIntoViewIfNeeded?: (o?: { timeout?: number }) => Promise<void>;
        boundingBox?: (o?: { timeout?: number }) => Promise<{ x: number; y: number; width: number; height: number } | null>;
        isEnabled?: (o?: { timeout?: number }) => Promise<boolean>;
      };
      try { await ext.scrollIntoViewIfNeeded?.({ timeout: CLICK_TIMEOUT_MS }); } catch { /* the fallback click scrolls too */ }
      // Wait (bounded) until the control is enabled and its box stopped moving between two reads.
      let box: { x: number; y: number; width: number; height: number } | null = null;
      for (let k = 0; k < 15; k++) {
        try {
          const b1 = (await ext.boundingBox?.({ timeout: 1000 })) ?? null;
          await page.waitForTimeout(120);
          const b2 = (await ext.boundingBox?.({ timeout: 1000 })) ?? null;
          const enabled = (await ext.isEnabled?.({ timeout: 1000 })) ?? true;
          if (b1 && b2 && enabled && Math.abs(b1.x - b2.x) < 1 && Math.abs(b1.y - b2.y) < 1 && b2.width > 0 && b2.height > 0) { box = b2; break; }
        } catch { /* keep polling */ }
      }
      const m = page.mouse;
      if (box && m?.move && m.down && m.up) {
        const x = coord(Math.round(box.x + box.width / 2));
        const y = coord(Math.round(box.y + box.height / 2));
        // An element on top (sticky header, overlay) would swallow the pointer: then let the locator click decide.
        const top = await run<LiveNode>('at', { x, y });
        if (top && top.n === n) {
          try {
            await m.move(x, y);
            await page.waitForTimeout(60);
            await m.down();
            await page.waitForTimeout(60);
            await m.up();
            return;
          } catch { /* one retry through the locator click, actionability checks on */ }
        }
      }
      await loc.click({ timeout: CLICK_TIMEOUT_MS });
    },
    watch() {
      const popups: { page: RealPage }[] = [];
      const responses: { path: string; status: number }[] = [];
      const ctx = page.context?.();
      const onPage = (p: RealPage): void => { if (p !== page) popups.push({ page: p }); };
      const onResp = (r: any): void => {
        try {
          if (r.request().method() === 'GET') return;
          const path = new URL(r.url()).pathname.slice(0, 120);
          if (/apply/i.test(path)) responses.push({ path, status: Number(r.status()) });
        } catch { /* ignore a malformed response */ }
      };
      ctx?.on('page', onPage);
      ctx?.on('response', onResp);
      return {
        popups: () => popups.map((x) => ({ url: (() => { try { return x.page.url(); } catch { return ''; } })() })),
        responses: () => responses.slice(),
        async adopt(index) {
          const x = popups[index];
          if (!x) return false;
          try { await x.page.bringToFront?.(); } catch { /* best effort */ }
          page = x.page;
          return true;
        },
        stop() {
          const off = ctx?.off ?? ctx?.removeListener;
          try { off?.call(ctx, 'page', onPage); off?.call(ctx, 'response', onResp); } catch { /* ignore */ }
        },
      };
    },
    async clickPoint(x, y) {
      if (!page.mouse) throw new Error('browserctl: page has no mouse');
      await page.mouse.click(coord(x), coord(y));
    },
    async fillNode(n, text) {
      if (typeof text !== 'string' || text.length > MAX_VALUE) throw new Error('browserctl: bad text');
      await (await locate(n)).fill(text, { timeout: CLICK_TIMEOUT_MS });
    },
    async press(key) {
      if (!BC_KEYS.includes(key)) throw new Error('browserctl: key not allowed');
      await page.keyboard.press(key === 'Space' ? ' ' : key);
    },
    async scroll(direction) { await page.keyboard.press(direction === 'down' ? 'PageDown' : 'PageUp'); },
    screenshot: () => page.screenshot({ type: 'png' }),
    waitForResponse: (pred, timeoutMs) => page.waitForResponse(pred as (r: any) => boolean, { timeout: timeoutMs }),
    waitMs: (ms) => page.waitForTimeout(ms),
  };
}
