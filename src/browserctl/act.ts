// browserctl engine (LinkedIn): open, snapshot and the actions the model can ask for. The model never
// passes code or a selector, only refs from the latest snapshot (s<epoch>.<n>) and plain values.
// Every action: kill switch and halt, stale-ref refusal, live re-describe of the element, guard
// classification, dry-run recording, pacing, then execute. Free actions go through; commit classes go to
// commit.ts; irreversible_other is always refused.
import { haltPlatform } from '../outreach/limits.js';
import { isBlockedPath, isLinkedInUrl, classifyUrl, profileKeyOf } from '../linkedin/urls.js';
import { recordDryRun } from '../safety/dryRun.js';
import { commitAction } from './commit.js';
import { BC_KEYS, type BcKey, type BcPage } from './driver.js';
import { detectTreeBlock, killReason, refused, type EngineDeps, type EngineResult } from './engineTypes.js';
import { checkType, classify, classifyKey, classifyPoint, guardInputOf, type ActionClass, type CommitClass } from './guard.js';
import { RefStore } from './refs.js';
import { renderTree, type LiveNode, type RawTree } from './snapshot.js';

export type { EngineDeps, EngineResult } from './engineTypes.js';

export interface Engine {
  open(url: string): Promise<EngineResult>;
  snapshot(): Promise<EngineResult>;
  click(ref: string): Promise<EngineResult>;
  type(ref: string, text: string, submit?: boolean): Promise<EngineResult>;
  pressKey(key: string): Promise<EngineResult>;
  scroll(direction: 'down' | 'up'): Promise<EngineResult>;
  waitFor(o: { ms?: number; text?: string }): Promise<EngineResult>;
  screenshot(): Promise<EngineResult>;
  clickAt(x: number, y: number): Promise<EngineResult>;
  /** The tree of the latest successful read (arm tools use it; never given to the model raw). */
  lastTree(): RawTree | null;
  /** The session page, or null. */
  page(): Promise<BcPage | null>;
  refs: RefStore;
}

const MAX_WAIT_MS = 10_000;
const FREE_KEYS = new Set<string>(['Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Backspace']);

export function createEngine(deps: EngineDeps): Engine {
  const refs = new RefStore();
  let tree: RawTree | null = null;
  let seenEpoch = -1;
  let shotEpoch = -1;
  let lastGoodUrl: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const now = () => deps.now();
  const pathOnly = (url: string) => { try { return new URL(url).pathname; } catch { return 'unknown'; } };

  async function pace(page: BcPage): Promise<void> {
    const ms = deps.paceMs ? deps.paceMs() : 300 + Math.floor(Math.random() * 600);
    if (ms > 0) await page.waitMs(ms).catch(() => undefined);
  }

  /** Read the page, halt on a block page, start a new epoch, feed telemetry, screen the text. */
  async function read(page: BcPage): Promise<EngineResult> {
    let t: RawTree;
    try { t = await page.snapshot(); } catch { return refused('no_snapshot', 'could not read the page'); }
    const block = detectTreeBlock(t);
    if (block) {
      haltPlatform(deps.db, 'linkedin', `${block}: ${pathOnly(t.url)}`, now());
      refs.invalidate();
      tree = null;
      await deps.afterBlock?.().catch(() => undefined);
      return { ok: false, code: 'halted', reason: `block page: ${block}` };
    }
    const epoch = refs.begin(t);
    tree = t;
    try { deps.layoutFeed?.(t); } catch { /* advisory */ }
    const v = await deps.screen(renderTree(t, epoch), 'read');
    if (v.blocked) { seenEpoch = -1; return { ok: false, code: v.code, reason: 'page text blocked by the input screen', epoch }; }
    seenEpoch = epoch;
    if (isLinkedInUrl(t.url) && !isBlockedPath(t.url).blocked) lastGoodUrl = t.url;
    const state = `epoch: ${epoch}\n${v.unscreened ? 'screen: unscreened\n' : ''}<<<PAGE_TEXT\n${v.text}\nPAGE_TEXT>>>`;
    return { ok: true, code: 'ok', state, epoch };
  }

  /** After an action: stay on LinkedIn, then re-read. */
  async function finish(page: BcPage, code: string): Promise<EngineResult> {
    await page.waitMs(deps.settleMs ?? 800).catch(() => undefined);
    const url = page.url();
    if (!isLinkedInUrl(url) || isBlockedPath(url).blocked) {
      const left = isLinkedInUrl(url) ? 'left_blocked_path' : 'left_linkedin_host';
      refs.invalidate();
      if (lastGoodUrl) await page.goto(lastGoodUrl).catch(() => undefined);
      return refused(left, 'navigated off LinkedIn or to a blocked path, went back');
    }
    const r = await read(page);
    return r.ok ? { ...r, code } : r;
  }

  const gate = async (): Promise<{ ok: false; res: EngineResult } | { ok: true; page: BcPage }> => {
    const k = killReason(deps);
    if (k) return { ok: false, res: { ok: false, code: k.startsWith('kill switch') ? 'killed' : 'halted', reason: k } };
    const page = await deps.getPage();
    if (!page) return { ok: false, res: refused('no_session', 'call linkedin_open first') };
    return { ok: true, page };
  };

  type Target = { page: BcPage; n: number; live: LiveNode };
  /** Resolve a ref and re-describe the element live; refuse stale refs and elements that changed. */
  async function target(ref: unknown): Promise<{ ok: false; res: EngineResult } | ({ ok: true } & Target)> {
    const g = await gate();
    if (!g.ok) return g;
    const r = refs.resolve(ref);
    if (!r.ok) return { ok: false, res: refused(r.code, r.reason) };
    const live = await g.page.describe(r.n).catch(() => null);
    if (!live) return { ok: false, res: refused('target_gone', 'element is gone; take a new snapshot') };
    const st = r.node;
    if (st && (st.role !== live.role || st.name !== live.name || st.dialogName !== live.dialogName || (st.dialog === undefined) !== (live.dialog === undefined))) {
      refs.invalidate();
      return { ok: false, res: refused('target_changed', 'page changed under the ref; take a new snapshot') };
    }
    return { ok: true, page: g.page, n: r.n, live };
  }

  const pageKind = (page: BcPage): string => classifyUrl(page.url());

  function recordFree(op: string, cls: ActionClass, live: LiveNode): void {
    if (!deps.cfg.dryRun) return;
    try {
      recordDryRun(deps.db, { runId: null, action: `linkedin_${op}`, platform: 'linkedin', payload: { class: cls, role: live.role, name: live.name.slice(0, 80) } }, now(), deps.env);
    } catch { /* recording is best effort for free actions */ }
  }

  /** Route a classified action: free executes, commit goes to the commit path, the rest is refused. */
  async function dispatch(
    op: string, page: BcPage, cls: ActionClass, live: LiveNode, act: () => Promise<void>, redescribe: () => Promise<LiveNode | null>,
  ): Promise<EngineResult> {
    if (cls === 'irreversible_other') return refused('irreversible_refused', 'this control is never clicked through the engine');
    if (cls === 'naukri_send' || cls === 'naukri_apply') return refused('wrong_platform', 'not a LinkedIn control');
    if (cls !== 'free') {
      const res = await commitAction({ deps, page, cls: cls as CommitClass, live, act, redescribe });
      refs.invalidate();
      return res;
    }
    recordFree(op, cls, live);
    await pace(page);
    const k = killReason(deps);
    if (k) return { ok: false, code: k.startsWith('kill switch') ? 'killed' : 'halted', reason: k };
    try { await act(); } catch { return refused('action_failed', `${op} failed`); }
    refs.invalidate();
    return finish(page, op === 'click' || op === 'click_at' ? 'clicked' : op === 'press_key' ? 'pressed' : 'typed');
  }

  async function doOpen(url: string): Promise<EngineResult> {
    if (!isLinkedInUrl(url)) return refused('not_linkedin', 'only https linkedin.com URLs may be opened');
    const b = isBlockedPath(url);
    if (b.blocked) return refused('blocked_path', b.why ?? 'path is blocked');
    const g = await gate();
    if (!g.ok) return g.res;
    await pace(g.page);
    recordNav(url);
    try { await g.page.goto(url); } catch { return refused('failed', 'open failed'); }
    refs.invalidate();
    const final = g.page.url();
    if (!isLinkedInUrl(final) || isBlockedPath(final).blocked) {
      if (lastGoodUrl) await g.page.goto(lastGoodUrl).catch(() => undefined);
      return refused('blocked_path', 'page redirected to a blocked or off-site URL');
    }
    return read(g.page);
  }
  function recordNav(url: string): void {
    if (!deps.cfg.dryRun) return;
    try { recordDryRun(deps.db, { runId: null, action: 'linkedin_open', platform: 'linkedin', payload: { path: pathOnly(url) } }, now(), deps.env); } catch { /* best effort */ }
  }

  async function doClick(ref: string): Promise<EngineResult> {
    const t = await target(ref);
    if (!t.ok) return t.res;
    const cls = classify(guardInputOf(t.live, 'linkedin', pageKind(t.page)));
    return dispatch('click', t.page, cls, t.live, () => t.page.clickNode(t.n), () => t.page.describe(t.n));
  }

  async function doPress(page: BcPage, key: BcKey, node: LiveNode | null, redescribe: () => Promise<LiveNode | null>): Promise<EngineResult> {
    if (!FREE_KEYS.has(key)) {
      if (!node) return refused('focus_unknown', 'cannot tell which element has focus; nothing pressed');
      const cls = classifyKey({ ...guardInputOf(node, 'linkedin', pageKind(page)), key });
      return dispatch('press_key', page, cls, node, () => page.press(key), redescribe);
    }
    await pace(page);
    try { await page.press(key); } catch { return refused('action_failed', 'press_key failed'); }
    refs.invalidate();
    return finish(page, 'pressed');
  }

  async function doType(ref: string, text: string, submit: boolean): Promise<EngineResult> {
    const t = await target(ref);
    if (!t.ok) return t.res;
    if (typeof text !== 'string') return refused('bad_text', 'text must be a string');
    const armed = deps.intents.peek('linkedin');
    const chk = checkType(t.live, text, armed ? { class: armed.class, text: armed.text } : null);
    if (!chk.ok) return refused(chk.code, chk.reason);
    if (chk.mode === 'composer' && armed && armed.class !== 'commit_accept_invite') {
      if (!armed.profileKey || profileKeyOf(t.page.url()) !== armed.profileKey) return refused('profile_url_mismatch', 'browser is not on the armed profile');
    }
    recordFree('type', 'free', t.live);
    await pace(t.page);
    try { await t.page.fillNode(t.n, text); } catch { return refused('action_failed', 'type failed'); }
    if (submit) {
      const f = await t.page.focused().catch(() => null);
      if (!f || f.n !== t.n) { refs.invalidate(); return refused('focus_mismatch', 'text typed, but focus is not on the field; Enter not pressed'); }
      return doPress(t.page, 'Enter', f, () => t.page.describe(t.n));
    }
    refs.invalidate();
    return finish(t.page, 'typed');
  }

  async function doClickAt(x: number, y: number): Promise<EngineResult> {
    if (!deps.screenshotEnabled) return refused('click_at_disabled', 'click_at needs LINKEDIN_SCREENSHOT=true');
    const g = await gate();
    if (!g.ok) return g.res;
    if (!(seenEpoch === refs.epoch && refs.hasSnapshot)) return refused('snapshot_required', 'take a snapshot at the current epoch first');
    if (shotEpoch !== refs.epoch) return refused('screenshot_required', 'take a screenshot at the current epoch first');
    const p = await classifyPoint(g.page, 'linkedin', pageKind(g.page), x, y);
    if (!p.ok) return refused(p.code, 'nothing usable at that point');
    return dispatch('click_at', g.page, p.cls, p.node, () => g.page.clickPoint(x, y), () => g.page.describeAt(x, y));
  }

  return {
    refs,
    lastTree: () => tree,
    page: () => deps.getPage(),
    open: (url) => serial(() => doOpen(url)),
    snapshot: () => serial(async () => {
      const g = await gate();
      return g.ok ? read(g.page) : g.res;
    }),
    click: (ref) => serial(() => doClick(ref)),
    type: (ref, text, submit) => serial(() => doType(ref, text, submit === true)),
    pressKey: (key) => serial(async () => {
      if (!(BC_KEYS as readonly string[]).includes(key)) return refused('key_not_allowed', 'key not allowed');
      const g = await gate();
      if (!g.ok) return g.res;
      const k = key as BcKey;
      const f = k === 'Enter' || k === 'Space' ? await g.page.focused().catch(() => null) : null;
      return doPress(g.page, k, f, async () => g.page.focused());
    }),
    scroll: (direction) => serial(async () => {
      const g = await gate();
      if (!g.ok) return g.res;
      await pace(g.page);
      await g.page.scroll(direction === 'up' ? 'up' : 'down');
      refs.invalidate();
      return finish(g.page, 'scrolled');
    }),
    waitFor: (o) => serial(async () => {
      const g = await gate();
      if (!g.ok) return g.res;
      const ms = Math.min(MAX_WAIT_MS, Math.max(0, Math.trunc(Number.isFinite(o.ms) ? (o.ms as number) : 1000)));
      const want = typeof o.text === 'string' ? o.text.trim().toLowerCase().slice(0, 80) : '';
      const deadline = Date.now() + ms;
      let found = want === '';
      do {
        if (ms > 0) await g.page.waitMs(Math.min(500, ms)).catch(() => undefined);
        if (!want) break;
        const t = await g.page.snapshot().catch(() => null);
        found = !!t && t.nodes.some((x) => (x.role === 'text' ? x.text : x.name).toLowerCase().includes(want));
      } while (!found && Date.now() < deadline);
      refs.invalidate();
      const r = await read(g.page);
      return r.ok ? { ...r, code: found ? 'ready' : 'timeout' } : r;
    }),
    screenshot: () => serial(async () => {
      if (!deps.screenshotEnabled) return refused('screenshot_disabled', 'screenshots are off (LINKEDIN_SCREENSHOT)');
      const g = await gate();
      if (!g.ok) return g.res;
      if (seenEpoch !== refs.epoch || !refs.hasSnapshot) return refused('snapshot_required', 'take a snapshot first');
      try {
        const png = await g.page.screenshot();
        shotEpoch = refs.epoch;
        return { ok: true, code: 'ok', base64: png.toString('base64'), unscreened: true, epoch: refs.epoch };
      } catch { return refused('failed', 'screenshot failed'); }
    }),
    clickAt: (x, y) => serial(() => doClickAt(x, y)),
  };
}
