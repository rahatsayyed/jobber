// browserctl guard: what does this click, key press or typed text DO? Pure functions, table-tested.
// A click is classified from the element re-read live at the moment of the action (role, accessible
// name, enclosing dialog, footer, submit, href), never from what the model believes it clicked.
// Fail closed: a submit button, or any button in a dialog footer, whose name is not on the known-safe
// list is irreversible_other. English labels are required; EXTRA_LABELS holds a short extension list.
import type { LiveNode } from './snapshot.js';

export type Platform = 'linkedin' | 'naukri' | 'wellfound' | 'scout';
export type ActionClass =
  | 'free'
  | 'commit_connect_send'
  | 'commit_message_send'
  | 'commit_accept_invite'
  | 'naukri_send'
  | 'naukri_apply'
  | 'wellfound_send'
  | 'wellfound_apply'
  | 'irreversible_other';
export type CommitClass = Exclude<ActionClass, 'free' | 'irreversible_other'>;
export type DialogKind = 'invite' | 'message' | 'other';

export interface GuardInput {
  platform: Platform;
  role: string;
  name: string;
  dialogName?: string | null;
  dialogKind?: DialogKind | null;
  /** The target is a composer field, or sits inside a composer form (message overlay, chatbot). */
  inComposer?: boolean;
  isSubmit?: boolean;
  inFooter?: boolean;
  href?: string | null;
  /** Page kind from the platform layer, for example 'thread' on a Naukri conversation. */
  pageKind?: string | null;
  /** The target was found by a point (click_at): a non-actionable element in a dialog footer fails closed. */
  viaPoint?: boolean;
}

// One const for the non-English extension list (labels, lower case, already normalised).
export const EXTRA_LABELS = {
  send: ['senden', 'envoyer', 'enviar', 'भेजें'],
  connect: ['verbinden', 'se connecter', 'conectar', 'कनेक्ट करें'],
  accept: ['annehmen', 'accepter', 'aceptar', 'स्वीकार करें'],
};

const INVISIBLE = new RegExp('[\\u200b-\\u200f\\u2060\\ufeff]', 'g');
const NBSP = new RegExp('\\u00a0', 'g');

export function normName(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!…:]+$/g, '')
    .trim();
}

export function dialogKindOf(dialogName: string | null | undefined): DialogKind | null {
  const n = normName(dialogName);
  if (!n) return null;
  if (/invit|connect|add a note|personali[sz]e|how do you know/.test(n)) return 'invite';
  if (/messag|compose|conversation|inmail|chat/.test(n)) return 'message';
  return 'other';
}

const ACTION_ROLES = new Set(['button', 'link', 'menuitem', 'tab']);
const SAFE_NAMES = new Set([
  'cancel', 'close', 'dismiss', 'back', 'next', 'previous', 'add a note', 'more', 'search',
]);

const ACCEPT_RE = new RegExp(`^(?:accept|${EXTRA_LABELS.accept.join('|')})(?: invitation)?(?: from .+)?$`);
const CONNECT_RE = new RegExp(`^(?:connect|${EXTRA_LABELS.connect.join('|')})$|^invite .+ to connect$`);
const SEND_CONNECT_RE = /^send (?:an? )?(?:invitation|invite|without a note)\b/;
const SEND_RE = new RegExp(`^(?:send|${EXTRA_LABELS.send.join('|')})\\b`);
const NAUKRI_APPLY_RE = /^(?:apply|apply now|easy apply)$/;
const NAUKRI_OFFSITE_RE = /^apply on (?:the )?company(?:'s)? (?:site|website)\b/;
const NAUKRI_SEND_RE = /^(?:send|send message)$/;
const NAUKRI_CHATBOT_RE = /^(?:save|submit|continue|done)$/;
const IRREVERSIBLE_RE = new RegExp(
  '^(?:submit|apply|easy apply|sign in|sign up|log in|login|register|create account|follow|unfollow|like|react|repost|'
  + 'share|post|delete|remove|withdraw|ignore|decline|block|report|endorse|recommend|subscribe|buy|pay|purchase|'
  + 'invite|disconnect|unsend|join|send|accept|connect|mute|verbinden|senden|annehmen)\\b',
);
// Menu items (the profile More dropdown) that only open a view or file and change no state.
const MENU_FREE_RE = /^(?:message|save to pdf|share|share profile(?: in a message)?|copy link to profile|about this profile)$/;
const DANGEROUS_HREF_RE = /(?:log-?out|sign-?out|signout|delete|withdraw|\/accept\b|action=(?:accept|send|connect|delete)|\/unfollow)/i;

/** The Naukri Apply button itself (as opposed to a chatbot step control). */
export const isNaukriApplyName = (name: string): boolean => NAUKRI_APPLY_RE.test(normName(name));

// Wellfound: the job page "Apply" button (counted once), the application form's "Submit application" /
// "Send application" step control, and the thread composer's "Send". "Apply on company site" and similar
// off-site apply links are never clicked. English labels only: a page in another language fails closed
// (an unknown dialog-footer or submit button is irreversible_other).
const WELLFOUND_APPLY_RE = /^(?:apply|apply now)$/;
const WELLFOUND_OFFSITE_RE = /^apply (?:on|at|via|through) (?:the )?(?:company(?:'s)? )?(?:site|website)\b|^apply externally\b/;
const WELLFOUND_SUBMIT_RE = /^(?:submit application|send application|submit your application|apply to .+)$/;
const WELLFOUND_SEND_RE = /^(?:send|send message)$/;
const WELLFOUND_STEP_RE = /^(?:submit|continue|done|next)$/;

/** The Wellfound Apply button itself (as opposed to a form step control such as Submit application). */
export const isWellfoundApplyName = (name: string): boolean => WELLFOUND_APPLY_RE.test(normName(name));

/** Classify one click-like action (click, click_at, Space or Enter on a focused control). */
export function classify(input: GuardInput): ActionClass {
  const name = normName(input.name);
  const dk = input.dialogKind ?? dialogKindOf(input.dialogName);
  const inDialog = dk !== null;
  const composerCtx = !!input.inComposer;
  const submit = !!input.isSubmit;
  const platform = input.platform;

  // A listbox option on LinkedIn that carries a connect, accept or state-changing name is treated like a button of that name.
  const optionAction = input.role === 'option' && platform === 'linkedin'
    && (CONNECT_RE.test(name) || SEND_CONNECT_RE.test(name) || ACCEPT_RE.test(name) || IRREVERSIBLE_RE.test(name));
  if (!ACTION_ROLES.has(input.role) && !optionAction) {
    // Fields, checkboxes, headings and plain text do not act by being clicked. A point that lands on
    // something non-actionable inside a dialog footer may still hit a scripted button: fail closed.
    if (input.viaPoint && input.inFooter && inDialog) return 'irreversible_other';
    return 'free';
  }

  if (input.role === 'link' && input.href && DANGEROUS_HREF_RE.test(input.href)) return 'irreversible_other';

  if (platform === 'linkedin') {
    if (ACCEPT_RE.test(name)) return 'commit_accept_invite';
    if (CONNECT_RE.test(name) || SEND_CONNECT_RE.test(name)) return 'commit_connect_send';
    if (SEND_RE.test(name)) {
      if (dk === 'invite') return 'commit_connect_send';
      if (dk === 'message') return 'commit_message_send';
      if (composerCtx) return 'commit_message_send';
      return 'irreversible_other';
    }
    if (name === 'message') {
      // The profile Message button opens a composer. A button of that name in a dialog footer or a
      // form submit is the composer's own send control.
      if (inDialog && (input.inFooter || submit)) return 'commit_message_send';
      return 'free';
    }
  } else if (platform === 'naukri') {
    if (NAUKRI_OFFSITE_RE.test(name)) return 'irreversible_other';
    if (NAUKRI_APPLY_RE.test(name)) return 'naukri_apply';
    if (NAUKRI_SEND_RE.test(name)) {
      if (input.pageKind === 'thread') return 'naukri_send';
      if (inDialog || composerCtx) return 'naukri_apply';
      return 'irreversible_other';
    }
    if (NAUKRI_CHATBOT_RE.test(name)) return inDialog || composerCtx ? 'naukri_apply' : 'irreversible_other';
  } else if (platform === 'wellfound') {
    if (WELLFOUND_OFFSITE_RE.test(name)) return 'irreversible_other';
    if (WELLFOUND_APPLY_RE.test(name) || WELLFOUND_SUBMIT_RE.test(name)) return 'wellfound_apply';
    if (WELLFOUND_SEND_RE.test(name)) {
      if (input.pageKind === 'thread') return 'wellfound_send';
      if (inDialog || composerCtx) return 'wellfound_apply';
      return 'irreversible_other';
    }
    if (WELLFOUND_STEP_RE.test(name)) return inDialog || composerCtx ? 'wellfound_apply' : 'irreversible_other';
  }

  if (input.role === 'menuitem' && platform === 'linkedin' && MENU_FREE_RE.test(name)) return 'free';
  if (IRREVERSIBLE_RE.test(name)) return 'irreversible_other';
  if (SAFE_NAMES.has(name)) return 'free';
  if (submit) return 'irreversible_other';
  if (inDialog && input.inFooter) return 'irreversible_other';
  return 'free';
}

/**
 * Class of a key press on the focused element. Enter or Space on a focused control is a click of it;
 * Enter in a composer field is the composer's Send. Other keys (Escape, Tab, arrows, paging) are free.
 */
export function classifyKey(input: GuardInput & { key: string }): ActionClass {
  const key = input.key;
  if (key !== 'Enter' && key !== 'Space') return 'free';
  if (ACTION_ROLES.has(input.role)) return classify(input);
  if (input.role === 'textbox' && key === 'Enter') {
    if (!input.inComposer) return input.isSubmit ? 'irreversible_other' : 'free';
    const dk = input.dialogKind ?? dialogKindOf(input.dialogName);
    if (input.platform === 'naukri') return input.pageKind === 'thread' ? 'naukri_send' : 'naukri_apply';
    if (input.platform === 'wellfound') return input.pageKind === 'thread' ? 'wellfound_send' : 'wellfound_apply';
    if (input.platform === 'linkedin') return dk === 'invite' ? 'commit_connect_send' : 'commit_message_send';
    return 'irreversible_other';
  }
  return 'free';
}

/** Build the classifier input from a node re-read live. */
export function guardInputOf(node: LiveNode, platform: Platform, pageKind?: string | null, viaPoint = false, dialogKind?: DialogKind | null): GuardInput {
  return {
    ...(dialogKind ? { dialogKind } : {}),
    platform,
    role: node.role,
    name: node.name,
    dialogName: node.dialogName ?? null,
    inComposer: !!node.composer,
    isSubmit: !!node.submit,
    inFooter: !!node.inFooter,
    href: node.href ?? null,
    pageKind: pageKind ?? null,
    viaPoint,
  };
}

export type PointClass =
  | { ok: true; cls: ActionClass; node: LiveNode }
  | { ok: false; code: 'unresolvable_point' };

/** click_at: resolve the element under the point (with its enclosing button or link) and classify it the same way. */
export async function classifyPoint(
  page: { describeAt(x: number, y: number): Promise<LiveNode | null> },
  platform: Platform,
  pageKind: string | null,
  x: number,
  y: number,
  /** Kind of the node's enclosing dialog when its name says nothing (LinkedIn: by its invite controls), as doClick does. */
  kindOf?: (node: LiveNode) => DialogKind | null,
): Promise<PointClass> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return { ok: false, code: 'unresolvable_point' };
  const node = await page.describeAt(x, y);
  if (!node) return { ok: false, code: 'unresolvable_point' };
  return { ok: true, cls: classify(guardInputOf(node, platform, pageKind, true, kindOf?.(node))), node };
}

// ---- type guard ----
export const MAX_PLAIN_TYPE = 200;
export const MAX_CHATBOT_TYPE = 500;
const URL_RE = /(?:https?:\/\/|www\.)/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const SECRET_RE = /[A-Za-z0-9_-]{32,}/;

export type TypeCheck =
  | { ok: true; mode: 'composer' | 'chatbot' | 'plain' }
  | { ok: false; code: 'secret_field' | 'not_a_text_field' | 'no_armed_intent' | 'intent_text_mismatch' | 'text_too_long' | 'text_not_allowed'; reason: string };

/** Equality for armed text against what a field holds: line endings and one trailing newline are not differences. */
export function textMatches(expected: string, actual: string): boolean {
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/\n$/, '');
  return norm(expected) === norm(actual);
}

/**
 * May this text be typed into this field? Composer fields need an armed intent and the exact armed text
 * (a naukri_apply intent allows chatbot answers instead, capped and output-gated). Other fields take
 * short text with no URL, email or secret-shaped token. Password-like and unknown fields never.
 */
export function checkType(
  node: LiveNode,
  text: string,
  armed: { class: CommitClass; text: string | null } | null,
): TypeCheck {
  if (node.secret || (node.role === 'textbox' && node.value === undefined && node.name.toLowerCase().includes('password'))) {
    return { ok: false, code: 'secret_field', reason: 'password-like fields are never typed into' };
  }
  if (node.role !== 'textbox' && node.role !== 'searchbox') {
    return { ok: false, code: 'not_a_text_field', reason: 'target is not a text field' };
  }
  if (node.composer) {
    if (!armed) return { ok: false, code: 'no_armed_intent', reason: 'composer text needs an armed intent' };
    if (armed.class === 'naukri_apply') return plainCheck(text, MAX_CHATBOT_TYPE, 'chatbot');
    if (armed.class === 'wellfound_apply') {
      // The application note: only the exact text armed (and gated) by wellfound_arm_apply, never a free answer.
      if (armed.text === null) return { ok: false, code: 'text_not_allowed', reason: 'no note was armed for this application; leave the note empty' };
      if (!textMatches(armed.text, text)) return { ok: false, code: 'intent_text_mismatch', reason: 'text differs from the armed note' };
      return { ok: true, mode: 'composer' };
    }
    if (armed.text === null || !textMatches(armed.text, text)) {
      return { ok: false, code: 'intent_text_mismatch', reason: 'text differs from the armed text' };
    }
    return { ok: true, mode: 'composer' };
  }
  return plainCheck(text, MAX_PLAIN_TYPE, 'plain');
}

function plainCheck(text: string, max: number, mode: 'chatbot' | 'plain'): TypeCheck {
  if (text.length > max) return { ok: false, code: 'text_too_long', reason: `text is over ${max} characters` };
  if (URL_RE.test(text) || EMAIL_RE.test(text) || SECRET_RE.test(text)) {
    return { ok: false, code: 'text_not_allowed', reason: 'URLs, emails and secret-shaped text are not typed' };
  }
  return { ok: true, mode };
}
