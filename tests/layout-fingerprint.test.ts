import { describe, it, expect } from 'vitest';
import { observeLinkedin, observeNaukri, bucket } from '../src/layout/fingerprint.js';
import { ACTION_LABELS, KINDS, LANDMARKS, ID_RE, COUNT_KEYS, actionLabelFor } from '../src/layout/vocab.js';
import type { RawSnapshot } from '../src/linkedin/types.js';
import { applyObservation } from '../src/layout/classify.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { emptyLayout } from '../src/layout/store.js';

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
    expect(observeLinkedin(liSnap({ profile: profile(), bodyText: 'x'.repeat(50) }), null, { unloadedMaxChars: 10 }).nonDrift).toBeNull();
    // a full-size profile page with a name is a real page
    expect(observeLinkedin(liSnap({ profile: profile() }), null).nonDrift).toBeNull();
    // login page with short body is not "unloaded"
    const login = observeLinkedin(liSnap({ url: 'https://www.linkedin.com/login', bodyText: 'hi' }), null);
    expect(login.nonDrift).toBeNull();
  });
  it('a profile URL without an extracted name is unloaded, never drift (unavailable page, sub-page)', () => {
    const body = 'Profile unavailable. This profile is not available. '.repeat(10);
    expect(observeLinkedin(liSnap({ profile: null, bodyText: body }), null).nonDrift).toBe('unloaded');
    expect(observeLinkedin(liSnap({ profile: profile({ name: '  ' }), bodyText: body }), null).nonDrift).toBe('unloaded');
    const recent = observeLinkedin(
      liSnap({ url: 'https://www.linkedin.com/in/x/recent-activity/all/', profile: null, bodyText: body }), null);
    expect(recent.kind).toBe('profile');
    expect(recent.nonDrift).toBe('unloaded');
    // blocked and logged out keep priority
    expect(observeLinkedin(liSnap({ profile: null, bodyText: body }), 'captcha').nonDrift).toBe('blocked');
    expect(observeLinkedin(liSnap({ profile: null, bodyText: body }), 'session_expired').nonDrift).toBe('logged_out');
  });
  it('label lookup uses own properties only', () => {
    const o = observeLinkedin(liSnap({ profile: profile({ actions: ['constructor', '__proto__', 'toString', 'Connect'] }) }), null);
    expect(o.landmarks).toContain('action:other');
    expect(o.landmarks).toContain('action:connect');
    for (const l of o.landmarks) expect(ID_RE.test(l)).toBe(true);
    expect(actionLabelFor('linkedin', 'constructor')).toBe('action:other');
    expect(actionLabelFor('linkedin', '__proto__')).toBe('action:other');
    expect(actionLabelFor('naukri', 'constructor')).toBe('action:other');
    expect(actionLabelFor('linkedin', ' CONNECT ')).toBe('action:connect');
  });
  it('structure counts: bucketed, in COUNT_KEYS, absent adds nothing, refines shell', () => {
    const st = (over: Record<string, number> = {}) =>
      ({ main: 1, h1: 1, h2: 0, dialog: 0, listitem: 5, button: 3, link: 0, form: 0, ...over });
    const o = observeLinkedin(liSnap({ structure: st() }), null);
    expect(o.counts.main).toBe(bucket(1));
    expect(o.counts.listitem).toBe(bucket(5));
    expect(o.counts.button).toBe(bucket(3));
    for (const k of Object.keys(o.counts)) expect(COUNT_KEYS).toContain(k);
    expect(Object.keys(observeLinkedin(liSnap(), null).counts).sort()).toEqual(['actions', 'invitations', 'messages', 'notices', 'results']);
    expect(observeLinkedin(liSnap(), null).shell).toBe(true);
    expect(observeLinkedin(liSnap({ structure: st() }), null).shell).toBe(true);
    expect(observeLinkedin(liSnap({ structure: st({ main: 0, button: 2 }) }), null).shell).toBe(true);
    expect(observeLinkedin(liSnap({ structure: st({ main: 0, button: 0, link: 0 }) }), null).shell).toBe(false);
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
  describe('shell and unloaded come from snapshot content', () => {
    const empty = { open: false, messages: [], placeholder: null, sendLabel: null, options: [] };
    const nk = (over: Record<string, unknown> = {}, url = 'https://www.naukri.com/mnjuser/inbox?threadId=t1') =>
      observeNaukri({ title: '', url, buttons: [], chatbot: empty, notices: [], hasPasswordInput: false, ...over } as never, { loginRequired: false });
    it('an empty snapshot at a known-kind URL is unloaded and not a shell', () => {
      const o = nk();
      expect(o.kind).toBe('thread');
      expect(o.nonDrift).toBe('unloaded');
      expect(o.shell).toBe(false);
    });
    it('any content makes it a shell: title, buttons, chat messages or input', () => {
      for (const over of [
        { title: 'Inbox' }, { buttons: ['Save'] },
        { chatbot: { ...empty, messages: [{ from: 'bot', text: 'hi' }] } },
        { chatbot: { ...empty, placeholder: 'Type' } },
      ]) {
        const o = nk(over);
        expect(o.nonDrift).toBeNull();
        expect(o.shell).toBe(true);
      }
    });
    it('access denied pages are blocked, error pages unloaded, login walls not a shell', () => {
      expect(nk({ title: 'Access Denied' }).nonDrift).toBe('blocked');
      expect(nk({ title: 'Inbox', notices: ['Access Denied: reference #18.1'] }).nonDrift).toBe('blocked');
      expect(nk({ title: '404 Page not found', buttons: ['Home'] }).nonDrift).toBe('unloaded');
      expect(nk({ title: '404 Page not found', buttons: ['Home'] }).shell).toBe(false);
      const wall = nk({ title: 'Inbox', buttons: ['Login'], hasPasswordInput: true });
      expect(wall.shell).toBe(false);
    });
    it('an unknown URL stays other with no shell and no nonDrift', () => {
      const o = nk({ title: 'x' }, 'https://www.naukri.com/some/other/page');
      expect(o.kind).toBe('other');
      expect(o.shell).toBe(false);
    });
    it('the job kind is never drift and never learned (no critical or minimum set)', () => {
      const cfg = loadLayoutConfig({ LAYOUT_PROMOTE_N: '1', LAYOUT_PROMOTE_RUNS: '1' } as NodeJS.ProcessEnv, '/proj');
      const now = new Date('2026-10-15T00:00:00.000Z');
      const job = nk({ title: 'Job', buttons: ['Apply'] }, 'https://www.naukri.com/job-listings-dev-acme-bengaluru-123');
      expect(job.kind).toBe('job');
      let f = emptyLayout('naukri', now);
      for (let i = 0; i < 4; i++) {
        const r = applyObservation(f, job, { now, runId: 'r1' }, cfg);
        expect(r.verdict.class).toBe('unknown');
        f = r.file;
      }
      expect(f.kinds.job).toBeUndefined();
      const applied = nk({ title: 'Job', buttons: ['Applied'] }, 'https://www.naukri.com/job-listings-dev-acme-bengaluru-123');
      expect(applyObservation(f, applied, { now, runId: 'r2' }, cfg).verdict.class).toBe('unknown');
    });
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
