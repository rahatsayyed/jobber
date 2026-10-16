// Hermetic fake browser over the invented fixtures: a launcher whose page speaks the same
// evaluate/locator surface the webcore form driver uses (data-jf / data-jc tags). No network, no Chrome.
import { loadFixture as loadNamed, snapshotFromHtml } from './fixtureSite.js';
import type { RawFormSnapshot } from '../../src/webcore/formModel.js';
import type { LiBrowser, LiContext, LiLauncher, LiLocator, LiPage } from '../../src/linkedin/types.js';

export interface Step { fixture: string; notices?: string[] }
export interface FakeSiteOpts {
  start: string;
  url?: string;
  // when set, page.url() reads this ref (simulates a redirect to another host)
  urlRef?: { value: string };
  /** control label -> next page(s); a list is consumed in order, the last entry repeats */
  transitions?: Record<string, Step[]>;
  /** a checkbox whose label matches re-checks itself after any click (hostile page) */
  stickyLabel?: RegExp;
  /** every fill throws an error whose text contains the typed value (leak test) */
  failFill?: boolean;
  /** called on every click with the label, before the transition */
  onClick?: (label: string, kind: 'field' | 'control') => void;
}
export interface FakeSite {
  launcher: LiLauncher;
  events: string[];
  /** every typed value, in order: the leak tests search for the canary here and nowhere else */
  fills: Array<{ label: string; value: string }>;
  // option selections and uploaded file paths, in order
  selections: Array<{ label: string; option: string }>;
  uploads: Array<{ label: string; path: string }>;
  current: () => RawFormSnapshot;
}

export function createFakeSite(o: FakeSiteOpts): FakeSite {
  const url = o.url ?? 'https://wd.example.test/careers';
  // A start/step starting with "<" is inline invented HTML, otherwise a fixture file name.
  const loadFixture = (n: string, u: string): RawFormSnapshot => (n.trim().startsWith('<') ? snapshotFromHtml(n, u) : loadNamed(n, u));
  let cur: RawFormSnapshot = loadFixture(o.start, url);
  const events: string[] = [];
  const fills: Array<{ label: string; value: string }> = [];
  const selections: Array<{ label: string; option: string }> = [];
  const uploads: Array<{ label: string; path: string }> = [];
  const used: Record<string, number> = {};
  const loc = (sel: string): LiLocator => {
    const m = /^\[data-(jf|jc)="(\d+)"\]$/.exec(sel);
    const kind = m?.[1];
    const i = m ? Number(m[2]) : -1;
    const self: Partial<LiLocator> = {
      first: () => self as LiLocator,
      count: async () => (kind === 'jf' ? (cur.fields[i] ? 1 : 0) : kind === 'jc' ? (cur.controls[i] ? 1 : 0) : 0),
      async fill(text: string) {
        const f = cur.fields[i];
        if (kind !== 'jf' || !f) throw new Error('no field');
        if (o.failFill) throw new Error(`could not type ${text}`);
        f.filled = text !== '';
        fills.push({ label: f.label, value: text });
        events.push(`fill:${f.label}`);
      },
      async selectOption(v: { label: string }) {
        const f = cur.fields[i];
        if (kind !== 'jf' || !f || f.type !== 'select' || !(f.options ?? []).includes(v.label)) throw new Error('no select');
        f.filled = true;
        selections.push({ label: f.label, option: v.label });
        events.push(`select:${f.label}`);
      },
      async setInputFiles(p: string) {
        const f = cur.fields[i];
        if (kind !== 'jf' || !f || f.type !== 'file') throw new Error('no file input');
        f.filled = true;
        uploads.push({ label: f.label, path: p });
        events.push(`upload:${f.label}`);
      },
      async click() {
        if (kind === 'jf') {
          const f = cur.fields[i];
          if (!f) throw new Error('no field');
          events.push(`click:field:${f.label}`);
          o.onClick?.(f.label, 'field');
          if (f.type === 'checkbox') f.checked = o.stickyLabel?.test(f.label) ? true : !f.checked;
          return;
        }
        const c = cur.controls[i];
        if (kind !== 'jc' || !c) throw new Error('no control');
        events.push(`click:control:${c.label}`);
        o.onClick?.(c.label, 'control');
        const list = o.transitions?.[c.label];
        if (list?.length) {
          const n = used[c.label] ?? 0;
          used[c.label] = n + 1;
          const step = list[Math.min(n, list.length - 1)];
          cur = loadFixture(step.fixture, url);
          if (step.notices) cur.notices = step.notices;
        }
      },
    };
    return self as LiLocator;
  };
  const page = {
    async goto() { events.push('goto'); cur = loadFixture(o.start, url); },
    url: () => o.urlRef?.value ?? url,
    title: async () => cur.title,
    async evaluate() { return JSON.parse(JSON.stringify(cur)); },
    locator: (s: string) => loc(s),
    waitForTimeout: async () => undefined,
  } as unknown as LiPage;
  const context = { newPage: async () => page, storageState: async () => ({ cookies: [] }), waitForEvent: async () => page } as unknown as LiContext;
  const browser: LiBrowser = { newContext: async () => context, close: async () => undefined };
  return { launcher: { launch: async () => browser }, events, fills, selections, uploads, current: () => cur };
}
