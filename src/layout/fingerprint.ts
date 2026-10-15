// Pure snapshot -> Observation reduction. No I/O. Only vocabulary ids and bucketed counts
// come out; page text (labels, names, options) is never copied or hashed.
import type { RawSnapshot } from '../linkedin/types.js';
import type { BlockKind } from '../linkedin/state.js';
import { classifyUrl } from '../linkedin/urls.js';
import type { LandmarkId, Observation } from './types.js';
import { ACTION_LABELS } from './vocab.js';

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
    if (p.about) lm.add('profile.about');
    if (p.hasBell) lm.add('profile.bell');
    if (p.pending) lm.add('profile.pending');
    if (p.hasMessageButton) lm.add('profile.message_button');
    for (const label of p.actions) {
      lm.add(ACTION_LABELS.linkedin[label.trim().toLowerCase()] ?? 'action:other');
    }
  }
  if (raw.results.length > 0) lm.add('results.cards');
  if (raw.invitations.length > 0) lm.add('invitations.rows');
  if (raw.messages.length > 0) lm.add('messages.thread');
  if (raw.messageHeaderName) lm.add('message.header');
  if (raw.dialogText) lm.add('dialog.open');
  if (raw.notices.length > 0) lm.add('notice.present');

  let nonDrift: Observation['nonDrift'] = null;
  if (block !== null && block !== 'session_expired') nonDrift = 'blocked';
  else if (block === 'session_expired' || raw.hasPasswordInput) nonDrift = 'logged_out';
  else if (raw.bodyText.length < unloadedMax && kind !== 'login' && kind !== 'checkpoint') nonDrift = 'unloaded';

  return {
    platform: 'linkedin',
    kind,
    landmarks: finish(lm),
    counts: {
      actions: bucket(p?.actions.length ?? 0),
      results: bucket(raw.results.length),
      invitations: bucket(raw.invitations.length),
      messages: bucket(raw.messages.length),
      notices: bucket(raw.notices.length),
    },
    // RawSnapshot has no nav/search-box field; a loaded, non-auth LinkedIn page stands in for the shell.
    shell: kind !== 'login' && kind !== 'checkpoint' && kind !== 'other' && raw.bodyText.length >= unloadedMax,
    nonDrift,
  };
}

function naukriKind(url: string): string {
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host !== 'naukri.com' && !host.endsWith('.naukri.com')) return 'other';
  if (/^\/(nlogin|login)(\/|$)/.test(path)) return 'login';
  if (path.startsWith('/job-listings-')) return 'job';
  if (path.startsWith('/mnjuser/inbox') || path.startsWith('/inbox')) return 'inbox';
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
    shell: kind !== 'other' && kind !== 'login',
    nonDrift: flags.loginRequired ? 'logged_out' : null,
  };
}
