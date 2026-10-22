// Fake BcPage for browserctl tests: serves a tree built from an invented HTML fixture and records actions.
import type { BcKey, BcPage } from '../../src/browserctl/driver.js';
import { buildTreeFromHtml, type LiveNode, type RawTree } from '../../src/browserctl/snapshot.js';

export interface FakeBc extends BcPage {
  log: string[];
  /** Replace the live DOM (simulates a re-render between snapshot and action). */
  setHtml(html: string): void;
  /** Points to nodes for describeAt. */
  points: Map<string, number>;
}

export function fakeBcPage(html: string, url = 'https://example.test/page'): FakeBc {
  let tree: RawTree = buildTreeFromHtml(html, url);
  const log: string[] = [];
  const points = new Map<string, number>();
  const find = (n: number): LiveNode | null => tree.nodes.find((x) => x.n === n) ?? null;
  return {
    log,
    points,
    setHtml(h: string) { tree = buildTreeFromHtml(h, url); },
    url: () => url,
    title: async () => tree.title,
    snapshot: async () => { log.push('snapshot'); return tree; },
    describe: async (n) => find(n),
    describeAt: async (x, y) => { const n = points.get(`${x},${y}`); return n === undefined ? null : find(n); },
    focused: async () => null,
    clickNode: async (n) => { log.push(`click ${n}`); },
    clickPoint: async (x, y) => { log.push(`clickPoint ${x},${y}`); },
    fillNode: async (n, t) => { log.push(`fill ${n} ${t}`); },
    press: async (k: BcKey) => { log.push(`press ${k}`); },
    scroll: async (d) => { log.push(`scroll ${d}`); },
    screenshot: async () => Buffer.from('png'),
    waitForResponse: async () => ({}),
    waitMs: async () => undefined,
  };
}
