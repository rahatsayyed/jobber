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
import type { LiveNode, RawTree } from './snapshot.js';

export const DIAG_MAX_BYTES = 8 * 1024;
const NAME_MAX = 60;

/** What the in-page diag script returns (all counts and short names). */
export interface PageDiag {
  shadowRoots: number;
  iframes: number;
  closedHostCandidates: number;
  dialogs: { role: string; name: string; buttons: string[] }[];
}

export interface DiagDeps {
  now: () => Date;
  /** Directory for diag files (default: <project>/.jobber/diag). */
  diagDir?: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');
const PHONE_RE =/\+?\d[\d\s().-]{6,}\d/g;

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
  i: { platform: string; code: string; live: Pick<LiveNode, 'role' | 'name'>; urlBefore: string; after: RawTree | null },
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
