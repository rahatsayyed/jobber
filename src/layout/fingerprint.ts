// Pure snapshot -> Observation reduction. No I/O. Only vocabulary ids and bucketed counts
// come out; page text (labels, names, options) is never copied or hashed.
import type { RawSnapshot } from '../linkedin/types.js';
import type { BlockKind } from '../linkedin/state.js';
import { classifyUrl } from '../linkedin/urls.js';
import type { LandmarkId, Observation, Platform } from './types.js';
import { ATS_CONTROL_KINDS, ATS_KINDS, actionLabelFor, isAtsPlatform } from './vocab.js';
import type { FormModel } from '../webcore/formModel.js';

// Structural copy of the Naukri RawSnapshot (src/mcp/naukri.ts); importing that module has side effects.
export interface NaukriRawSnapshot {
  title: string;
  url: string;
  buttons: string[];
  chatbot: {
    open: boolean;
    messages: { from: 'bot' | 'user'; text: string }[];
    placeholder: string | null;
    sendLabel: string | null;
    options: string[];
  };
  notices: string[];
  hasPasswordInput: boolean;
}

export const DEFAULT_UNLOADED_MAX_CHARS = 80;

// 0 -> 0, 1 -> 1, 2-3 -> 2, 4-7 -> 3, 8+ -> 4
export function bucket(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 2) return 1;
  if (n < 4) return 2;
  if (n < 8) return 3;
  return 4;
}

const STRUCTURE_KEYS = ['main', 'h1', 'h2', 'dialog', 'listitem', 'button', 'link', 'form'] as const;

const finish = (set: Set<LandmarkId>): LandmarkId[] => [...set].sort();

export function observeLinkedin(
  raw: RawSnapshot,
  block: BlockKind | null,
  opts: { unloadedMaxChars?: number } = {},
): Observation {
  const unloadedMax = opts.unloadedMaxChars ?? DEFAULT_UNLOADED_MAX_CHARS;
  const kind = classifyUrl(raw.url);
  const lm = new Set<LandmarkId>();
  const p = raw.profile;
  if (p) {
    if (p.name.trim()) lm.add('profile.name');
    if (p.headline.trim()) lm.add('profile.headline');
    if (p.degree !== null) lm.add('profile.degree');
    if (p.about?.trim()) lm.add('profile.about');
    if (p.hasBell) lm.add('profile.bell');
    if (p.pending) lm.add('profile.pending');
    if (p.hasMessageButton) lm.add('profile.message_button');
    for (const label of p.actions) {
      lm.add(actionLabelFor('linkedin', label));
    }
  }
  if (raw.results.length > 0) lm.add('results.cards');
  if (raw.invitations.length > 0) lm.add('invitations.rows');
  if (raw.messages.length > 0) lm.add('messages.thread');
  if (raw.messageHeaderName?.trim()) lm.add('message.header');
  if (raw.dialogText?.trim()) lm.add('dialog.open');
  if (raw.notices.length > 0) lm.add('notice.present');

  let nonDrift: Observation['nonDrift'] = null;
  if (block !== null && block !== 'session_expired') nonDrift = 'blocked';
  else if (block === 'session_expired' || raw.hasPasswordInput) nonDrift = 'logged_out';
  else if (raw.bodyText.length < unloadedMax && kind !== 'login' && kind !== 'checkpoint') nonDrift = 'unloaded';
  // A profile URL without an extracted profile name is "profile unavailable" or a sub-page such as
  // /in/x/recent-activity: not the layout of a profile page, so never drift and never learned.
  else if (kind === 'profile' && !(p && p.name.trim())) nonDrift = 'unloaded';

  const counts: Record<string, number> = {
    actions: bucket(p?.actions.length ?? 0),
    results: bucket(raw.results.length),
    invitations: bucket(raw.invitations.length),
    messages: bucket(raw.messages.length),
    notices: bucket(raw.notices.length),
  };
  const st = raw.structure;
  if (st) for (const k of STRUCTURE_KEYS) counts[k] = bucket(st[k]);

  // shell: page loaded as a known non-auth app kind (proxy), and, when structure counts are present,
  // it also has a <main> or at least one visible button or link (an empty frame is not a shell).
  const loaded = kind !== 'login' && kind !== 'checkpoint' && kind !== 'other' && raw.bodyText.length >= unloadedMax;
  const structured = !st || st.main >= 1 || st.button + st.link > 0;
  return {
    platform: 'linkedin',
    kind,
    landmarks: finish(lm),
    counts,
    shell: loaded && structured,
    nonDrift,
  };
}

// Akamai and generic error pages: tested on the title and notices only, never stored.
const ACCESS_DENIED_RE = /access denied|403 forbidden|request blocked|unusual traffic/i;
const ERROR_PAGE_RE = /\b(404|page not found|not found|500|internal server error|something went wrong|service unavailable)\b/i;

function naukriKind(url: string): string {
  let host = '';
  let path = '';
  let threaded = false;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
    // A thread is the inbox page with a thread id (threadUrl in src/mcp/naukri.ts).
    threaded = ['threadId', 'chatId', 'conversationId'].some((k) => u.searchParams.has(k));
  } catch {
    return 'other';
  }
  if (host !== 'naukri.com' && !host.endsWith('.naukri.com')) return 'other';
  if (/^\/(nlogin|login)(\/|$)/.test(path)) return 'login';
  if (path.startsWith('/job-listings-')) return 'job';
  if (path.startsWith('/mnjuser/inbox') || path.startsWith('/inbox')) return threaded ? 'thread' : 'inbox';
  if (/-jobs(-|$|\/)/.test(path) || path.startsWith('/jobs')) return 'search';
  if (path === '/' || path === '') return 'home';
  return 'other';
}

export function observeNaukri(raw: NaukriRawSnapshot, flags: { loginRequired: boolean }): Observation {
  const lm = new Set<LandmarkId>();
  for (const b of raw.buttons) {
    const t = b.trim().toLowerCase();
    if (t === 'apply') lm.add('button:apply');
    else if (t === 'applied') lm.add('button:applied');
    else if (t === 'save') lm.add('button:save');
    else if (t.startsWith('apply on company')) lm.add('button:company_site');
    else lm.add('button:other');
  }
  const c = raw.chatbot;
  if (c.open) lm.add('chat.open');
  if (c.placeholder !== null) lm.add('chat.input');
  if (c.sendLabel) lm.add('chat.send');
  if (c.options.length > 0) lm.add('chat.options');
  if (c.messages.length > 0) lm.add('chat.messages');
  if (raw.notices.length > 0) lm.add('notice.present');
  if (raw.hasPasswordInput) lm.add('login.password');

  const kind = naukriKind(raw.url);
  // Content-based page state (the URL alone says nothing about whether the page loaded).
  const hasContent = raw.title.trim().length > 0 || raw.buttons.length > 0
    || c.messages.length > 0 || c.placeholder !== null;
  const probe = [raw.title, ...raw.notices].join('\n');
  const denied = ACCESS_DENIED_RE.test(probe);
  const errorPage = ERROR_PAGE_RE.test(raw.title);
  const loginWall = kind === 'login' || raw.hasPasswordInput;

  let nonDrift: Observation['nonDrift'] = null;
  if (denied) nonDrift = 'blocked';
  else if (flags.loginRequired) nonDrift = 'logged_out';
  else if (kind !== 'other' && (!hasContent || errorPage)) nonDrift = 'unloaded';

  return {
    platform: 'naukri',
    kind,
    landmarks: finish(lm),
    counts: {
      buttons: bucket(raw.buttons.length),
      options: bucket(c.options.length),
      messages: bucket(c.messages.length),
      notices: bucket(raw.notices.length),
    },
    shell: kind !== 'other' && hasContent && !loginWall && !errorPage && !denied,
    nonDrift,
  };
}

// Browser-applier ATS pages (plan 8G-2 task 19): a form step reduced to field-role ids, control-kind ids
// and bucketed counts. Labels, options, notices, titles, URLs and selectors never enter the observation.
export function observeAts(model: FormModel, platform: Platform = 'ats_other'): Observation {
  const lm = new Set<LandmarkId>();
  const visible = model.fields.filter((f) => !f.hidden);
  for (const f of visible) lm.add(`field:${f.role}`);
  for (const c of model.controls) lm.add(`control:${(ATS_CONTROL_KINDS as readonly string[]).includes(c.kind) ? c.kind : 'other'}`);
  if (model.notices.length > 0) lm.add('notice.present');
  const kind = (ATS_KINDS as readonly string[]).includes(model.stepKind) ? model.stepKind : 'other';
  const empty = visible.length === 0 && model.controls.length === 0;
  let nonDrift: Observation['nonDrift'] = null;
  if (model.block) nonDrift = 'blocked';
  else if (empty) nonDrift = 'unloaded';
  return {
    platform: isAtsPlatform(platform) ? platform : 'ats_other',
    kind,
    landmarks: finish(lm),
    counts: {
      fields: bucket(visible.length),
      required: bucket(visible.filter((f) => f.required).length),
      buttons: bucket(model.controls.length),
      notices: bucket(model.notices.length),
    },
    shell: kind !== 'other' && !model.block && !empty,
    nonDrift,
  };
}
