// Closed vocabulary for layout memory. Anything not listed here can never appear in an
// observation, so page text cannot leak into the stored layout.
import type { KindId, LandmarkId, Platform } from './types.js';

export const ID_RE = /^[a-z0-9_.:-]{1,48}$/;
// One definition for run id handling, shared by store, classify and runtime.
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_RUN_IDS = 5;

export const KINDS: Record<Platform, readonly KindId[]> = {
  linkedin: ['profile', 'search', 'feed', 'messaging', 'invitations', 'jobs', 'login', 'checkpoint', 'other'],
  naukri: ['job', 'search', 'inbox', 'thread', 'login', 'home', 'other'],
};

export const ACTION_LABELS: Record<Platform, Record<string, string>> = {
  linkedin: {
    connect: 'action:connect',
    message: 'action:message',
    follow: 'action:follow',
    more: 'action:more',
    pending: 'action:pending',
    'send profile in a message': 'action:send_profile',
    'view in sales navigator': 'action:sales_nav',
  },
  naukri: {},
};

/**
 * Vocabulary id of an action label (own properties only, so `constructor` and `__proto__` are never
 * looked up on the prototype); anything outside the vocabulary is `action:other`.
 */
export function actionLabelFor(platform: Platform, text: string): string {
  const key = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const table = ACTION_LABELS[platform];
  return table && Object.hasOwn(table, key) ? table[key] : 'action:other';
}

export const LANDMARKS: Record<Platform, readonly LandmarkId[]> = {
  linkedin: [
    'profile.name', 'profile.headline', 'profile.degree', 'profile.about', 'profile.bell',
    'profile.pending', 'profile.message_button',
    ...Object.values(ACTION_LABELS.linkedin), 'action:other',
    'results.cards', 'invitations.rows', 'messages.thread', 'message.header', 'dialog.open', 'notice.present',
  ],
  naukri: [
    'button:apply', 'button:applied', 'button:save', 'button:company_site', 'button:other',
    'chat.open', 'chat.input', 'chat.send', 'chat.options', 'chat.messages',
    'notice.present', 'login.password',
  ],
};

// Count keys that may appear in Observation.counts.
// The last eight are LinkedIn structure counts (RawSnapshot.structure).
export const COUNT_KEYS: readonly string[] = [
  'actions', 'results', 'invitations', 'messages', 'notices', 'buttons', 'options',
  'main', 'h1', 'h2', 'dialog', 'listitem', 'button', 'link', 'form',
];

// Landmarks whose loss on a known kind means a tool cannot work (drift is critical).
export const CRITICAL: Record<Platform, Record<KindId, readonly LandmarkId[]>> = {
  linkedin: {
    profile: ['profile.name'],
    search: ['results.cards'],
    invitations: ['invitations.rows'],
  },
  // `job` has no entry: the apply button is absent on applied or company-site jobs, so the kind stays
  // `unknown` (never drift, never learned) until a safe landmark set exists.
  naukri: {
    thread: ['chat.input'],
  },
};

// Smallest landmark set a page of that kind is expected to show for layout to count as known.
export const MIN_SET: Record<Platform, Record<KindId, readonly LandmarkId[]>> = {
  linkedin: {
    profile: ['profile.name', 'profile.headline'],
    search: ['results.cards'],
    invitations: ['invitations.rows'],
  },
  naukri: {
    thread: ['chat.input'],
  },
};

// What each typed tool needs on the page before it acts.
export const TOOL_REQUIRES: Record<string, { kind: KindId; landmarks: readonly LandmarkId[] }> = {
  linkedin_check_connection_status: { kind: 'profile', landmarks: ['profile.name'] },
  linkedin_connect_send: { kind: 'profile', landmarks: ['profile.name', 'action:connect'] },
  linkedin_send_message: { kind: 'profile', landmarks: ['profile.name', 'profile.message_button'] },
  linkedin_find_profiles: { kind: 'search', landmarks: ['results.cards'] },
  // Discovery pages. `jobs` has no MIN_SET until a supervised learning run, so enforce refuses it as unverified.
  linkedin_search_jobs: { kind: 'jobs', landmarks: ['results.cards'] },
  linkedin_search_posts: { kind: 'search', landmarks: ['results.cards'] },
  linkedin_accept_invite: { kind: 'invitations', landmarks: ['invitations.rows'] },
  naukri_send_message: { kind: 'thread', landmarks: ['chat.input'] },
};
