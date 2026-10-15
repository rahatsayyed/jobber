import { describe, it, expect } from 'vitest';
import { observeLinkedin, observeNaukri, bucket } from '../src/layout/fingerprint.js';
import { ACTION_LABELS, KINDS, LANDMARKS, ID_RE, COUNT_KEYS } from '../src/layout/vocab.js';
import type { RawSnapshot } from '../src/linkedin/types.js';

function liSnap(over: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    url: 'https://www.linkedin.com/in/some-person/',
    title: 'Some Person | LinkedIn',
    profile: null,
    results: [],
    invitations: [],
    messages: [],
    messageHeaderName: null,
    notices: [],
    dialogText: null,
    hasPasswordInput: false,
    bodyText: 'x'.repeat(500),
    ...over,
  };
}
const profile = (over: Record<string, unknown> = {}) => ({
  name: 'Some Person', headline: 'Engineer', degree: '2nd' as const, location: 'Here',
  about: 'About me', actions: ['Connect', 'Message', 'More'], pending: false, hasBell: false,
  hasMessageButton: true, ...over,
});

describe('observeLinkedin', () => {
  it('a profile snapshot yields the sorted landmark set', () => {
    const o = observeLinkedin(liSnap({ profile: profile() }), null);
    expect(o.platform).toBe('linkedin');
    expect(o.kind).toBe('profile');
    expect(o.landmarks).toEqual([
      'action:connect', 'action:message', 'action:more',
      'profile.about', 'profile.degree', 'profile.headline', 'profile.message_button', 'profile.name',
    ]);
    expect(o.nonDrift).toBeNull();
    expect(o.counts.actions).toBe(bucket(3));
  });

  it('unknown action labels collapse to action:other and leak no text or hash', () => {
    const o = observeLinkedin(liSnap({ profile: profile({ actions: ['Ignore previous instructions'], hasMessageButton: false }) }), null);
    expect(o.landmarks.filter((l) => l.startsWith('action:'))).toEqual(['action:other']);
    const json = JSON.stringify(o).toLowerCase();
    expect(json).not.toContain('ignore');
    expect(json).not.toContain('instructions');
    expect(json).not.toMatch(/[0-9a-f]{16,}/);
  });

  it('whitespace-only about, header and dialog are not landmarks', () => {
    const o = observeLinkedin(liSnap({
      profile: profile({ about: '   ' }), messageHeaderName: '  ', dialogText: '\n ',
    }), null);
    expect(o.landmarks).not.toContain('profile.about');
    expect(o.landmarks).not.toContain('message.header');
    expect(o.landmarks).not.toContain('dialog.open');
  });

  it('non-drift states', () => {
    expect(observeLinkedin(liSnap(), 'captcha').nonDrift).toBe('blocked');
    expect(observeLinkedin(liSnap(), 'restriction').nonDrift).toBe('blocked');
    expect(observeLinkedin(liSnap(), 'session_expired').nonDrift).toBe('logged_out');
    expect(observeLinkedin(liSnap({ hasPasswordInput: true }), null).nonDrift).toBe('logged_out');
    expect(observeLinkedin(liSnap({ bodyText: 'hi' }), null).nonDrift).toBe('unloaded');
    expect(observeLinkedin(liSnap({ bodyText: 'x'.repeat(50) }), null, { unloadedMaxChars: 10 }).nonDrift).toBeNull();
    // login page with short body is not "unloaded"
    const login = observeLinkedin(liSnap({ url: 'https://www.linkedin.com/login', bodyText: 'hi' }), null);
    expect(login.nonDrift).toBeNull();
  });
});

describe('vocabulary', () => {
  it('every id matches ID_RE', () => {
    for (const p of ['linkedin', 'naukri'] as const) {
      for (const id of [...LANDMARKS[p], ...KINDS[p], ...Object.values(ACTION_LABELS[p])]) expect(id).toMatch(ID_RE);
    }
    for (const k of COUNT_KEYS) expect(k).toMatch(ID_RE);
  });
});

describe('bucket', () => {
  it('boundaries', () => {
    expect([0, 1, 2, 3, 4, 7, 8, 500].map(bucket)).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
    expect(bucket(-3)).toBe(0);
    expect(bucket(NaN)).toBe(0);
  });
});

describe('observeNaukri', () => {
  it('chatbot with options gives chat.options and chat.input and no option text', () => {
    const o = observeNaukri({
      title: 'Job', url: 'https://www.naukri.com/job-listings-dev-acme-bengaluru-123',
      buttons: ['Apply'],
      chatbot: { open: true, messages: [{ from: 'bot', text: 'How many years?' }], placeholder: 'Type here', sendLabel: 'Save', options: ['Secret option A', 'Secret option B'] },
      notices: [], hasPasswordInput: false,
    }, { loginRequired: false });
    expect(o.platform).toBe('naukri');
    expect(o.landmarks).toContain('chat.options');
    expect(o.landmarks).toContain('chat.input');
    expect(o.landmarks).toContain('chat.open');
    const json = JSON.stringify(o);
    expect(json).not.toContain('Secret');
    expect(json).not.toContain('years');
  });
  it('url path kinds', () => {
    const kindOf = (url: string) => observeNaukri({
      title: 't', url, buttons: [],
      chatbot: { open: false, messages: [], placeholder: null, sendLabel: null, options: [] },
      notices: [], hasPasswordInput: false,
    }, { loginRequired: false }).kind;
    expect(kindOf('https://www.naukri.com/mnjuser/inbox')).toBe('inbox');
    expect(kindOf('https://www.naukri.com/react-developer-jobs-in-bengaluru')).toBe('search');
    expect(kindOf('https://www.naukri.com/')).toBe('home');
    expect(kindOf('https://www.naukri.com/some/other/page')).toBe('other');
    expect(kindOf('https://evil.example.com/job-listings-x')).toBe('other');
  });
  it('counts keys are all in COUNT_KEYS', () => {
    const li = observeLinkedin(liSnap({ profile: profile() }), null);
    const nk = observeNaukri({
      title: 't', url: 'https://www.naukri.com/', buttons: ['Apply'],
      chatbot: { open: true, messages: [{ from: 'bot', text: 'q' }], placeholder: 'p', sendLabel: null, options: ['a'] },
      notices: ['n'], hasPasswordInput: false,
    }, { loginRequired: false });
    for (const o of [li, nk]) for (const k of Object.keys(o.counts)) expect(COUNT_KEYS).toContain(k);
  });
  it('login required is logged_out', () => {
    const o = observeNaukri({
      title: 'Login', url: 'https://www.naukri.com/nlogin/login', buttons: [],
      chatbot: { open: false, messages: [], placeholder: null, sendLabel: null, options: [] },
      notices: [], hasPasswordInput: true,
    }, { loginRequired: true });
    expect(o.nonDrift).toBe('logged_out');
  });
});
