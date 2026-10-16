// Hermetic fake browser for the scout tests: pages come from invented HTML (fixture file names or inline
// HTML), parsed by the dependency-free parser. evaluate() recognises the three scout page scripts by identity.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHtml, textOf, visibleText, type HtmlNode } from '../../src/linkedin/htmlVisible.js';
import { ANCHORS_SCRIPT, FIXTURE_HTML_SCRIPT, type RawAnchorPage } from '../../src/scout/page.js';
import { FORM_SNAPSHOT_SCRIPT } from '../../src/webcore/formModel.js';
import { snapshotFromHtml } from './fixtureSite.js';
import type { LiBrowser, LiContext, LiLauncher, LiLocator, LiPage } from '../../src/linkedin/types.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'web');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export const htmlOf = (nameOrHtml: string): string => (nameOrHtml.trim().startsWith('<') ? nameOrHtml : readFileSync(join(DIR, nameOrHtml), 'utf8'));

/** The anchors snapshot the in-page script would return for this HTML. */
export function anchorSnapshotFromHtml(nameOrHtml: string, url: string): RawAnchorPage {
  const root = parseHtml(htmlOf(nameOrHtml));
  const anchors: RawAnchorPage['anchors'] = [];
  const walk = (n: HtmlNode, parents: HtmlNode[]) => {
    if (n.hidden) return;
    if (n.tag === 'a' && n.attrs['href']) {
      const text = squash(textOf(n));
      let context = '';
      for (let i = parents.length - 1; i >= 0 && i >= parents.length - 3; i--) {
        const t = squash(textOf(parents[i]!));
        if (t.length > text.length + 5) { context = t.slice(0, 500); break; }
      }
      anchors.push({ href: new URL(n.attrs['href'], url).toString(), text, context });
    }
    for (const c of n.children) walk(c, [...parents, n]);
  };
  walk(root, []);
  const title = squash(root.children.length ? textOf(findTag(root, 'title') ?? root) : '');
  return {
    url, title: findTag(root, 'title') ? title : '', text: visibleText(root), anchors,
    captchaWidget: /g-recaptcha|h-captcha|cf-turnstile/.test(htmlOf(nameOrHtml)),
  };
}

function findTag(n: HtmlNode, tag: string): HtmlNode | null {
  if (n.tag === tag) return n;
  for (const c of n.children) { const r = findTag(c, tag); if (r) return r; }
  return null;
}

export interface FakeScoutBrowser {
  launcher: LiLauncher;
  gotos: string[];
  clicks: string[];
  launches: number;
}

/** pages: URL -> fixture name or inline HTML. A URL missing from the map loads an empty page. */
export function createScoutBrowser(pages: Record<string, string>, redirects: Record<string, string> = {}): FakeScoutBrowser {
  const f: FakeScoutBrowser = { gotos: [], clicks: [], launches: 0, launcher: null as unknown as LiLauncher };
  f.launcher = {
    async launch(): Promise<LiBrowser> {
      f.launches++;
      return {
        async newContext(): Promise<LiContext> {
          let cur = 'about:blank';
          let html = '<html><body></body></html>';
          const loc = (sel: string): LiLocator => {
            const self: Partial<LiLocator> = {
              first: () => self as LiLocator,
              count: async () => 1,
              async click() { f.clicks.push(sel); },
            };
            return self as LiLocator;
          };
          const page = {
            async goto(u: string) { f.gotos.push(u); cur = redirects[u] ?? u; html = htmlOf(pages[cur] ?? '<html><body></body></html>'); },
            url: () => cur,
            title: async () => '',
            async evaluate(src: string) {
              if (src === ANCHORS_SCRIPT) return JSON.parse(JSON.stringify(anchorSnapshotFromHtml(html, cur)));
              if (src === FORM_SNAPSHOT_SCRIPT) return JSON.parse(JSON.stringify(snapshotFromHtml(html, cur)));
              if (src === FIXTURE_HTML_SCRIPT) return html;
              return null;
            },
            locator: (s: string) => loc(s),
            waitForTimeout: async () => undefined,
          } as unknown as LiPage;
          return { newPage: async () => page, storageState: async () => ({ cookies: [] }), waitForEvent: async () => page } as unknown as LiContext;
        },
        async close() { /* nothing */ },
      };
    },
  };
  return f;
}
