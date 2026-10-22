// browserctl driver: the only module that runs code inside a page. BcPage is a closed interface of
// fixed operations; there is no evaluate, no selector and no storage or cookie access for callers.
// Real implementation wraps the patchright page used across the project (LiPage structural type);
// tests supply a fake BcPage.
import type { LiPage } from '../linkedin/types.js';
import { bcScript, MAX_VALUE, type LiveNode, type RawTree } from './snapshot.js';

export type BcKey = 'Enter' | 'Escape' | 'Tab' | 'ArrowDown' | 'ArrowUp' | 'PageDown' | 'PageUp' | 'Backspace' | 'Space';
export const BC_KEYS: readonly BcKey[] = ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Backspace', 'Space'];

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

type RealPage = LiPage & { mouse?: { click(x: number, y: number): Promise<void> } };

function ordinal(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 99999) throw new Error('browserctl: bad node ordinal');
  return n;
}
function coord(v: number): number {
  if (!Number.isFinite(v) || v < 0 || v > 20000) throw new Error('browserctl: bad coordinate');
  return v;
}

const CLICK_TIMEOUT_MS = 5000;

export function realBcPage(page: RealPage): BcPage {
  const run = async <T>(mode: 'snapshot' | 'describe' | 'at' | 'focused', args: { n?: number; x?: number; y?: number } = {}): Promise<T | null> => {
    try {
      return (await page.evaluate<T | null>(bcScript(mode, args))) ?? null;
    } catch {
      return null;
    }
  };
  const sel = (n: number) => `[data-bc="${ordinal(n)}"]`;
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
    async clickNode(n) { await page.locator(sel(n)).first().click({ timeout: CLICK_TIMEOUT_MS }); },
    async clickPoint(x, y) {
      if (!page.mouse) throw new Error('browserctl: page has no mouse');
      await page.mouse.click(coord(x), coord(y));
    },
    async fillNode(n, text) {
      if (typeof text !== 'string' || text.length > MAX_VALUE) throw new Error('browserctl: bad text');
      await page.locator(sel(n)).first().fill(text, { timeout: CLICK_TIMEOUT_MS });
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
