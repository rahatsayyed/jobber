// browserctl locator dialog layer. LinkedIn renders the invite modal inside a CLOSED shadow root: the
// in-page DOM walker (page.evaluate) cannot see it, but Patchright locators (getByRole, chaining, evaluate on
// the located element, innerText, inputValue, fill, click) can. This layer reads such dialogs through
// locators and adds them to the snapshot as ordinary nodes (role, name, dialog, dialogName, value) with
// ordinals >= LOCATOR_BASE. Everything above it (refs and epochs, the guard, re-describe at click, the commit
// path, the armed intent checks) sees the same node shape as before and is unchanged. Nodes are mapped to
// locator descriptors (dialog scope, role, nth), never to data-bc ordinals. The model never passes a selector.
// Applies only when the walker saw fewer dialogs than the locators did (the walker wins when it sees them).
import type { BcPage } from './driver.js';
import type { PageDiag } from './diag.js';
import { MAX_NAME, MAX_TEXT, MAX_VALUE, type BcRole, type LiveNode, type RawNode, type RawTree } from './snapshot.js';

/** Ordinals of locator nodes start here (walker ordinals stay below MAX_NODES). */
export const LOCATOR_BASE = 60000;
const DIALOG_STRIDE = 1000;
const MAX_DIALOGS = 3;
const MAX_PER_ROLE = 20;
const MAX_TEXT_LINES = 40;
const OP_TIMEOUT_MS = 1500;

/** Structural subset of a Patchright locator used here. */
export interface LdLocator {
  count(): Promise<number>;
  nth(i: number): LdLocator;
  first(): LdLocator;
  getByRole(role: string, opts?: { name?: string; exact?: boolean }): LdLocator;
  innerText(opts?: { timeout?: number }): Promise<string>;
  inputValue(opts?: { timeout?: number }): Promise<string>;
  evaluate<T>(fn: (el: any) => T, arg?: unknown, opts?: { timeout?: number }): Promise<T>;
  click(opts?: { timeout?: number }): Promise<void>;
  fill(text: string, opts?: { timeout?: number }): Promise<void>;
}
export interface LdPage { getByRole(role: string, opts?: { name?: string; exact?: boolean }): LdLocator }

type DialogKindRole = 'dialog' | 'alertdialog';
interface Desc { dk: DialogKindRole; di: number; slot: number; role: BcRole | 'dialog'; nth: number }

const clean = (s: unknown, max: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Runs inside the element: its accessible-name approximation and field facts. Only attributes and text.
const FACTS_FN = (el: any): { name: string; type: string; ro: boolean } => {
  const a = (k: string): string => { const v = el.getAttribute ? el.getAttribute(k) : null; return v === null || v === undefined ? '' : String(v); };
  const name = a('aria-label') || a('title') || String(el.innerText || el.textContent || '') || a('placeholder') || a('value');
  return { name, type: a('type').toLowerCase(), ro: a('readonly') !== '' };
};

interface ReadOut { nodes: RawNode[]; locatorDialogs: number; buttons: string[] }

export class LocatorDialogLayer {
  private descs = new Map<number, Desc>();
  constructor(private readonly lp: () => LdPage) {}

  has(n: number): boolean { return n >= LOCATOR_BASE && this.descs.has(n); }

  private dialogLoc(dk: DialogKindRole, di: number): LdLocator { return this.lp().getByRole(dk).nth(di); }
  private loc(d: Desc): LdLocator {
    const dlg = this.dialogLoc(d.dk, d.di);
    return d.role === 'dialog' ? dlg : dlg.getByRole(d.role).nth(d.nth);
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

  /** Locator dialogs the walker did not see, as nodes. Never throws. */
  async read(walker: RawTree): Promise<ReadOut> {
    const empty: ReadOut = { nodes: [], locatorDialogs: 0, buttons: [] };
    let found: { dk: DialogKindRole; di: number }[];
    try { found = await this.count(); } catch { return empty; }
    this.descs = new Map();
    if (found.length === 0) return empty;
    const walkerDialogs = walker.nodes.filter((x) => x.role === 'dialog').length;
    if (walkerDialogs >= found.length) return { ...empty, locatorDialogs: found.length };
    const nodes: RawNode[] = [];
    const buttons: string[] = [];
    for (let d = 0; d < found.length; d++) {
      const { dk, di } = found[d];
      const base = LOCATOR_BASE + d * DIALOG_STRIDE;
      let seq = base;
      const dname = await this.dialogName(dk, di);
      const dn = seq++;
      this.descs.set(dn, { dk, di, slot: d, role: 'dialog', nth: 0 });
      nodes.push({ n: dn, role: 'dialog', name: dname, text: '', disabled: false });
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
          let f: { name: string; type: string; ro: boolean };
          try { f = await el.evaluate(FACTS_FN, undefined, { timeout: OP_TIMEOUT_MS }); } catch { continue; }
          const n = seq++;
          this.descs.set(n, { dk, di, slot: d, role, nth: i });
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
          nodes.push(node);
        }
      }
    }
    return { nodes, locatorDialogs: found.length, buttons };
  }

  /** Re-read one locator node live (name, value, dialog name); null when gone. */
  async describe(n: number): Promise<LiveNode | null> {
    const d = this.descs.get(n);
    if (!d) return null;
    try {
      const dlgCount = await this.lp().getByRole(d.dk).count();
      if (d.di >= dlgCount) return null;
      const dname = await this.dialogName(d.dk, d.di);
      const dn = LOCATOR_BASE + d.slot * DIALOG_STRIDE;
      if (d.role === 'dialog') return { n, role: 'dialog', name: dname, text: '', disabled: false };
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
export function withLocatorDialogs(base: BcPage, lp: () => LdPage): BcPage {
  const layer = new LocatorDialogLayer(lp);
  let last: { dialogs: number; buttons: string[] } = { dialogs: 0, buttons: [] };
  const wrapped: BcPage = {
    ...base,
    async snapshot() {
      const t = await base.snapshot();
      const r = await layer.read(t);
      last = { dialogs: r.locatorDialogs, buttons: r.buttons };
      return r.nodes.length === 0 ? t : { ...t, nodes: [...t.nodes, ...r.nodes] };
    },
    async describe(n) { return layer.has(n) ? layer.describe(n) : base.describe(n); },
    async clickNode(n) { return layer.has(n) ? layer.click(n) : base.clickNode(n); },
    async fillNode(n, text) { return layer.has(n) ? layer.fill(n, text) : base.fillNode(n, text); },
    async diag(): Promise<PageDiag | null> {
      const pd = (await base.diag?.().catch(() => null)) ?? null;
      let count = last.dialogs;
      try { count = (await layer.countAll()); } catch { /* keep last */ }
      const extra = { locatorDialogs: count, locatorDialogButtons: last.buttons.slice(0, 12) };
      return pd ? { ...pd, ...extra } : { shadowRoots: 0, iframes: 0, closedHostCandidates: 0, dialogs: [], ...extra };
    },
  };
  if (base.robustClick) wrapped.robustClick = async (n) => (layer.has(n) ? layer.click(n) : base.robustClick!(n));
  return wrapped;
}
