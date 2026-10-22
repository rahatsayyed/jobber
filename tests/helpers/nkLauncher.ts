// Fake patchright launcher for the naukri MCP tests: the page answers the browserctl in-page scripts with a
// tree built from invented HTML and lets a test script the old extraction sources (search, inbox, thread).
import { vi } from 'vitest';
import { buildTreeFromHtml } from '../../src/browserctl/snapshot.js';

export const bcCall = (src: string): { mode: string; args: Record<string, number> } | null => {
  const m = /\}\)\("(snapshot|describe|at|focused)", (\{[^)]*\})\)$/.exec(src.trim());
  return m ? { mode: m[1], args: JSON.parse(m[2]) } : null;
};

export interface NkLauncherOpts {
  html?: () => string;
  /** Answers every non-browserctl evaluate (SNAPSHOT_SRC, SEARCH_SRC, INBOX_SRC, THREAD_SRC ...). */
  other?: (src: string) => unknown;
  startUrl?: string;
  onClick?: (sel: string) => void;
  onFill?: (sel: string, text: string) => void;
}

export function makeNkLauncher(o: NkLauncherOpts = {}) {
  const gotos: string[] = [];
  const clicks: string[] = [];
  const typed: string[] = [];
  const evaluated: string[] = [];
  let cur = o.startUrl ?? 'https://www.naukri.com/';
  const html = () => (o.html ? o.html() : '<html><head><title>Naukri</title></head><body><h1>Naukri</h1></body></html>');
  const page: any = {
    url: vi.fn(() => cur),
    goto: vi.fn(async (u: string) => { gotos.push(u); cur = u; }),
    title: vi.fn(async () => 'Naukri'),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    waitForResponse: vi.fn(async () => ({})),
    evaluate: vi.fn(async (src: string) => {
      evaluated.push(src);
      const c = bcCall(src);
      if (c) {
        const tree = buildTreeFromHtml(html(), cur);
        if (c.mode === 'snapshot') return tree;
        if (c.mode === 'describe') return tree.nodes.find((x) => x.n === c.args.n) ?? null;
        return null;
      }
      return o.other ? o.other(src) : null;
    }),
    locator: vi.fn((sel: string) => {
      const loc: any = {
        first: () => loc,
        count: async () => 1,
        click: vi.fn(async () => { clicks.push(sel); o.onClick?.(sel); }),
        fill: vi.fn(async (t: string) => { typed.push(t); o.onFill?.(sel, t); }),
      };
      return loc;
    }),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    screenshot: vi.fn().mockResolvedValue(Buffer.from('bigpng')),
  };
  const helper: any = {
    setContent: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    locator: () => ({ screenshot: vi.fn().mockResolvedValue(Buffer.from('smallpng')) }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const context: any = {
    pages: 0,
    newPage: vi.fn(async () => (context.pages++ === 0 ? page : helper)),
    waitForEvent: vi.fn(async () => { throw new Error('timeout'); }),
  };
  const browser: any = {
    newContext: vi.fn(async () => { context.pages = 0; return context; }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const launch = vi.fn(async () => browser);
  return { launcher: { launch }, launch, browser, context, page, helper, gotos, clicks, typed, evaluated, setUrl: (u: string) => { cur = u; } };
}
