// Fake BcPage for browserctl tests: serves a tree built from an invented HTML fixture and records actions.
import type { BcKey, BcPage } from '../../src/browserctl/driver.js';
import { buildTreeFromHtml, type LiveNode, type RawTree } from '../../src/browserctl/snapshot.js';

export interface FakeBc extends BcPage {
  log: string[];
  /** Replace the live DOM (simulates a re-render between snapshot and action). */
  setHtml(html: string): void;
  /** Points to nodes for describeAt. */
  points: Map<string, number>;
  /** Ordinal reported by focused() (null: unknown). */
  focusedN: number | null;
  /** When false, waitForResponse rejects (no network confirmation). */
  responseOk: boolean;
  /** Hook run after a goto, click, key press or fill (simulate the page reacting). */
  onAct?: (what: string) => void;
  currentUrl: string;
}

export function fakeBcPage(html: string, url = 'https://example.test/page'): FakeBc {
  let tree: RawTree = buildTreeFromHtml(html, url);
  let cur = url;
  const log: string[] = [];
  const points = new Map<string, number>();
  const find = (n: number): LiveNode | null => tree.nodes.find((x) => x.n === n) ?? null;
  const self: FakeBc = {
    log,
    points,
    focusedN: null,
    responseOk: true,
    get currentUrl() { return cur; },
    set currentUrl(u: string) { cur = u; },
    setHtml(h: string) { tree = buildTreeFromHtml(h, cur); },
    url: () => cur,
    title: async () => tree.title,
    goto: async (u) => { log.push(`goto ${u}`); cur = u; self.onAct?.(`goto ${u}`); },
    snapshot: async () => { log.push('snapshot'); return { ...tree, url: cur }; },
    describe: async (n) => find(n),
    describeAt: async (x, y) => { const n = points.get(`${x},${y}`); return n === undefined ? null : find(n); },
    focused: async () => (self.focusedN === null ? null : find(self.focusedN)),
    clickNode: async (n) => { log.push(`click ${n}`); self.onAct?.(`click ${n}`); },
    clickPoint: async (x, y) => { log.push(`clickPoint ${x},${y}`); self.onAct?.(`clickPoint ${x},${y}`); },
    fillNode: async (n, t) => { log.push(`fill ${n} ${t}`); self.onAct?.(`fill ${n} ${t}`); },
    press: async (k: BcKey) => { log.push(`press ${k}`); self.onAct?.(`press ${k}`); },
    scroll: async (d) => { log.push(`scroll ${d}`); },
    screenshot: async () => { log.push('screenshot'); return Buffer.from('png'); },
    waitForResponse: async () => { if (!self.responseOk) throw new Error('timeout'); return {}; },
    waitMs: async () => undefined,
  };
  return self;
}
