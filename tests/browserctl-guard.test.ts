import { describe, it, expect } from 'vitest';
import {
  classify, classifyKey, classifyPoint, checkType, textMatches, dialogKindOf, guardInputOf, type GuardInput,
} from '../src/browserctl/guard.js';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { fakeBcPage } from './helpers/fakeBc.js';

const btn = (platform: GuardInput['platform'], name: string, extra: Partial<GuardInput> = {}): GuardInput => ({
  platform, role: 'button', name, ...extra,
});

describe('classify: linkedin', () => {
  const table: Array<[string, Partial<GuardInput>, string]> = [
    ['Connect', {}, 'commit_connect_send'],
    ['Invite Jane Doe to connect', {}, 'commit_connect_send'],
    ['Send without a note', { dialogName: 'Add a note' }, 'commit_connect_send'],
    ['Send invitation', {}, 'commit_connect_send'],
    ['Send', { dialogName: 'Add a note to your invitation', inFooter: true, isSubmit: true }, 'commit_connect_send'],
    ['Send', { dialogName: 'New message', inFooter: true }, 'commit_message_send'],
    ['Send', { inComposer: true }, 'commit_message_send'],
    ['Send', {}, 'irreversible_other'],
    ['Message', {}, 'free'],
    ['Message', { dialogName: 'New message', inFooter: true }, 'commit_message_send'],
    ['Accept', {}, 'commit_accept_invite'],
    ['Accept invitation from Jane Doe', {}, 'commit_accept_invite'],
    ['Ignore', {}, 'irreversible_other'],
    ['Follow', {}, 'irreversible_other'],
    ['Like', {}, 'irreversible_other'],
    ['Post', {}, 'irreversible_other'],
    ['Easy Apply', {}, 'irreversible_other'],
    ['Add a note', { dialogName: 'Add a note' }, 'free'],
    ['Cancel', { dialogName: 'Add a note', inFooter: true }, 'free'],
    ['Close', { dialogName: 'Add a note' }, 'free'],
    ['Dismiss', {}, 'free'],
    ['Back', {}, 'free'],
    ['Next', { dialogName: 'Something', inFooter: true }, 'free'],
    ['More', {}, 'free'],
    ['Show more results', {}, 'free'],
    ['Verbinden', {}, 'commit_connect_send'],
    ['Senden', { dialogName: 'Nachricht verfassen message' }, 'commit_message_send'],
  ];
  it.each(table)('%s %j -> %s', (name, extra, want) => {
    expect(classify(btn('linkedin', name, extra))).toBe(want);
  });

  it('is case, space and punctuation insensitive', () => {
    expect(classify(btn('linkedin', '  CONNECT. '))).toBe('commit_connect_send');
    expect(classify(btn('linkedin', 'Con​nect'.replace('​', '')))).toBe('commit_connect_send');
  });

  it('fails closed on unknown dialog-footer and submit buttons', () => {
    expect(classify(btn('linkedin', 'Done', { dialogName: 'Some dialog', inFooter: true }))).toBe('irreversible_other');
    expect(classify(btn('linkedin', 'Confirm', { dialogName: 'Some dialog', inFooter: true }))).toBe('irreversible_other');
    expect(classify(btn('linkedin', 'Whatever', { isSubmit: true }))).toBe('irreversible_other');
    expect(classify(btn('linkedin', '', { isSubmit: true }))).toBe('irreversible_other');
    // an unknown button outside a footer that is not a submit stays free
    expect(classify(btn('linkedin', 'Whatever'))).toBe('free');
    expect(classify(btn('linkedin', 'Whatever', { dialogName: 'Some dialog' }))).toBe('free');
  });

  it('treats non-click roles as free and dangerous links as irreversible', () => {
    expect(classify({ platform: 'linkedin', role: 'textbox', name: 'Message' })).toBe('free');
    expect(classify({ platform: 'linkedin', role: 'heading', name: 'Connect' })).toBe('free');
    expect(classify({ platform: 'linkedin', role: 'link', name: 'Sign out', href: '/uas/logout' })).toBe('irreversible_other');
    expect(classify({ platform: 'linkedin', role: 'link', name: 'Profile', href: '/in/jane-doe/' })).toBe('free');
  });

  it('dialogKindOf reads the dialog name', () => {
    expect(dialogKindOf('Add a note to your invitation')).toBe('invite');
    expect(dialogKindOf('New message')).toBe('message');
    expect(dialogKindOf('Settings')).toBe('other');
    expect(dialogKindOf('')).toBeNull();
  });
});

describe('classify: naukri and scout', () => {
  it('naukri apply, thread send and chatbot', () => {
    expect(classify(btn('naukri', 'Apply'))).toBe('naukri_apply');
    expect(classify(btn('naukri', 'Apply now'))).toBe('naukri_apply');
    expect(classify(btn('naukri', 'Apply on company site'))).toBe('irreversible_other');
    expect(classify(btn('naukri', 'Send', { pageKind: 'thread', inComposer: true }))).toBe('naukri_send');
    expect(classify(btn('naukri', 'Send', { inComposer: true }))).toBe('naukri_apply');
    expect(classify(btn('naukri', 'Send'))).toBe('irreversible_other');
    expect(classify(btn('naukri', 'Save', { dialogName: 'Chat' }))).toBe('naukri_apply');
    expect(classify(btn('naukri', 'Save'))).toBe('irreversible_other');
    expect(classify(btn('naukri', 'Search jobs'))).toBe('free');
  });

  it('scout never gets a commit class; submit-like controls are irreversible', () => {
    for (const n of ['Apply', 'Apply now', 'Sign in', 'Sign up', 'Submit', 'Connect', 'Accept', 'Send']) {
      expect(classify(btn('scout', n))).toBe('irreversible_other');
    }
    expect(classify(btn('scout', 'Next page'))).toBe('free');
    expect(classify(btn('scout', 'Search', { isSubmit: true }))).toBe('free');
  });
});

describe('classifyKey', () => {
  it('only Enter and Space can act', () => {
    expect(classifyKey({ ...btn('linkedin', 'Connect'), key: 'Escape' })).toBe('free');
    expect(classifyKey({ ...btn('linkedin', 'Connect'), key: 'Tab' })).toBe('free');
    expect(classifyKey({ ...btn('linkedin', 'Connect'), key: 'Enter' })).toBe('commit_connect_send');
    expect(classifyKey({ ...btn('linkedin', 'Connect'), key: 'Space' })).toBe('commit_connect_send');
    expect(classifyKey({ ...btn('linkedin', 'Cancel'), key: 'Enter' })).toBe('free');
  });
  it('Enter in a composer is that composer\'s Send', () => {
    const box = { platform: 'linkedin' as const, role: 'textbox', name: 'Write a message', inComposer: true };
    expect(classifyKey({ ...box, key: 'Enter' })).toBe('commit_message_send');
    expect(classifyKey({ ...box, dialogName: 'Add a note', key: 'Enter' })).toBe('commit_connect_send');
    expect(classifyKey({ ...box, platform: 'naukri', pageKind: 'thread', key: 'Enter' })).toBe('naukri_send');
    expect(classifyKey({ ...box, platform: 'naukri', key: 'Enter' })).toBe('naukri_apply');
    expect(classifyKey({ ...box, platform: 'scout', key: 'Enter' })).toBe('irreversible_other');
  });
  it('Enter in a search box is free', () => {
    expect(classifyKey({ platform: 'linkedin', role: 'searchbox', name: 'Search', key: 'Enter' })).toBe('free');
    expect(classifyKey({ platform: 'linkedin', role: 'textbox', name: 'Title', key: 'Enter' })).toBe('free');
  });
});

describe('classifyPoint (click_at)', () => {
  const html = `<body><main>
    <button>Connect</button>
    <dialog open aria-label="Add a note"><footer><button>Cancel</button><button type="submit">Send</button><span>stray</span></footer></dialog>
  </main></body>`;

  it('resolves the element under the point and classifies it like a click', async () => {
    const page = fakeBcPage(html);
    const tree = await page.snapshot();
    const id = (name: string) => tree.nodes.find((n) => n.name === name)?.n as number;
    page.points.set('10,10', id('Connect'));
    page.points.set('20,20', id('Cancel'));
    page.points.set('30,30', id('Send'));
    expect(await classifyPoint(page, 'linkedin', null, 10, 10)).toMatchObject({ ok: true, cls: 'commit_connect_send' });
    expect(await classifyPoint(page, 'linkedin', null, 20, 20)).toMatchObject({ ok: true, cls: 'free' });
    expect(await classifyPoint(page, 'linkedin', null, 30, 30)).toMatchObject({ ok: true, cls: 'commit_connect_send' });
  });

  it('refuses an unresolvable or invalid point', async () => {
    const page = fakeBcPage(html);
    expect(await classifyPoint(page, 'linkedin', null, 99, 99)).toEqual({ ok: false, code: 'unresolvable_point' });
    expect(await classifyPoint(page, 'linkedin', null, -1, 5)).toEqual({ ok: false, code: 'unresolvable_point' });
    expect(await classifyPoint(page, 'linkedin', null, Number.NaN, 5)).toEqual({ ok: false, code: 'unresolvable_point' });
  });

  it('a point on a non-actionable element in a dialog footer fails closed', () => {
    const tree = buildTreeFromHtml(html, 'https://x.test/');
    const stray = tree.nodes.find((n) => n.role === 'text' && n.text === 'stray');
    expect(stray?.inFooter).toBe(true);
    expect(classify(guardInputOf(stray!, 'linkedin', null, true))).toBe('irreversible_other');
    expect(classify(guardInputOf(stray!, 'linkedin', null, false))).toBe('free');
  });
});

describe('checkType', () => {
  const field = (extra: object) => ({ n: 1, role: 'textbox' as const, name: 'x', text: '', disabled: false, ...extra });
  it('refuses password-like and non-text targets', () => {
    expect(checkType(field({ secret: true }), 'abc', null)).toMatchObject({ ok: false, code: 'secret_field' });
    expect(checkType({ ...field({}), role: 'button' }, 'abc', null)).toMatchObject({ ok: false, code: 'not_a_text_field' });
  });
  it('composer fields need an armed intent and exact text', () => {
    const c = field({ composer: true });
    expect(checkType(c, 'Hello', null)).toMatchObject({ ok: false, code: 'no_armed_intent' });
    expect(checkType(c, 'Hello', { class: 'commit_message_send', text: 'Hello' })).toEqual({ ok: true, mode: 'composer' });
    expect(checkType(c, 'Hello!', { class: 'commit_message_send', text: 'Hello' })).toMatchObject({ ok: false, code: 'intent_text_mismatch' });
    expect(checkType(c, 'Hello', { class: 'commit_accept_invite', text: null })).toMatchObject({ ok: false, code: 'intent_text_mismatch' });
  });
  it('naukri apply intent allows capped chatbot answers', () => {
    const c = field({ composer: true });
    expect(checkType(c, '4 years', { class: 'naukri_apply', text: null })).toEqual({ ok: true, mode: 'chatbot' });
    expect(checkType(c, 'x'.repeat(501), { class: 'naukri_apply', text: null })).toMatchObject({ ok: false, code: 'text_too_long' });
    expect(checkType(c, 'see https://evil.test', { class: 'naukri_apply', text: null })).toMatchObject({ ok: false, code: 'text_not_allowed' });
  });
  it('plain fields: capped, no URLs, emails or secret-shaped text', () => {
    const f = field({});
    expect(checkType(f, 'react developer', null)).toEqual({ ok: true, mode: 'plain' });
    expect(checkType(f, 'a'.repeat(201), null)).toMatchObject({ ok: false, code: 'text_too_long' });
    expect(checkType(f, 'me@example.test', null)).toMatchObject({ ok: false, code: 'text_not_allowed' });
    expect(checkType(f, 'www.example.test', null)).toMatchObject({ ok: false, code: 'text_not_allowed' });
    expect(checkType(f, 'sk_live_' + 'A1b2C3d4'.repeat(4), null)).toMatchObject({ ok: false, code: 'text_not_allowed' });
  });
  it('textMatches ignores line endings and one trailing newline only', () => {
    expect(textMatches('a\nb', 'a\r\nb\n')).toBe(true);
    expect(textMatches('a b', 'a  b')).toBe(false);
  });
});
