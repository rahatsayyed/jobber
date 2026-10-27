// browserctl locator dialog layer. LinkedIn renders the invite modal inside a CLOSED shadow root: the
// in-page DOM walker (page.evaluate) cannot see it, but Patchright locators (getByRole, chaining, evaluate on
// the located element, innerText, inputValue, fill, click) can. This layer reads such dialogs through
// locators and adds them to the snapshot as ordinary nodes (role, name, dialog, dialogName, value) with
// ordinals >= LOCATOR_BASE. Everything above it (refs and epochs, the guard, re-describe at click, the commit
// path, the armed intent checks) sees the same node shape as before and is unchanged. Nodes are mapped to
// locator descriptors (dialog scope, role, nth), never to data-bc ordinals. The model never passes a selector.
// Applies only when the walker saw fewer dialogs with controls than the locators saw dialogs (the walker wins when it sees them).
import type { BcPage } from './driver.js';
import type { PageDiag } from './diag.js';
import { LOCATOR_BASE, MAX_NAME, MAX_TEXT, MAX_VALUE, type BcRole, type LiveNode, type RawNode, type RawTree } from './snapshot.js';

export { LOCATOR_BASE };
const DIALOG_STRIDE = 1000;
const MAX_DIALOGS = 3;
const MAX_MENUS = 3;
const MAX_MENU_ITEMS = 30;
const MAX_PER_ROLE = 20;
const MAX_TEXT_LINES = 40;
const OP_TIMEOUT_MS = 1500;
// A dialog or menu that is open but lists no control yet is still filling in (LinkedIn renders the invite modal over
// several seconds). A snapshot polls for its controls this long at most (poll interval, then total).
export const FILL_POLL_MS = 400;
// One ceiling for the whole opening, counted from the click: the dialog may appear 4 to 6 s late and then fill in.
export const OPEN_CEILING_MS = 15000;
export const FILL_MAX_MS = OPEN_CEILING_MS;
// Every control under a container, whatever the accessibility tree says (CSS pierces open shadow roots; an aria-hidden
// ancestor or a missing role in the tree does not matter). Roles are decided in the page by FACTS_FN.
const CONTROL_CSS = 'button, a[href], input, textarea, [role="button"], [role="link"], [role="textbox"], [contenteditable]';
// Roles a click_at point may resolve to inside a locator container.
const POINT_ROLES = new Set<string>(['button', 'link', 'textbox', 'menuitem', 'option']);

/** Structural subset of a Patchright locator used here. */
export interface LdLocator {
  count(): Promise<number>;
  nth(i: number): LdLocator;
  first(): LdLocator;
  getByRole(role: string, opts?: { name?: string; exact?: boolean }): LdLocator;
  locator(selector: string): LdLocator;
  innerText(opts?: { timeout?: number }): Promise<string>;
  inputValue(opts?: { timeout?: number }): Promise<string>;
  evaluate<T>(fn: (el: any) => T, arg?: unknown, opts?: { timeout?: number }): Promise<T>;
  click(opts?: { timeout?: number }): Promise<void>;
  fill(text: string, opts?: { timeout?: number }): Promise<void>;
  // Viewport box of the element (works inside a closed shadow root); null when it is not shown.
  boundingBox(opts?: { timeout?: number }): Promise<LdBox | null>;
}
export interface LdBox { x: number; y: number; width: number; height: number }
export interface LdPage { getByRole(role: string, opts?: { name?: string; exact?: boolean }): LdLocator }

type DialogKindRole = 'dialog' | 'alertdialog';
// Container surfaces read through locators: dialogs, and open menus and listboxes (popovers, dropdowns).
type ContKind = DialogKindRole | 'menu' | 'listbox';
const isMenuKind = (k: ContKind): boolean => k === 'menu' || k === 'listbox';
// css: the control was found by CONTROL_CSS under the container (nth counts that list), not by the role tree.
interface Desc { dk: ContKind; di: number; slot: number; role: BcRole | 'dialog'; nth: number; css?: true }
interface Facts { name: string; type: string; ro: boolean; role: string; shown: boolean }

const clean = (s: unknown, max: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Runs inside the element: its accessible-name approximation and field facts. Only attributes and text.
const FACTS_FN = (el: any): Facts => {
  const a = (k: string): string => { const v = el.getAttribute ? el.getAttribute(k) : null; return v === null || v === undefined ? '' : String(v); };
  const tag = String(el.tagName || '').toLowerCase();
  const ar = a('role').trim().toLowerCase();
  const ty = a('type').trim().toLowerCase();
  const ce = a('contenteditable').trim().toLowerCase();
  const role = ar === 'button' || ar === 'link' || ar === 'textbox' ? ar
    : tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'textarea' ? 'textbox'
      : tag === 'input' ? (['button', 'submit', 'reset', 'image'].includes(ty) ? 'button' : ['hidden', 'checkbox', 'radio', 'file', 'range', 'color'].includes(ty) ? '' : 'textbox')
        : (el.hasAttribute ? el.hasAttribute('contenteditable') : false) && ce !== 'false' ? 'textbox' : '';
  const box = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  const inner = el.querySelector ? el.querySelector('[aria-label]') : null;
  const name = a('aria-label') || (inner ? String(inner.getAttribute('aria-label') || '') : '') || a('title') || String(el.innerText || el.textContent || '') || a('placeholder') || a('value');
  return { name, type: ty, ro: a('readonly') !== '', role, shown: !box || (box.width > 0 && box.height > 0) };
};

// Runs inside the first dialog: how many ancestors (the dialog included, shadow hosts followed) carry aria-hidden true,
// false or no attribute. Counts only.
const CHAIN_FN = (el: any): { true: number; false: number; absent: number } => {
  const out = { true: 0, false: 0, absent: 0 };
  for (let x = el, i = 0; x && i < 60; i++) {
    const v = x.getAttribute ? x.getAttribute('aria-hidden') : null;
    if (v === null || v === undefined) out.absent++;
    else if (String(v).trim().toLowerCase() === 'true') out.true++;
    else out.false++;
    const root = x.getRootNode ? x.getRootNode() : null;
    x = x.parentElement || (root && root.host) || null;
  }
  return out;
};

// empty: containers (`<kind>:<index>`) that are open but showed no control in this read.
interface ReadOut { nodes: RawNode[]; locatorDialogs: number; buttons: string[]; empty: string[] }
const inBox = (b: LdBox, x: number, y: number): boolean => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

export class LocatorDialogLayer {
  private descs = new Map<number, Desc>();
  constructor(private readonly lp: () => LdPage) {}

  has(n: number): boolean { return n >= LOCATOR_BASE && this.descs.has(n); }

  private dialogLoc(dk: ContKind, di: number): LdLocator { return this.lp().getByRole(dk).nth(di); }
  private loc(d: Desc): LdLocator {
    const dlg = this.dialogLoc(d.dk, d.di);
    if (d.role === 'dialog') return dlg;
    return d.css ? dlg.locator(CONTROL_CSS).nth(d.nth) : dlg.getByRole(d.role).nth(d.nth);
  }

  /** Visible dialogs (locator view) as [kind, index] pairs. */
  private async count(): Promise<{ dk: DialogKindRole; di: number }[]> {
    const out: { dk: DialogKindRole; di: number }[] = [];
    for (const dk of ['dialog', 'alertdialog'] as const) {
      let c = 0;
      try { c = await this.lp().getByRole(dk).count(); } catch { c = 0; }
      for (let i = 0; i < c && out.length < MAX_DIALOGS; i++) out.push({ dk, di: i });
    }
    return out;
  }

  /** Name of a dialog: aria-label, else its first heading. */
  private async dialogName(dk: DialogKindRole, di: number): Promise<string> {
    const dlg = this.dialogLoc(dk, di);
    try {
      const f = await dlg.evaluate((el: any) => String((el.getAttribute && el.getAttribute('aria-label')) || ''), undefined, { timeout: OP_TIMEOUT_MS });
      if (clean(f, MAX_NAME)) return clean(f, MAX_NAME);
    } catch { /* fall through */ }
    try {
      const h = dlg.getByRole('heading');
      if ((await h.count()) > 0) return clean(await h.first().innerText({ timeout: OP_TIMEOUT_MS }), MAX_NAME);
    } catch { /* unnamed */ }
    return '';
  }

  // How the controls of the last read were found: by the role tree, by the CSS fallback, or not at all (diag).
  path: 'role' | 'css' | 'none' = 'none';

  // One control as a node: footer flag for buttons, composer flag and current value for text fields.
  private async controlNode(n: number, role: BcRole, el: LdLocator, f: Facts, inDlg: { dialog: number; dialogName: string }, buttons: string[]): Promise<RawNode> {
    const node: RawNode = { n, role, name: clean(f.name, MAX_NAME), text: '', disabled: false, ...inDlg };
    if (role === 'button' || role === 'link') {
      // Every dialog button counts as a footer control: an unknown name stays irreversible_other.
      node.inFooter = true;
      buttons.push(node.name);
    }
    if (role === 'textbox') {
      if (f.type === 'password') node.secret = true;
      else {
        node.composer = true;
        try { node.value = String(await el.inputValue({ timeout: OP_TIMEOUT_MS })).slice(0, MAX_VALUE); } catch { node.value = ''; }
      }
    }
    return node;
  }

  /** Locator dialogs and open menus the walker did not see, as nodes. Never throws. */
  async read(walker: RawTree): Promise<ReadOut> {
    this.descs = new Map();
    this.path = 'none';
    const out = await this.readDialogs(walker);
    let menus: { nodes: RawNode[]; empty: string[] } = { nodes: [], empty: [] };
    try { menus = await this.readMenus(walker); } catch { menus = { nodes: [], empty: [] }; }
    return { ...out, nodes: [...out.nodes, ...menus.nodes], empty: [...out.empty, ...menus.empty] };
  }

  // Open menus (role menu) and listboxes as ordinary menuitem / option nodes without a dialog. An item the
  // walker already lists (same role and name) is skipped. Refs live until the next snapshot.
  private async readMenus(walker: RawTree): Promise<{ nodes: RawNode[]; empty: string[] }> {
    const seen = new Set(walker.nodes.filter((x) => x.role === 'menuitem' || x.role === 'option').map((x) => `${x.role}|${x.name}`));
    const nodes: RawNode[] = [];
    const empty: string[] = [];
    let m = 0;
    for (const [ck, role] of [['menu', 'menuitem'], ['listbox', 'option']] as const) {
      let c = 0;
      try { c = await this.lp().getByRole(ck).count(); } catch { c = 0; }
      for (let di = 0; di < c && m < MAX_MENUS; di++) {
        const slot = MAX_DIALOGS + m;
        const base = LOCATOR_BASE + slot * DIALOG_STRIDE;
        const cont = this.dialogLoc(ck, di);
        let ic = 0;
        try { ic = await cont.getByRole(role).count(); } catch { ic = 0; }
        if (ic === 0) empty.push(`${ck}:${di}`);
        let used = 0;
        for (let i = 0; i < Math.min(ic, MAX_MENU_ITEMS); i++) {
          let f: { name: string; type: string; ro: boolean };
          try { f = await cont.getByRole(role).nth(i).evaluate(FACTS_FN, undefined, { timeout: OP_TIMEOUT_MS }); } catch { continue; }
          const name = clean(f.name, MAX_NAME);
          if (seen.has(`${role}|${name}`)) continue;
          const n = base + used++;
          this.descs.set(n, { dk: ck, di, slot, role, nth: i });
          nodes.push({ n, role, name, text: '', disabled: false, region: 'menu' });
        }
        if (used > 0) m++;
      }
    }
    return { nodes, empty };
  }

  private async readDialogs(walker: RawTree): Promise<ReadOut> {
    const empty: ReadOut = { nodes: [], locatorDialogs: 0, buttons: [], empty: [] };
    let found: { dk: DialogKindRole; di: number }[];
    try { found = await this.count(); } catch { return empty; }
    if (found.length === 0) return empty;
    // A walker dialog counts only when it holds controls: a dialog shell whose content sits in a closed shadow root is
    // still read through locators.
    const walkerDialogs = walker.nodes.filter((d) => d.role === 'dialog'
      && walker.nodes.some((x) => x.dialog === d.n && (x.role === 'button' || x.role === 'link' || x.role === 'textbox'))).length;
    if (walkerDialogs >= found.length) return { ...empty, locatorDialogs: found.length };
    const nodes: RawNode[] = [];
    const buttons: string[] = [];
    const emptyDialogs: string[] = [];
    for (let d = 0; d < found.length; d++) {
      const { dk, di } = found[d];
      const base = LOCATOR_BASE + d * DIALOG_STRIDE;
      let seq = base;
      const dname = await this.dialogName(dk, di);
      const dn = seq++;
      this.descs.set(dn, { dk, di, slot: d, role: 'dialog', nth: 0 });
      nodes.push({ n: dn, role: 'dialog', name: dname, text: '', disabled: false, region: 'dialog' });
      let controls = 0;
      const inDlg = { dialog: dn, dialogName: dname };
      const dlg = this.dialogLoc(dk, di);
      // Visible text lines (the recipient name is read from here by the commit path).
      try {
        const txt = await dlg.innerText({ timeout: OP_TIMEOUT_MS });
        let k = 0;
        for (const line of String(txt).split('\n')) {
          const t = clean(line, MAX_TEXT);
          if (!t || k >= MAX_TEXT_LINES) continue;
          k++;
          nodes.push({ n: seq++, role: 'text', name: '', text: t, disabled: false, ...inDlg });
        }
      } catch { /* no text */ }
      for (const role of ['heading', 'button', 'link', 'textbox'] as const) {
        let c = 0;
        try { c = await dlg.getByRole(role).count(); } catch { c = 0; }
        for (let i = 0; i < Math.min(c, MAX_PER_ROLE); i++) {
          if (seq - base >= DIALOG_STRIDE - 1) break;
          const el = dlg.getByRole(role).nth(i);
          let f: Facts;
          try { f = await el.evaluate(FACTS_FN, undefined, { timeout: OP_TIMEOUT_MS }); } catch { continue; }
          const n = seq++;
          this.descs.set(n, { dk, di, slot: d, role, nth: i });
          if (role !== 'heading') controls++;
          nodes.push(await this.controlNode(n, role, el, f, inDlg, buttons));
        }
      }
      // The role tree listed no control (an aria-hidden ancestor, a shadow boundary it does not cross): read the controls
      // structurally with a CSS locator instead. Same node shape, refs and rules.
      if (controls === 0) {
        const all = dlg.locator(CONTROL_CSS);
        let c = 0;
        try { c = await all.count(); } catch { c = 0; }
        for (let i = 0; i < Math.min(c, MAX_PER_ROLE * 3); i++) {
          if (seq - base >= DIALOG_STRIDE - 1) break;
          const el = all.nth(i);
          let f: Facts;
          try { f = await el.evaluate(FACTS_FN, undefined, { timeout: OP_TIMEOUT_MS }); } catch { continue; }
          if (!f.shown || (f.role !== 'button' && f.role !== 'link' && f.role !== 'textbox')) continue;
          const n = seq++;
          this.descs.set(n, { dk, di, slot: d, role: f.role, nth: i, css: true });
          controls++;
          nodes.push(await this.controlNode(n, f.role, el, f, inDlg, buttons));
        }
        if (controls > 0) this.path = 'css';
      } else if (this.path !== 'css') this.path = 'role';
      if (controls === 0) emptyDialogs.push(`${dk}:${di}`);
    }
    return { nodes, locatorDialogs: found.length, buttons, empty: emptyDialogs };
  }

  /** Re-read one locator node live (name, value, dialog name); null when gone. */
  async describe(n: number): Promise<LiveNode | null> {
    const d = this.descs.get(n);
    if (!d) return null;
    try {
      const dlgCount = await this.lp().getByRole(d.dk).count();
      if (d.di >= dlgCount) return null;
      if (isMenuKind(d.dk)) {
        const mel = this.loc(d);
        if ((await mel.count()) === 0) return null;
        const mf = await mel.evaluate(FACTS_FN, undefined, { timeout: OP_TIMEOUT_MS });
        return { n, role: d.role as BcRole, name: clean(mf.name, MAX_NAME), text: '', disabled: false, region: 'menu' };
      }
      const dname = await this.dialogName(d.dk as DialogKindRole, d.di);
      const dn = LOCATOR_BASE + d.slot * DIALOG_STRIDE;
      if (d.role === 'dialog') return { n, role: 'dialog', name: dname, text: '', disabled: false, region: 'dialog' };
      const el = this.loc(d);
      if ((await el.count()) === 0) return null;
      const f = await el.evaluate(FACTS_FN, undefined, { timeout: OP_TIMEOUT_MS });
      const node: RawNode = { n, role: d.role as BcRole, name: clean(f.name, MAX_NAME), text: '', disabled: false, dialog: dn, dialogName: dname };
      if (d.role === 'button' || d.role === 'link') node.inFooter = true;
      if (d.role === 'textbox') {
        if (f.type === 'password') node.secret = true;
        else {
          node.composer = true;
          node.value = String(await el.inputValue({ timeout: OP_TIMEOUT_MS })).slice(0, MAX_VALUE);
        }
      }
      return node;
    } catch { return null; }
  }

  /**
   * The control of the last read under a viewport point, by locator boxes (the walker cannot see inside a closed shadow
   * root, so elementFromPoint finds nothing there). inside: the point lies on a locator dialog or menu: then ONLY this
   * answer counts (null when no control is under the point), never the walker's. Smallest box wins. Never throws.
   */
  async describeAt(x: number, y: number): Promise<{ inside: boolean; node: LiveNode | null }> {
    const none = { inside: false, node: null };
    try {
      const conts = new Map<string, Desc>();
      for (const d of this.descs.values()) conts.set(`${d.dk}:${d.di}`, d);
      let inside = false;
      for (const d of conts.values()) {
        const b = await this.dialogLoc(d.dk, d.di).boundingBox({ timeout: OP_TIMEOUT_MS }).catch(() => null);
        if (b && inBox(b, x, y)) { inside = true; break; }
      }
      if (!inside) return none;
      let best: { n: number; area: number } | null = null;
      for (const [n, d] of this.descs) {
        if (!POINT_ROLES.has(d.role)) continue;
        const b = await this.loc(d).boundingBox({ timeout: OP_TIMEOUT_MS }).catch(() => null);
        if (!b || b.width <= 0 || b.height <= 0 || !inBox(b, x, y)) continue;
        const area = b.width * b.height;
        if (!best || area < best.area) best = { n, area };
      }
      return { inside: true, node: best ? await this.describe(best.n) : null };
    } catch { return none; }
  }

  /** Counts of aria-hidden on the first locator dialog's ancestor chain (diag); null when there is no locator dialog. */
  async ariaHiddenChain(): Promise<{ true: number; false: number; absent: number } | null> {
    try {
      const f = (await this.count())[0];
      return f ? await this.dialogLoc(f.dk, f.di).evaluate(CHAIN_FN, undefined, { timeout: OP_TIMEOUT_MS }) : null;
    } catch { return null; }
  }

  /** Number of locator-visible dialogs right now (diag). */
  async countAll(): Promise<number> { return (await this.count()).length; }

  async click(n: number): Promise<void> {
    const d = this.descs.get(n);
    if (!d) throw new Error('browserctl: unknown locator node');
    await this.loc(d).click({ timeout: 5000 });
  }

  async fill(n: number, text: string): Promise<void> {
    const d = this.descs.get(n);
    if (!d || d.role !== 'textbox') throw new Error('browserctl: not a locator text field');
    if (typeof text !== 'string' || text.length > MAX_VALUE) throw new Error('browserctl: bad text');
    await this.loc(d).fill(text, { timeout: 5000 });
  }
}

/** Wrap a BcPage so dialogs visible only to locators show up in snapshots and can be described, clicked and filled. */
export function withLocatorDialogs(base: BcPage, lp: () => LdPage, opts: { fillPollMs?: number; fillMaxMs?: number } = {}): BcPage {
  // While the commit path watches an opening it polls for the dialog and its controls itself (one ceiling from the click),
  // so the snapshot reads once and never waits on its own.
  let watching = false;
  const layer = new LocatorDialogLayer(lp);
  const pollMs = Math.max(1, opts.fillPollMs ?? FILL_POLL_MS);
  const maxMs = opts.fillMaxMs ?? FILL_MAX_MS;
  let last: { dialogs: number; buttons: string[] } = { dialogs: 0, buttons: [] };
  // Containers that were still empty when the wait for their controls ended: not waited for again until they change.
  let spent = new Set<string>();
  const wrapped: BcPage = {
    ...base,
    async snapshot() {
      let t = await base.snapshot();
      let r = await layer.read(t);
      const pending = (): boolean => r.empty.some((k) => !spent.has(k));
      if (pending() && !watching) {
        // An open dialog or menu with no control yet is still filling in: re-read (bounded) until it lists some.
        const t0 = Date.now();
        let waited = 0;
        while (pending() && waited < maxMs && Date.now() - t0 < maxMs) {
          const step = Math.min(pollMs, maxMs - waited);
          await base.waitMs(step).catch(() => undefined);
          waited += step;
          t = await base.snapshot();
          r = await layer.read(t);
        }
      }
      spent = new Set(r.empty);
      last = { dialogs: r.locatorDialogs, buttons: r.buttons };
      return r.nodes.length === 0 ? t : { ...t, nodes: [...t.nodes, ...r.nodes] };
    },
    setOpenWatch(on) { watching = on; },
    waitMs: (ms) => base.waitMs(ms),
    async describeAt(x, y) {
      const r = await layer.describeAt(x, y);
      return r.inside ? r.node : base.describeAt(x, y);
    },
    async describe(n) { return layer.has(n) ? layer.describe(n) : base.describe(n); },
    async clickNode(n) { return layer.has(n) ? layer.click(n) : base.clickNode(n); },
    async fillNode(n, text) { return layer.has(n) ? layer.fill(n, text) : base.fillNode(n, text); },
    async diag(): Promise<PageDiag | null> {
      const pd = (await base.diag?.().catch(() => null)) ?? null;
      let count = last.dialogs;
      try { count = (await layer.countAll()); } catch { /* keep last */ }
      const chain = await layer.ariaHiddenChain();
      const extra = { locatorDialogs: count, locatorDialogButtons: last.buttons.slice(0, 12), locatorPath: layer.path, ...(chain ? { ariaHiddenChain: chain } : {}) };
      return pd ? { ...pd, ...extra } : { shadowRoots: 0, iframes: 0, closedHostCandidates: 0, dialogs: [], ...extra };
    },
  };
  if (base.robustClick) wrapped.robustClick = async (n) => (layer.has(n) ? layer.click(n) : base.robustClick!(n));
  return wrapped;
}
