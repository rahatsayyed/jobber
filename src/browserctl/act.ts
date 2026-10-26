// browserctl engine (LinkedIn): open, snapshot and the actions the model can ask for. The model never
// passes code or a selector, only refs from the latest snapshot (s<epoch>.<n>) and plain values.
// Every action: kill switch and halt, stale-ref refusal, live re-describe of the element, guard
// classification, dry-run recording, then execute. Free actions go through; commit classes go to
// commit.ts; irreversible_other is always refused.
import { haltPlatform } from '../outreach/limits.js';
import { profileKeyOf } from '../linkedin/urls.js';
import { naukriJobIdOfUrl, threadRefOfUrl } from '../naukri/page.js';
import { threadRefOfUrl as wellfoundThreadRefOfUrl, wellfoundJobIdOfUrl } from '../wellfound/page.js';
import { recordDryRun } from '../safety/dryRun.js';
import { commitAction, effectiveDialogKind, profileHeadingName } from './commit.js';
import { dialogWithoutControls, writeCommitDiag } from './diag.js';
import { applyCounted, commitNaukri, observeApplyConfirmation } from './commitNaukri.js';
import { commitWellfound, observeWellfoundApplyConfirmation, wellfoundApplyCounted } from './commitWellfound.js';
import { BC_KEYS, type BcKey, type BcPage } from './driver.js';
import { killReason, refused, type EngineDeps, type EngineResult } from './engineTypes.js';
import { checkType, classify, classifyKey, classifyPoint, connectPlacementRefusal, guardInputOf, isConnectControlName, normName, type ActionClass, type CommitClass } from './guard.js';
import { LINKEDIN_POLICY } from './policy.js';
import { RefStore } from './refs.js';
import { renderTree, type LiveNode, type RawTree } from './snapshot.js';

export type { EngineDeps, EngineResult } from './engineTypes.js';

export interface Engine {
  /**
   * Navigate and return a settled snapshot. keepRefs (arm verification only): if the page read after
   * navigation is the same page as the operator's latest snapshot (same URL, same actionable nodes), the
   * public epoch and refs are left as they were; any real difference leaves them stale as usual.
   */
  open(url: string, opts?: { keepRefs?: boolean }): Promise<EngineResult>;
  snapshot(): Promise<EngineResult>;
  /**
   * Read the page for verification (arm tools) without a new epoch and without touching the refs: the
   * operator's refs stay valid, and a ref whose element moved is re-resolved by role and name when used.
   */
  peek(): Promise<EngineResult>;
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
/** open(): poll the tree every OPEN_SETTLE_POLL_MS until the node count is unchanged across two reads, at most OPEN_SETTLE_MAX_MS. */
export const OPEN_SETTLE_POLL_MS = 300;
export const OPEN_SETTLE_MAX_MS = 6000;

/** Identity of the actionable part of a tree: what a ref resolves against. Text nodes are ignored. */
function treeSignature(t: RawTree): string {
  const rows = t.nodes
    .filter((x) => x.role !== 'text')
    .map((x) => `${x.n}|${x.role}|${x.name}|${x.href ?? ''}|${x.dialogName ?? ''}|${x.dialog === undefined ? 0 : 1}|${x.disabled ? 1 : 0}`);
  return `${t.url}\n${rows.join('\n')}`;
}
function samePath(a: string, b: string): boolean {
  try { const x = new URL(a); const y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch { return false; }
}
/** At most this many "dialog without controls" diag files per engine (one process), so a stuck page cannot fill the disk. */
const MAX_EMPTY_DIALOG_DIAGS = 3;
const FREE_KEYS = new Set<string>(['Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Backspace']);

export function createEngine(deps: EngineDeps): Engine {
  const P = deps.policy ?? LINKEDIN_POLICY;
  const refs = new RefStore();
  let tree: RawTree | null = null;
  let seenEpoch = -1;
  let shotEpoch = -1;
  let lastGoodUrl: string | null = null;
  let emptyDialogDiags = 0;
  // Set right after a click on the profile's own top-card More: the `role|name` keys of every control that was on the
  // page BEFORE that click. Controls that are new afterwards are the menu rows (LinkedIn's menu rows are plain links and
  // buttons in a portal, not role=menuitem), so they read as region 'menu'; only then may a Connect row be clicked.
  let menuBase: Set<string> | null = null;
  let moreDiags = 0;
  const keyOf = (x: { role: string; name: string }): string => `${x.role}|${x.name}`;
  const isRowRole = (r: string): boolean => r === 'button' || r === 'link' || r === 'menuitem' || r === 'option';
  const isNewRow = (x: LiveNode): boolean => menuBase !== null && x.dialog === undefined && isRowRole(x.role)
    && x.region !== undefined && x.region !== 'menu' && x.region !== 'dialog' && !menuBase.has(keyOf(x));
  const tagLive = (x: LiveNode | null): LiveNode | null => (x && isNewRow(x) ? { ...x, region: 'menu' } : x);
  const tagMenu = (t: RawTree): RawTree => (menuBase === null ? t : { ...t, nodes: t.nodes.map((x) => tagLive(x) as LiveNode) });
  const tagged = new WeakMap<BcPage, BcPage>();
  // The page every engine action uses: snapshots and live re-reads carry the menu region while a menu is open.
  const tagPage = (p: BcPage): BcPage => {
    let w = tagged.get(p);
    if (!w) {
      // Delegates to the page (not a copy), so a method the page swaps later still reaches the engine.
      w = Object.assign(Object.create(p) as BcPage, {
        snapshot: async () => tagMenu(await p.snapshot()),
        describe: async (n: number) => tagLive(await p.describe(n)),
        describeAt: async (x: number, y: number) => tagLive(await p.describeAt(x, y)),
      });
      tagged.set(p, w);
    }
    return w;
  };
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
    const block = P.detectBlock(t);
    if (block) {
      refs.invalidate();
      tree = null;
      if (!block.halt) return { ok: false, code: block.kind, reason: `page needs attention: ${block.kind}` };
      haltPlatform(deps.db, P.platform, `${block.kind}: ${pathOnly(t.url)}`, now());
      await deps.afterBlock?.().catch(() => undefined);
      return { ok: false, code: 'halted', reason: `block page: ${block.kind}` };
    }
    const epoch = refs.begin(t);
    tree = t;
    try { deps.layoutFeed?.(t); } catch { /* advisory */ }
    const v = await deps.screen(renderTree(t, epoch), 'read');
    if (v.blocked) { seenEpoch = -1; return { ok: false, code: v.code, reason: 'page text blocked by the input screen', epoch }; }
    seenEpoch = epoch;
    // An open dialog with no visible control (the walker and the locator layer both missed its content): leave a structural diag.
    const empty = dialogWithoutControls(t);
    if (empty && emptyDialogDiags < MAX_EMPTY_DIALOG_DIAGS) {
      emptyDialogDiags++;
      await writeCommitDiag(deps, page, { platform: P.platform, code: 'dialog_controls_missing', live: empty, urlBefore: t.url, after: t });
    }
    if (P.platform === 'naukri') {
      // A confirmation that shows up after a chatbot answer (no commit-class click) is still recorded once.
      try { observeApplyConfirmation(deps, t); } catch { /* bookkeeping only */ }
    } else if (P.platform === 'wellfound') {
      try { observeWellfoundApplyConfirmation(deps, t); } catch { /* bookkeeping only */ }
    }
    if (P.checkUrl(t.url).ok) lastGoodUrl = t.url;
    const state = `epoch: ${epoch}\n${v.unscreened ? 'screen: unscreened\n' : ''}<<<PAGE_TEXT\n${v.text}\nPAGE_TEXT>>>`;
    return { ok: true, code: 'ok', state, epoch };
  }

  /** After an action: stay on the platform, then re-read. */
  async function finish(page: BcPage, code: string): Promise<EngineResult> {
    await page.waitMs(deps.settleMs ?? 800).catch(() => undefined);
    const url = page.url();
    const where = P.checkUrl(url);
    if (!where.ok) {
      const left = where.code === 'blocked_path' ? 'left_blocked_path' : `left_${P.tool}_host`;
      refs.invalidate();
      if (lastGoodUrl) await page.goto(lastGoodUrl).catch(() => undefined);
      return refused(left, `navigated off ${P.tool} or to a blocked path, went back`);
    }
    const r = await read(page);
    return r.ok ? { ...r, code } : r;
  }

  const gate = async (): Promise<{ ok: false; res: EngineResult } | { ok: true; page: BcPage }> => {
    const k = killReason(deps);
    if (k) return { ok: false, res: { ok: false, code: k.startsWith('kill switch') ? 'killed' : 'halted', reason: k } };
    const page = await deps.getPage();
    if (!page) return { ok: false, res: refused('no_session', `call ${P.tool}_open first`) };
    return { ok: true, page: P.platform === 'linkedin' ? tagPage(page) : page };
  };

  type Target = { page: BcPage; n: number; live: LiveNode };
  /** Resolve a ref and re-describe the element live; refuse stale refs and elements that changed. */
  async function target(ref: unknown): Promise<{ ok: false; res: EngineResult } | ({ ok: true } & Target)> {
    const g = await gate();
    if (!g.ok) return g;
    const r = refs.resolve(ref);
    if (!r.ok) return { ok: false, res: refused(r.code, r.reason) };
    let n = r.n;
    let live = await g.page.describe(n).catch(() => null);
    const st = r.node;
    const same = (a: LiveNode | null): a is LiveNode =>
      !!a && (!st || (st.role === a.role && st.name === a.name && st.dialogName === a.dialogName && (st.dialog === undefined) === (a.dialog === undefined)));
    if (!same(live) && st && tree && samePath(tree.url, g.page.url())) {
      // The page re-rendered and the ordinals moved: find the ONE element with the stored role, name,
      // href and dialog name in a fresh read (which restamps the page). Zero or several matches fail closed.
      const fresh = await g.page.snapshot().catch(() => null);
      if (fresh && fresh.nodes.length > 0) {
        const hits = fresh.nodes.filter((x) => x.role === st.role && x.name === st.name && x.dialogName === st.dialogName
          && (x.dialog === undefined) === (st.dialog === undefined) && (x.href ?? '') === (st.href ?? ''));
        if (hits.length === 1) {
          const re = await g.page.describe(hits[0].n).catch(() => null);
          if (same(re)) { n = hits[0].n; live = re; tree = fresh; }
        }
      }
    }
    if (!live) return { ok: false, res: refused('target_gone', 'element is gone; take a new snapshot') };
    if (!same(live)) {
      refs.invalidate();
      return { ok: false, res: refused('target_changed', 'page changed under the ref; take a new snapshot') };
    }
    return { ok: true, page: g.page, n, live };
  }

  const pageKind = (page: BcPage): string => P.pageKind(page.url());
  const isTopCardMore = (n: LiveNode): boolean => P.platform === 'linkedin' && n.region === 'topcard' && /^more\b/.test(normName(n.name));

  function recordFree(op: string, cls: ActionClass, live: LiveNode): void {
    if (!deps.cfg.dryRun) return;
    try {
      recordDryRun(deps.db, { runId: null, action: `${P.platform}_${op}`, platform: P.platform, payload: { class: cls, role: live.role, name: live.name.slice(0, 80) } }, now(), deps.env);
    } catch { /* recording is best effort for free actions */ }
  }

  /** Route a classified action: free executes, commit goes to the commit path, the rest is refused. */
  async function dispatch(
    op: string, page: BcPage, cls: ActionClass, live: LiveNode, act: () => Promise<void>, redescribe: () => Promise<LiveNode | null>,
  ): Promise<EngineResult> {
    if (cls === 'irreversible_other') return refused('irreversible_refused', 'this control is never clicked through the engine');
    // Each platform owns its commit classes: a class of another platform never reaches a commit path.
    const owner = cls === 'naukri_send' || cls === 'naukri_apply' ? 'naukri'
      : cls === 'wellfound_send' || cls === 'wellfound_apply' ? 'wellfound' : 'linkedin';
    if (cls !== 'free' && owner !== P.platform) return refused('wrong_platform', `not a ${P.tool} control`);
    // LinkedIn More menu rows (plain links and buttons): in the connect flow only Connect and Personalize invite are clicked.
    if (P.platform === 'linkedin' && live.region === 'menu' && (live.role === 'link' || live.role === 'button') && !isConnectControlName(live.name)) {
      return refused('menu_row_not_allowed', 'only the Connect or Personalize invite row of the More menu may be clicked');
    }
    // LinkedIn: a Connect outside the profile's top card sends the invitation directly. Refused before anything else.
    if (P.platform === 'linkedin' && cls === 'commit_connect_send') {
      const bad = connectPlacementRefusal(live, menuBase !== null, tree ? profileHeadingName(tree) : '');
      if (bad) return refused(bad.code, bad.reason);
    }
    if (cls !== 'free') {
      const res = P.platform === 'naukri'
        ? await commitNaukri({ deps, page, cls: cls as 'naukri_send' | 'naukri_apply', live, act, redescribe })
        : P.platform === 'wellfound'
          ? await commitWellfound({ deps, page, cls: cls as 'wellfound_send' | 'wellfound_apply', live, act, redescribe })
          : await commitAction({ deps, page, cls: cls as CommitClass, live, act, redescribe });
      // A commit refused before anything was clicked changed nothing on the page: the refs stay valid.
      if (res.code !== 'no_armed_intent') refs.invalidate();
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

  /** Wait for load, then re-walk the tree until the node count is stable across two reads. Bounded, never throws. */
  async function settleAfterOpen(page: BcPage): Promise<void> {
    const pollMs = Math.max(1, deps.openSettle?.pollMs ?? OPEN_SETTLE_POLL_MS);
    const maxMs = deps.openSettle?.maxMs ?? OPEN_SETTLE_MAX_MS;
    const maxPolls = Math.max(1, Math.ceil(maxMs / pollMs));
    try {
      await page.waitForLoad?.(maxMs);
      let prev = -1;
      for (let i = 0; i < maxPolls; i++) {
        const t = await page.snapshot().catch(() => null);
        const n = t ? t.nodes.length : 0;
        if (n > 0 && n === prev) return;
        prev = n;
        await page.waitMs(pollMs).catch(() => undefined);
      }
    } catch { /* settling is best effort */ }
  }

  async function doOpen(url: string, keepRefs = false): Promise<EngineResult> {
    const allowed = P.checkUrl(url);
    if (!allowed.ok) return refused(allowed.code, allowed.why);
    const g = await gate();
    if (!g.ok) return g.res;
    await pace(g.page);
    recordNav(url);
    menuBase = null;
    const prior = keepRefs && tree && refs.hasSnapshot ? { saved: refs.save(), seen: seenEpoch, sig: treeSignature(tree) } : null;
    try { await g.page.goto(url); } catch { return refused('failed', 'open failed'); }
    refs.invalidate();
    const final = g.page.url();
    if (!P.checkUrl(final).ok) {
      if (lastGoodUrl) await g.page.goto(lastGoodUrl).catch(() => undefined);
      return refused('blocked_path', 'page redirected to a blocked or off-site URL');
    }
    await settleAfterOpen(g.page);
    const r = await read(g.page);
    if (prior && r.ok && tree && treeSignature(tree) === prior.sig) {
      // Same page as the operator's last snapshot: the stamps just re-applied carry the same ordinals,
      // so the operator's refs still point at the same elements. A screenshot must be retaken.
      refs.restore(prior.saved);
      seenEpoch = prior.seen;
      shotEpoch = -1;
      return { ...r, epoch: refs.epoch, state: r.state?.replace(/^epoch: \d+/, `epoch: ${refs.epoch}`) };
    }
    return r;
  }
  function recordNav(url: string): void {
    if (!deps.cfg.dryRun) return;
    try { recordDryRun(deps.db, { runId: null, action: `${P.platform}_open`, platform: P.platform, payload: { path: pathOnly(url) } }, now(), deps.env); } catch { /* best effort */ }
  }

  async function doClick(ref: string): Promise<EngineResult> {
    const t = await target(ref);
    if (!t.ok) return t.res;
    // A LinkedIn dialog whose name says nothing is still the invite dialog when it holds the invite controls.
    const dk = P.platform === 'linkedin' && t.live.dialog !== undefined && tree ? effectiveDialogKind(tree, t.live.dialog, t.live.dialogName) : null;
    const cls = classify(guardInputOf(t.live, P.platform, pageKind(t.page), false, dk));
    const more = isTopCardMore(t.live);
    if (more) menuBase = new Set((tree?.nodes ?? []).map(keyOf));
    const res = await dispatch('click', t.page, cls, t.live, () => t.page.clickNode(t.n), () => t.page.describe(t.n));
    await afterMenuClick(t.page, t.live, more, res);
    return res;
  }

  /** The menu stays open across a refused click (the page did not change); any other click closes it. */
  async function afterMenuClick(page: BcPage, live: LiveNode, more: boolean, res: EngineResult): Promise<void> {
    if (more && res.ok) await diagMissingMenu(page, live);
    else if (more || res.ok) menuBase = null;
  }

  /** More was clicked and no row of a menu showed up: leave a structural diag (tags, roles, counts, fixed labels) once per a few runs. */
  async function diagMissingMenu(page: BcPage, live: LiveNode): Promise<void> {
    if (!tree || tree.nodes.some((x) => x.region === 'menu' && x.name) || moreDiags >= MAX_EMPTY_DIALOG_DIAGS) return;
    moreDiags++;
    await writeCommitDiag(deps, page, { platform: P.platform, code: 'more_menu_missing', live, urlBefore: tree.url, after: tree });
  }

  async function doPress(page: BcPage, key: BcKey, node: LiveNode | null, redescribe: () => Promise<LiveNode | null>): Promise<EngineResult> {
    menuBase = null;
    if (!FREE_KEYS.has(key)) {
      if (!node) return refused('focus_unknown', 'cannot tell which element has focus; nothing pressed');
      const cls = classifyKey({ ...guardInputOf(node, P.platform, pageKind(page)), key });
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
    menuBase = null;
    const armed = deps.intents.peek(P.platform);
    const chk = checkType(t.live, text, armed ? { class: armed.class, text: armed.text } : null);
    if (!chk.ok) return refused(chk.code, chk.reason);
    if (P.platform === 'linkedin') {
      if (chk.mode === 'composer' && armed && armed.class !== 'commit_accept_invite') {
        if (!armed.profileKey || profileKeyOf(t.page.url()) !== armed.profileKey) return refused('profile_url_mismatch', 'browser is not on the armed profile');
      }
    } else if (P.platform === 'wellfound') {
      // Wellfound: the thread composer only on the armed thread; the application note field only on the armed
      // job's page, after its Apply click was counted, and only the exact armed note (checkType); plain fields
      // go through the text gate.
      if (chk.mode === 'composer') {
        if (!armed) return refused('no_armed_intent', 'composer text needs an armed intent');
        if (armed.class === 'wellfound_send') {
          if (!armed.threadRef || wellfoundThreadRefOfUrl(t.page.url()) !== armed.threadRef) return refused('thread_mismatch', 'browser is not on the armed thread');
        } else if (armed.class === 'wellfound_apply') {
          if (!armed.pageKey || wellfoundJobIdOfUrl(t.page.url()) !== armed.pageKey) return refused('job_mismatch', 'browser is not on the armed job page');
          if (!wellfoundApplyCounted(deps.intents).has(armed.pageKey)) return refused('apply_not_started', 'click Apply under the armed intent before typing the note');
        } else {
          return refused('intent_class_mismatch', 'the armed intent is not a Wellfound send or apply');
        }
      } else {
        const why = deps.textGate?.(text, 'plain');
        if (why) return refused('output_gate', `text refused: ${why}`);
      }
    } else {
      // Naukri: the thread composer only on the armed thread; the apply chatbot only on the armed job's
      // page, after its Apply click was counted; plain fields and chatbot answers go through the text gate.
      if (chk.mode === 'composer') {
        if (!armed || armed.class !== 'naukri_send' || !armed.threadRef || threadRefOfUrl(t.page.url()) !== armed.threadRef) {
          return refused('thread_mismatch', 'browser is not on the armed thread');
        }
      } else if (chk.mode === 'chatbot') {
        if (!armed || armed.class !== 'naukri_apply' || !armed.pageKey || naukriJobIdOfUrl(t.page.url()) !== armed.pageKey) {
          return refused('job_mismatch', 'browser is not on the armed job page');
        }
        if (!applyCounted(deps.intents).has(armed.pageKey)) return refused('apply_not_started', 'click Apply under the armed intent before answering the chatbot');
      }
      if (chk.mode !== 'composer') {
        const why = deps.textGate?.(text, chk.mode);
        if (why) return refused('output_gate', `text refused: ${why}`);
      }
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
    if (!deps.screenshotEnabled) return refused('click_at_disabled', `click_at is off (${P.screenshotFlag}=false)`);
    const g = await gate();
    if (!g.ok) return g.res;
    if (!(seenEpoch === refs.epoch && refs.hasSnapshot)) return refused('snapshot_required', 'take a snapshot at the current epoch first');
    if (shotEpoch !== refs.epoch) return refused('screenshot_required', 'take a screenshot at the current epoch first');
    const p = await classifyPoint(g.page, P.platform, pageKind(g.page), x, y,
      (n) => (P.platform === 'linkedin' && n.dialog !== undefined && tree ? effectiveDialogKind(tree, n.dialog, n.dialogName) : null));
    if (!p.ok) return refused(p.code, 'nothing usable at that point');
    const more = isTopCardMore(p.node);
    if (more) menuBase = new Set((tree?.nodes ?? []).map(keyOf));
    const res = await dispatch('click_at', g.page, p.cls, p.node, () => g.page.clickPoint(x, y), () => g.page.describeAt(x, y));
    await afterMenuClick(g.page, p.node, more, res);
    return res;
  }

  return {
    refs,
    lastTree: () => tree,
    page: () => deps.getPage(),
    open: (url, opts) => serial(() => doOpen(url, opts?.keepRefs === true)),
    snapshot: () => serial(async () => {
      const g = await gate();
      return g.ok ? read(g.page) : g.res;
    }),
    peek: () => serial(async () => {
      const g = await gate();
      if (!g.ok) return g.res;
      let t: RawTree;
      try { t = await g.page.snapshot(); } catch { return refused('no_snapshot', 'could not read the page'); }
      const block = P.detectBlock(t);
      if (block) {
        refs.invalidate();
        tree = null;
        if (!block.halt) return { ok: false, code: block.kind, reason: `page needs attention: ${block.kind}` };
        haltPlatform(deps.db, P.platform, `${block.kind}: ${pathOnly(t.url)}`, now());
        await deps.afterBlock?.().catch(() => undefined);
        return { ok: false, code: 'halted', reason: `block page: ${block.kind}` };
      }
      tree = t;
      try { deps.layoutFeed?.(t); } catch { /* advisory */ }
      return { ok: true, code: 'ok', epoch: refs.epoch };
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
      if (!deps.screenshotEnabled) return refused('screenshot_disabled', `screenshots are off (${P.screenshotFlag}=false)`);
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
