// browserctl blocking overlay READ (LinkedIn). The operator (a Claude session) is the director: when a dialog or interstitial the flow did not
// expect is in the way ("Share your profile?", a prompt, a survey, an upsell), code only makes sure the operator SEES it, never a bare failure:
// title, text and buttons with refs, returned as `blocked_by_overlay` by every tool the dialog blocks. The operator reads it, decides what the
// intended task needs, clicks by ref (linkedin_click), and retries. See "Blocking dialogs" in .claude/agents/linkedin-operator.md.
//
// Code decides exactly one thing: a `human` dialog (captcha, verification code, login wall, payment, government ID, restriction, from
// config/overlay-rules.json, matched on name and text only). That one is `overlay_needs_human`: never clicked, the flow parks with the reason.
// Every irreversible commit stays behind its arm tool, caps, kill switch and dry run (unchanged): a dialog button that would send or submit is
// classified by the normal click guard like any other click. Nothing is typed here and no URL is touched.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../layout/config.js';
import { addEscalation } from '../outreach/service.js';
import type BetterSqlite3 from 'better-sqlite3';
import { dialogText, effectiveDialogKind } from './commit.js';
import { safeName } from './diag.js';
import type { BcPage } from './driver.js';
import type { RawNode, RawTree } from './snapshot.js';

export const OVERLAY_RULES_PATH = path.join(PROJECT_ROOT, 'config', 'overlay-rules.json');
export const OVERLAY_TEXT_MAX = 400;
export const OVERLAY_BUTTONS_MAX = 12;

// ---- human rules ----

export interface HumanRule { id: string; reason: string; title: RegExp[]; text: RegExp[] }
export interface OverlayRules { human: HumanRule[] }

const rx = (list: unknown, where: string): RegExp[] => {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`overlay rules: ${where} must be a list`);
  return list.map((s) => {
    if (typeof s !== 'string' || s.length === 0 || s.length > 300) throw new Error(`overlay rules: bad pattern in ${where}`);
    return new RegExp(s, 'i');
  });
};

/** Compile the rule file's JSON. Throws on a malformed entry (the loader then returns null: no dialog is treated as human, the operator still sees every one). */
export function parseOverlayRules(raw: unknown): OverlayRules {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.version !== 2) throw new Error('overlay rules: bad version');
  const ids = new Set<string>();
  const human = (Array.isArray(o.human) ? o.human : []).map((r: Record<string, unknown>) => {
    const id = String(r.id ?? '');
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(id) || ids.has(id)) throw new Error('overlay rules: bad or duplicate id');
    ids.add(id);
    const title = rx(r.title, `${id}.title`);
    const text = rx(r.text, `${id}.text`);
    if (title.length + text.length === 0) throw new Error(`overlay rules: ${id} matches nothing`);
    return { id, title, text, reason: String(r.reason ?? 'needs_human').replace(/[^\w]/g, '').slice(0, 30) || 'needs_human' };
  });
  return { human };
}

let cached: { file: string; rules: OverlayRules | null } | null = null;
export function loadOverlayRules(file: string = OVERLAY_RULES_PATH): OverlayRules | null {
  if (cached && cached.file === file) return cached.rules;
  let rules: OverlayRules | null = null;
  try { rules = parseOverlayRules(JSON.parse(readFileSync(file, 'utf8'))); } catch { rules = null; }
  cached = { file, rules };
  return rules;
}
export function resetOverlayRulesCache(): void { cached = null; }

/** The human rule a dialog matches, or null. Pure. */
export function humanRuleFor(title: string, text: string, rules: OverlayRules | null): HumanRule | null {
  if (!rules) return null;
  const t = title.trim();
  const hay = `${t}\n${text}`;
  return rules.human.find((r) => r.title.some((p) => p.test(t)) || r.text.some((p) => p.test(hay))) ?? null;
}

// ---- reading ----

export interface OverlayButton { name: string; /** The ref `s<epoch>.<n>` to click; null when the button is only known from the diag list (press Escape instead). */ ref: string | null }
export interface OverlayInfo {
  title: string;
  text: string;
  buttons: OverlayButton[];
  source: 'tree' | 'diag';
  human?: { rule: string; reason: string };
}


const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');
const clean = (s: string, max: number): string => s.replace(CONTROL, ' ').split(' ').filter(Boolean).join(' ').slice(0, max);

/** A dialog that belongs to the running flow (invite, message window, Easy Apply modal): not a blocker. */
export type ExpectedDialog = (tree: RawTree, dlg: RawNode) => boolean;
export const flowDialog: ExpectedDialog = (tree, d) => effectiveDialogKind(tree, d.n, d.name) !== 'other';
const DIAG_EXPECTED_RE = /invit|connect|add a note|personali[sz]e|messag|compose|conversation|inmail|chat|^apply to\b/i;

/**
 * The first dialog of the tree that the flow does not use, with its buttons as refs of the CURRENT epoch (`refOf`). When the tree shows no dialog
 * at all, the in-page diag list is the blind view (names only, no refs). Never throws.
 */
export async function readOverlay(
  page: BcPage, tree: RawTree | null, refOf: (n: number) => string | null, o: { rules?: OverlayRules | null; expected?: ExpectedDialog } = {},
): Promise<OverlayInfo | null> {
  const rules = o.rules !== undefined ? o.rules : loadOverlayRules();
  const expected = o.expected ?? flowDialog;
  try {
    const dialogs = tree ? tree.nodes.filter((x) => x.role === 'dialog') : [];
    if (tree) {
      for (const d of dialogs) {
        if (expected(tree, d)) continue;
        const buttons = tree.nodes.filter((x) => x.dialog === d.n && (x.role === 'button' || x.role === 'link') && x.name.trim() !== '')
          .slice(0, OVERLAY_BUTTONS_MAX).map((x) => ({ name: clean(x.name, 60), ref: x.n >= 0 ? refOf(x.n) : null }));
        const text = clean(dialogText(tree, d.n), OVERLAY_TEXT_MAX);
        const h = humanRuleFor(d.name, text, rules);
        return { title: clean(d.name, 80), text, buttons, source: 'tree', ...(h ? { human: { rule: h.id, reason: h.reason } } : {}) };
      }
      if (dialogs.length > 0) return null;
    }
    let pd: Awaited<ReturnType<NonNullable<BcPage['diag']>>> | null = null;
    try { pd = (await page.diag?.()) ?? null; } catch { pd = null; }
    for (const d of pd?.dialogs ?? []) {
      const name = String(d.name ?? '');
      const names = (d.buttons ?? []).map((b) => clean(String(b), 60)).filter(Boolean);
      if (!name && names.length === 0) continue;
      if (DIAG_EXPECTED_RE.test(name)) continue;
      const h = humanRuleFor(name, '', rules);
      return { title: clean(name, 80), text: '', buttons: names.slice(0, OVERLAY_BUTTONS_MAX).map((b) => ({ name: b, ref: null })), source: 'diag', ...(h ? { human: { rule: h.id, reason: h.reason } } : {}) };
    }
  } catch { /* a read that fails reports no overlay */ }
  return null;
}

/** A short lowercase title for a reason code: `share_your_profile`. */
export function titleSlug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30).replace(/_+$/g, '');
  return s || 'untitled';
}

/** Closed detail values for an EngineResult (the dialog the operator must look at; untrusted text is capped and control-free). */
export function overlayDetail(o: OverlayInfo): Record<string, string | number | boolean> {
  return {
    overlay_title: o.title,
    ...(o.text ? { overlay_text: o.text } : {}),
    overlay_buttons: o.buttons.map((b) => (b.ref ? `${b.ref}=${b.name}` : `(no ref)=${b.name}`)).join(' | '),
    overlay_source: o.source,
    ...(o.source === 'diag' ? { overlay_hint: 'buttons have no ref: press Escape with linkedin_press_key to dismiss' } : {}),
    ...(o.human ? { overlay_human: o.human.reason } : {}),
  };
}

/** Result code for a dialog: a human one parks, any other is for the operator to decide. */
export const overlayCode = (o: OverlayInfo): 'overlay_needs_human' | 'blocked_by_overlay' => (o.human ? 'overlay_needs_human' : 'blocked_by_overlay');

/** One-line reason with the dialog title and its button names (always present, never a bare failure). */
export function overlayReason(o: OverlayInfo): string {
  const btn = o.buttons.slice(0, 8).map((b) => safeName(b.name)).join(' | ');
  return o.human
    ? `dialog "${safeName(o.title)}" needs the owner (${o.human.reason}); never clicked`
    : `blocked by dialog "${safeName(o.title)}", buttons [${btn}]: read it, decide, click a button by ref, then retry`;
}

/** One owner notice (inbox escalation) for a human-only dialog. Never throws. */
export function escalateOverlay(d: { db: BetterSqlite3.Database; env: NodeJS.ProcessEnv; now: () => Date }, o: OverlayInfo, where: string): void {
  if (!o.human) return;
  try {
    addEscalation(d.db, {
      runId: d.env.JOBBER_RUN_ID ?? null, platform: 'linkedin', reason: `overlay:${o.human.reason}`,
      threadRef: `overlay:human_${o.human.rule}:${titleSlug(o.title)}`.slice(0, 120),
      detail: `LinkedIn showed a dialog only a person can solve during ${where}: "${safeName(o.title)}" (${o.human.reason}). Finish it by hand.`,
    }, d.now());
  } catch { /* the park still carries the reason */ }
}
