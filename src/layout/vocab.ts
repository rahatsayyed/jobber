// Closed vocabulary for layout memory. Anything not listed here can never appear in an
// observation, so page text cannot leak into the stored layout.
import type { KindId, LandmarkId, Platform } from './types.js';

export const ID_RE = /^[a-z0-9_.:-]{1,48}$/;

export const KINDS: Record<Platform, readonly KindId[]> = {
  linkedin: ['profile', 'search', 'feed', 'messaging', 'invitations', 'jobs', 'login', 'checkpoint', 'other'],
  naukri: ['job', 'search', 'inbox', 'login', 'home', 'other'],
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
  naukri: {
    job: ['button:apply'],
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
    job: ['button:apply'],
  },
};

// What each typed tool needs on the page before it acts.
export const TOOL_REQUIRES: Record<string, { kind: KindId; landmarks: readonly LandmarkId[] }> = {
  linkedin_check_connection_status: { kind: 'profile', landmarks: ['profile.name'] },
  linkedin_connect_send: { kind: 'profile', landmarks: ['profile.name', 'action:connect'] },
  linkedin_send_message: { kind: 'profile', landmarks: ['profile.name', 'profile.message_button'] },
  linkedin_find_profiles: { kind: 'search', landmarks: ['results.cards'] },
  linkedin_accept_invite: { kind: 'invitations', landmarks: ['invitations.rows'] },
};
