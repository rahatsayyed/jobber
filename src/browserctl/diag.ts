// Structural failure diagnostics for commit clicks that end unconfirmed (no dialog after Connect, no
// confirmation after Apply or Send). One small JSON file per failure under .jobber/diag (git-ignored,
// dir 0700, file 0600) that holds STRUCTURE ONLY: the url path without query, whether the url changed,
// how many open shadow roots and iframes the page has, the clicked control's role and short name, and
// the open dialogs with their button names. Never typed text, message text, field values or page prose.
// Anything email- or phone-like is redacted and the file is capped at 8 KB. Writing never throws and
// never changes the result of the action: it only adds the file path to the reason string.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../layout/config.js';
import type { BcPage } from './driver.js';
import type { SendFacts } from './sendSignals.js';
import { LOCATOR_BASE, type LiveNode, type RawTree } from './snapshot.js';

export const DIAG_MAX_BYTES = 8 * 1024;
const NAME_MAX = 60;

/** Counts of the visible links of a popup by where their label sits: on the link, on a descendant, in its text, or nowhere. */
export interface LinkRowLabels { own: number; desc: number; text: number; none: number }

/** What the in-page diag script returns (all counts and short names). */
export interface PageDiag {
  shadowRoots: number;
  iframes: number;
  closedHostCandidates: number;
  dialogs: { role: string; name: string; buttons: string[] }[];
  /** Controls that announce an open popup (aria-expanded true): tag, role, aria-haspopup, whether aria-controls names an element, tag/role of its first descendants. */
  expanded?: { tag: string; role: string; popup: string; controls: number; found: number; kids: string[]; rows?: LinkRowLabels }[];
  /** Locator view (Patchright getByRole): dialogs it sees and their button names. Absent when the layer is off. */
  locatorDialogs?: number;
  locatorDialogButtons?: string[];
  /** How the locator layer found the dialog controls: role tree, CSS fallback, or none. */
  locatorPath?: 'role' | 'css' | 'none';
  /** Counts of aria-hidden true / false / absent on the first dialog's ancestor chain (shadow hosts followed). */
  ariaHiddenChain?: { true: number; false: number; absent: number };
}

/** What the commit path adds to a missing-controls diag: how long it polled, and the node-cap state of the last read. */
export interface OpenWaitFacts { waitedMs: number }

export interface DiagDeps {
  now: () => Date;
  /** Directory for diag files (default: <project>/.jobber/diag). */
  diagDir?: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

/** Short, control-free, redacted name. */
export function safeName(s: unknown): string {
  const t = String(s ?? '').replace(CONTROL, ' ').split(String.fromCharCode(32)).filter(Boolean).join(' ');
  return t.replace(EMAIL_RE, '[redacted]').replace(PHONE_RE, '[redacted]').slice(0, NAME_MAX);
}

const pathOf = (url: string): string => {
  try { return new URL(url).pathname.slice(0, 120); } catch { return 'unknown'; }
};

export interface DiagFile {
  platform: string;
  at: string;
  code: string;
  url_path: string;
  url_path_before: string;
  url_changed: boolean;
  clicked: { role: string; name: string };
  shadow_roots: number | null;
  iframes: number | null;
  closed_host_candidates: number | null;
  dialogs: { role: string; name: string; buttons: string[] }[];
  tree_dialogs: { name: string; buttons: string[] }[];
  tree_nodes: number | null;
  locator_dialogs: number | null;
  locator_dialog_buttons: string[];
  // Missing-controls structure (counts and enums only), next to shadow_roots (open roots the walker entered) and
  // closed_host_candidates: who found the dialog (walker, locator, both, none), how the locator read its controls, whether
  // the node cap was hit, aria-hidden values on the dialog's ancestor chain, and how long the commit path polled from the click.
  found_by: 'walker' | 'locator' | 'both' | 'none';
  locator_path: 'role' | 'css' | 'none' | null;
  node_cap_hit: boolean;
  aria_hidden_chain: { true: number; false: number; absent: number } | null;
  waited_ms: number | null;
  // Open popups (aria-expanded) with the tag/role structure of what they control; structure labels only.
  expanded_popups?: { tag: string; role: string; popup: string; controls: number; found: number; kids: string[]; rows: LinkRowLabels }[];
  // Naukri apply: pages the click opened (url path only, never the query) and apply-ish responses (path and status).
  popups?: { path: string; host_kind: 'naukri' | 'external' | 'unknown' }[];
  apply_responses?: { path: string; status: number }[];
  // Names of up to 10 buttons near the clicked control after the wait (names only, redacted).
  near_buttons?: string[];
  // After a Send click: which confirmations held (booleans and an enum, the re-read time in ms).
  send_check?: { strong: boolean; network: boolean; dialog_gone: boolean; error_signal: 'none' | 'limit' | 'error'; polled_ms: number };
}

// Extra structure for a commit click (Naukri apply).
export interface DiagExtra {
  popups?: { url: string }[];
  responses?: { path: string; status: number }[];
  nearButtons?: string[];
}

export const hostKind = (url: string): 'naukri' | 'external' | 'unknown' => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'naukri.com' || h.endsWith('.naukri.com') ? 'naukri' : 'external';
  } catch { return 'unknown'; }
};

// Names of up to 10 buttons near the clicked control (closest in document order). Names only, redacted.
export function nearButtonNames(tree: RawTree | null, clicked: Pick<LiveNode, 'role' | 'name'>): string[] {
  if (!tree) return [];
  const btns = tree.nodes.filter((x) => x.role === 'button' || x.role === 'link');
  const idx = btns.findIndex((x) => x.role === clicked.role && x.name === clicked.name);
  const order = btns.map((x, k) => ({ x, d: idx < 0 ? k : Math.abs(k - idx) }));
  return order.sort((a, b) => a.d - b.d).slice(0, 10).map((o) => safeName(o.x.name));
}

/** Dialogs and their button names from a snapshot tree (names only). */
export function treeDialogs(tree: RawTree | null): { name: string; buttons: string[] }[] {
  if (!tree) return [];
  const out: { name: string; buttons: string[] }[] = [];
  for (const d of tree.nodes) {
    if (d.role !== 'dialog') continue;
    const buttons = tree.nodes.filter((x) => x.dialog === d.n && (x.role === 'button' || x.role === 'link')).slice(0, 12).map((x) => safeName(x.name));
    out.push({ name: safeName(d.name), buttons });
    if (out.length >= 6) break;
  }
  return out;
}

/** Who found the dialogs of a tree: walker nodes (ordinal below LOCATOR_BASE), locator nodes, both, or none. */
export function dialogFoundBy(tree: RawTree | null): 'walker' | 'locator' | 'both' | 'none' {
  const ds = (tree?.nodes ?? []).filter((x) => x.role === 'dialog');
  const w = ds.some((x) => x.n < LOCATOR_BASE);
  const l = ds.some((x) => x.n >= LOCATOR_BASE);
  return w && l ? 'both' : w ? 'walker' : l ? 'locator' : 'none';
}

/** The first open dialog of a snapshot tree that lists no button, link or text field (its controls are not visible to the layers), or null. */
export function dialogWithoutControls(tree: RawTree | null): { role: 'dialog'; name: string } | null {
  if (!tree) return null;
  const d = tree.nodes.find((x) => x.role === 'dialog' && !tree.nodes.some((c) => c.dialog === x.n && (c.role === 'button' || c.role === 'link' || c.role === 'textbox')));
  return d ? { role: 'dialog', name: d.name } : null;
}

function fit(f: DiagFile): string {
  let s = JSON.stringify(f, null, 1);
  // Shrink the lists until the file fits (a pathological page must not grow the file).
  for (let guard = 0; s.length > DIAG_MAX_BYTES && guard < 20; guard++) {
    if (f.tree_dialogs.length > 1) f.tree_dialogs.pop();
    else if (f.dialogs.length > 1) f.dialogs.pop();
    else {
      for (const d of [...f.dialogs, ...f.tree_dialogs]) d.buttons = d.buttons.slice(0, Math.max(0, d.buttons.length - 3));
    }
    s = JSON.stringify(f, null, 1);
  }
  return s.length > DIAG_MAX_BYTES ? s.slice(0, DIAG_MAX_BYTES) : s;
}

/**
 * Write one diag file for a failed commit. Returns the path relative to the project (for the reason string)
 * or null when it could not be written. Never throws.
 */
export async function writeCommitDiag(
  deps: DiagDeps,
  page: BcPage,
  i: { platform: string; code: string; live: Pick<LiveNode, 'role' | 'name'>; urlBefore: string; after: RawTree | null; extra?: DiagExtra; wait?: OpenWaitFacts; send?: SendFacts },
): Promise<string | null> {
  try {
    let pd: PageDiag | null = null;
    try { pd = (await page.diag?.()) ?? null; } catch { pd = null; }
    const urlNow = (() => { try { return page.url(); } catch { return ''; } })();
    const file: DiagFile = {
      platform: i.platform,
      at: deps.now().toISOString(),
      code: i.code,
      url_path: pathOf(urlNow),
      url_path_before: pathOf(i.urlBefore),
      url_changed: urlNow.split(/[?#]/)[0] !== i.urlBefore.split(/[?#]/)[0],
      clicked: { role: safeName(i.live.role), name: safeName(i.live.name) },
      shadow_roots: pd ? Math.max(0, Math.floor(pd.shadowRoots)) : null,
      iframes: pd ? Math.max(0, Math.floor(pd.iframes)) : null,
      closed_host_candidates: pd ? Math.max(0, Math.floor(pd.closedHostCandidates)) : null,
      dialogs: (pd?.dialogs ?? []).slice(0, 6).map((d) => ({
        role: safeName(d.role), name: safeName(d.name), buttons: (d.buttons ?? []).slice(0, 12).map(safeName),
      })),
      tree_dialogs: treeDialogs(i.after),
      tree_nodes: i.after ? i.after.nodes.length : null,
      locator_dialogs: pd && typeof pd.locatorDialogs === 'number' ? Math.max(0, Math.floor(pd.locatorDialogs)) : null,
      locator_dialog_buttons: (pd?.locatorDialogButtons ?? []).slice(0, 12).map(safeName),
      found_by: dialogFoundBy(i.after),
      locator_path: pd?.locatorPath ?? null,
      node_cap_hit: i.after?.truncated === true,
      aria_hidden_chain: pd?.ariaHiddenChain
        ? { true: Math.floor(pd.ariaHiddenChain.true) || 0, false: Math.floor(pd.ariaHiddenChain.false) || 0, absent: Math.floor(pd.ariaHiddenChain.absent) || 0 }
        : null,
      waited_ms: i.wait ? Math.max(0, Math.floor(i.wait.waitedMs)) : null,
      ...(pd?.expanded && pd.expanded.length > 0 ? {
        expanded_popups: pd.expanded.slice(0, 4).map((e) => ({
          tag: safeName(e.tag), role: safeName(e.role), popup: safeName(e.popup),
          controls: Math.floor(e.controls) || 0, found: Math.floor(e.found) || 0, kids: (e.kids ?? []).slice(0, 12).map(safeName),
          rows: {
            own: Math.floor(e.rows?.own ?? 0) || 0, desc: Math.floor(e.rows?.desc ?? 0) || 0,
            text: Math.floor(e.rows?.text ?? 0) || 0, none: Math.floor(e.rows?.none ?? 0) || 0,
          },
        })),
      } : {}),
      ...(i.send ? { send_check: { strong: i.send.strong, network: i.send.network, dialog_gone: i.send.dialogGone, error_signal: i.send.signal, polled_ms: Math.max(0, Math.floor(i.send.polledMs)) } } : {}),
      ...(i.extra ? {
        popups: (i.extra.popups ?? []).slice(0, 5).map((p) => ({ path: pathOf(p.url), host_kind: hostKind(p.url) })),
        apply_responses: (i.extra.responses ?? []).slice(0, 10).map((r) => ({ path: String(r.path).split('?')[0].slice(0, 120), status: Math.floor(Number(r.status)) || 0 })),
        near_buttons: (i.extra.nearButtons ?? []).slice(0, 10).map(safeName),
      } : {}),
    };
    const dir = deps.diagDir ?? path.join(PROJECT_ROOT, '.jobber', 'diag');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
    let target = path.join(dir, `${i.platform}-${stamp}.json`);
    for (let n = 1; existsSync(target) && n < 100; n++) target = path.join(dir, `${i.platform}-${stamp}-${n}.json`);
    writeFileSync(target, fit(file), { mode: 0o600 });
    try { chmodSync(target, 0o600); } catch { /* best effort */ }
    const rel = path.relative(PROJECT_ROOT, target);
    return rel.startsWith('..') ? target : rel;
  } catch {
    return null;
  }
}

/** Reason suffix for a result: ' (diag: <path>)' or ''. */
export const diagNote = (p: string | null): string => (p ? ` (diag: ${p})` : '');
