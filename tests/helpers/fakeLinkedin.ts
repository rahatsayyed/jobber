// Scripted fake LiLauncher for the LinkedIn runtime and tool tests. Never launches anything.
import { SNAPSHOT_SRC } from '../../src/linkedin/snapshot.js';
import type { LiBrowser, LiContext, LiLauncher, LiLocator, LiPage, RawSnapshot } from '../../src/linkedin/types.js';

export interface FakeElement { text: string; box?: { x: number; y: number; height: number }; attrs?: Record<string, string>; onClick?: () => void; visible?: boolean; navigateTo?: string; children?: Record<string, FakeElement[]> }
export interface FakeSite {
  pages: Record<string, Partial<RawSnapshot> & { title?: string; elements?: Record<string, FakeElement[]> }>; // key = URL path
  onGoto?: (url: string) => void;
  state?: unknown; // returned by context.storageState()
  gotoFails?: boolean;
  launchFails?: string;
  popup?: boolean;
  clickTimeout?: boolean;
  redirects?: Record<string, string>; // requested path -> final URL
  noResponse?: boolean; // waitForResponse rejects (no send-invitation response seen)
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
    const elementsFor = (sel: string, src?: Src): FakeElement[] => (src ? src()?.[sel] : pageDef().elements?.[sel]) ?? [];
    type Src = (() => Record<string, FakeElement[]> | undefined) | undefined;
    const loc = (sel: string, idx = 0, all = false, src?: Src): LiLocator => ({
      count: async () => (all ? elementsFor(sel, src).length : elementsFor(sel, src).length > idx ? 1 : 0),
      first: () => loc(sel, 0, false, src),
      locator: (child: string) => loc(child, 0, true, () => elementsFor(sel, src)[idx]?.children),
      nth: (i: number) => loc(sel, i, false, src),
      click: async () => {
        const el = elementsFor(sel, src)[idx];
        if (!el) throw new Error('no element');
        if (site.clickTimeout) { log.push(`click_attempt:${el.text}`); throw new Error('Timeout 2000ms exceeded'); }
        log.push(`click:${sel}:${el.text}`);
        el.onClick?.();
        if (el.navigateTo) current = el.navigateTo;
      },
      fill: async () => { log.push(`fill:${sel}`); },
      textContent: async () => elementsFor(sel, src)[idx]?.text ?? null,
      waitFor: async () => {
        const n = elementsFor(sel, src).length;
        if (all ? n === 0 : n <= idx) throw new Error('waitFor timeout');
      },
      evaluateAll: async <T>(fn: (els: any[]) => T) =>
        fn((all ? elementsFor(sel, src) : elementsFor(sel, src).slice(idx, idx + 1)).map((e) => ({
          innerText: e.text, textContent: e.text,
          getAttribute: (n: string) => e.attrs?.[n] ?? null,
          classList: { contains: (c: string) => String(e.attrs?.class ?? '').split(/\s+/).includes(c) },
          getBoundingClientRect: () => ({ x: e.box?.x ?? 0, y: e.box?.y ?? 0, height: e.box?.height ?? 0, width: 10 }),
          offsetWidth: e.visible === false ? 0 : 10, offsetHeight: e.visible === false ? 0 : 10,
          getClientRects: () => (e.visible === false ? [] : [{}]),
        }))),
    });
    const page: LiPage = {
      goto: async (url: string) => {
        log.push(`goto:${pathOf(url)}`);
        if (site.gotoFails) throw new Error('net');
        current = site.redirects?.[pathOf(url)] ?? url; site.onGoto?.(url);
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
      waitForResponse: async () => {
        if (site.noResponse) throw new Error('timeout');
        return {};
      },
      goBack: async () => { log.push('goBack'); },
      keyboard: { press: async (k: string) => { log.push(`press:${k}`); } },
      screenshot: async () => Buffer.from('png'),
    };
    const context: LiContext = {
      newPage: async () => page,
      storageState: async () => { launcher.storageStateCalls++; return site.state ?? { cookies: [] }; },
      waitForEvent: async () => {
        if (!site.popup) throw new Error('no popup');
        return { close: async () => { log.push('popup_closed'); } } as unknown as LiPage;
      },
    };
    const browser: LiBrowser = {
      newContext: async () => context,
      close: async () => { rec.closed = true; launcher.closed = true; },
    };
    return browser;
  };
  return launcher;
}
