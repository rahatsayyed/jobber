// Closed vocabulary for layout memory. Anything not listed here can never appear in an
// observation, so page text cannot leak into the stored layout.
import type { AtsPlatform, BasePlatform, KindId, LandmarkId, Platform } from './types.js';
import { FIELD_ROLES } from '../webcore/formModel.js';

export const ID_RE = /^[a-z0-9_.:-]{1,48}$/;
// One definition for run id handling, shared by store, classify and runtime.
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_RUN_IDS = 5;

export const KINDS: Record<BasePlatform, readonly KindId[]> = {
  linkedin: ['profile', 'search', 'feed', 'messaging', 'invitations', 'jobs', 'login', 'checkpoint', 'other'],
  naukri: ['job', 'search', 'inbox', 'thread', 'login', 'home', 'other'],
};

export const ACTION_LABELS: Record<BasePlatform, Record<string, string>> = {
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
  const table = actionLabelsFor(platform);
  return table && Object.hasOwn(table, key) ? table[key] : 'action:other';
}

export const LANDMARKS: Record<BasePlatform, readonly LandmarkId[]> = {
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
// 'main'..'form' are LinkedIn structure counts (RawSnapshot.structure); 'fields' and 'required' are ATS form counts.
export const COUNT_KEYS: readonly string[] = [
  'actions', 'results', 'invitations', 'messages', 'notices', 'buttons', 'options',
  'main', 'h1', 'h2', 'dialog', 'listitem', 'button', 'link', 'form', 'fields', 'required',
];

// Landmarks whose loss on a known kind means a tool cannot work (drift is critical).
export const CRITICAL: Record<BasePlatform, Record<KindId, readonly LandmarkId[]>> = {
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
export const MIN_SET: Record<BasePlatform, Record<KindId, readonly LandmarkId[]>> = {
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
  // The LinkedIn action tools (connect, message, accept) are gone: the browserctl engine acts and
  // feeds layout telemetry only, so no landmark precondition exists for them.
  linkedin_find_profiles: { kind: 'search', landmarks: ['results.cards'] },
  // Discovery pages. `jobs` has no MIN_SET until a supervised learning run, so enforce refuses it as unverified.
  linkedin_search_jobs: { kind: 'jobs', landmarks: ['results.cards'] },
  linkedin_search_posts: { kind: 'search', landmarks: ['results.cards'] },
  naukri_send_message: { kind: 'thread', landmarks: ['chat.input'] },
};

// ---- ATS form pages (plan 8G-2 task 19) -------------------------------------------------------
// A browser-applier ATS page is a step of a form. Its layout is a set of role and control ids from the
// closed lists below: never a label, option, selector or any other page text.
export const ATS_PLATFORM_RE = /^ats_[a-z0-9]{1,30}$/;
export const isAtsPlatform = (p: string): p is AtsPlatform => typeof p === 'string' && ATS_PLATFORM_RE.test(p);

export const ATS_KINDS: readonly KindId[] = ['landing', 'listing', 'signin', 'account', 'form', 'review', 'confirmation', 'other'];
export const ATS_CONTROL_KINDS: readonly string[] = ['next', 'submit', 'back', 'save', 'apply', 'sign_in', 'create_account', 'other'];
export const ATS_LANDMARKS: readonly LandmarkId[] = [
  ...FIELD_ROLES.map((r) => `field:${r}`),
  ...ATS_CONTROL_KINDS.map((k) => `control:${k}`),
  'notice.present',
];
// Kinds that can be learned (a step with a form or controls, however small).
const ATS_MIN_SET: Record<KindId, readonly LandmarkId[]> = { landing: [], signin: [], account: [], form: [], review: [] };

export const kindsFor = (p: Platform): readonly KindId[] | undefined =>
  isAtsPlatform(p) ? ATS_KINDS : (KINDS as Record<string, readonly KindId[]>)[p];
export const landmarksFor = (p: Platform): readonly LandmarkId[] =>
  isAtsPlatform(p) ? ATS_LANDMARKS : ((LANDMARKS as Record<string, readonly LandmarkId[]>)[p] ?? []);
export const actionLabelsFor = (p: Platform): Record<string, string> =>
  isAtsPlatform(p) ? {} : ((ACTION_LABELS as Record<string, Record<string, string>>)[p] ?? {});
export const criticalFor = (p: Platform, kind: KindId): readonly LandmarkId[] =>
  isAtsPlatform(p) ? [] : ((CRITICAL as Record<string, Record<KindId, readonly LandmarkId[]>>)[p]?.[kind] ?? []);
export const minSetFor = (p: Platform, kind: KindId): readonly LandmarkId[] | undefined =>
  isAtsPlatform(p) ? ATS_MIN_SET[kind] : (MIN_SET as Record<string, Record<KindId, readonly LandmarkId[]>>)[p]?.[kind];
