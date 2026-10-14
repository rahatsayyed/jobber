// Scripted fake LiLauncher for the LinkedIn runtime and tool tests. Never launches anything.
import { SNAPSHOT_SRC } from '../../src/linkedin/snapshot.js';
import type { LiBrowser, LiContext, LiLauncher, LiLocator, LiPage, RawSnapshot } from '../../src/linkedin/types.js';

export interface FakeElement { text: string; box?: { x: number; y: number; height: number }; attrs?: Record<string, string>; onClick?: () => void; visible?: boolean }
export interface FakeSite {
  pages: Record<string, Partial<RawSnapshot> & { title?: string; elements?: Record<string, FakeElement[]> }>; // key = URL path
  onGoto?: (url: string) => void;
  state?: unknown; // returned by context.storageState()
  gotoFails?: boolean;
  launchFails?: string;
}
export type FakeLauncher = LiLauncher & { closed: boolean; launches: number; browsers: Array<{ closed: boolean }>; storageStateCalls: number };

const EMPTY: RawSnapshot = {
  url: '', title: '', profile: null, results: [], invitations: [], messages: [], messageHeaderName: null,
  notices: [], dialogText: null, hasPasswordInput: false, bodyText: '',
};

export function makeFakeLauncher(site: FakeSite, log: string[]): FakeLauncher {
  const launcher = { closed: false, launches: 0, browsers: [] as Array<{ closed: boolean }>, storageStateCalls: 0 } as FakeLauncher;
  launcher.launch = async () => {
    if (site.launchFails) throw new Error(site.launchFails);
    launcher.launches++;
    const rec = { closed: false };
    launcher.browsers.push(rec);
    let current = 'about:blank';
    const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
    const pageDef = () => site.pages[pathOf(current)] ?? {};
    const elementsFor = (sel: string): FakeElement[] => pageDef().elements?.[sel] ?? [];
    const loc = (sel: string, idx = 0, all = false): LiLocator => ({
      count: async () => (all ? elementsFor(sel).length : elementsFor(sel).length > idx ? 1 : 0),
      first: () => loc(sel, 0),
      nth: (i: number) => loc(sel, i),
      click: async () => {
        const el = elementsFor(sel)[idx];
        if (!el) throw new Error('no element');
        log.push(`click:${sel}:${el.text}`);
        el.onClick?.();
      },
      fill: async () => { log.push(`fill:${sel}`); },
      textContent: async () => elementsFor(sel)[idx]?.text ?? null,
      waitFor: async () => {},
      evaluateAll: async <T>(fn: (els: any[]) => T) =>
        fn(elementsFor(sel).map((e) => ({
          innerText: e.text, textContent: e.text,
          getAttribute: (n: string) => e.attrs?.[n] ?? null,
          offsetWidth: e.visible === false ? 0 : 10, offsetHeight: e.visible === false ? 0 : 10,
          getClientRects: () => (e.visible === false ? [] : [{}]),
        }))),
    });
    const page: LiPage = {
      goto: async (url: string) => {
        log.push(`goto:${pathOf(url)}`);
        if (site.gotoFails) throw new Error('net');
        current = url; site.onGoto?.(url);
      },
      url: () => current,
      title: async () => pageDef().title ?? '',
      evaluate: (async (src: string) => {
        log.push('snapshot');
        if (src === SNAPSHOT_SRC) {
          const d = pageDef();
          return { ...EMPTY, ...d, url: current, title: d.title ?? '' } as RawSnapshot;
        }
        return null;
      }) as LiPage['evaluate'],
      locator: (sel: string) => loc(sel, 0, true),
      waitForTimeout: async () => {},
      waitForResponse: async () => ({}),
      goBack: async () => { log.push('goBack'); },
      keyboard: { press: async (k: string) => { log.push(`press:${k}`); } },
      screenshot: async () => Buffer.from('png'),
    };
    const context: LiContext = {
      newPage: async () => page,
      storageState: async () => { launcher.storageStateCalls++; return site.state ?? { cookies: [] }; },
      waitForEvent: async () => { throw new Error('no popup'); },
    };
    const browser: LiBrowser = {
      newContext: async () => context,
      close: async () => { rec.closed = true; launcher.closed = true; },
    };
    return browser;
  };
  return launcher;
}
