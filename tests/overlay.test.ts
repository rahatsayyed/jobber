import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadOverlayRules, parseOverlayRules, readOverlay, overlayDetail, humanRuleFor, titleSlug } from '../src/browserctl/overlay.js';
import { classifyLoadedPage, classifyOpenFailure } from '../src/browserctl/openFailure.js';
import type { RawTree } from '../src/browserctl/snapshot.js';
import { LIVE_ENV, inviteDialog, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';

const DIAG = JSON.parse(readFileSync(new URL('./fixtures/linkedin-share-profile-diag.json', import.meta.url), 'utf8')) as { dialogs: { role: string; name: string; buttons: string[] }[] };

const SHARE = '<div role="dialog" aria-label="Share your profile?"><h2>Share your profile?</h2><p>The employer will see your profile</p><button>Dismiss</button><button>Test User</button><button>Continue</button></div>';
const CAPTCHA = '<div role="dialog" aria-label="Try Premium"><p>Enter your credit card number to start</p><button>Not now</button><button>Pay</button></div>';
const UNKNOWN = '<div role="dialog" aria-label="Brand new LinkedIn thing"><p>Something we have not seen</p><button>Buy now</button><button>Maybe later</button></div>';

const worlds: World[] = [];
const mk = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const clicks = (w: World) => w.page.log.filter((l) => l.startsWith('click') || l.startsWith('press'));

describe('rules file (human-only dialogs)', () => {
  it('loads and compiles config/overlay-rules.json', () => {
    const r = loadOverlayRules();
    expect(r?.human.map((h) => h.id)).toEqual(expect.arrayContaining(['captcha', 'login', 'payment', 'government_id', 'account_restricted', 'security_verification']));
  });
  it('rejects malformed rules', () => {
    expect(() => parseOverlayRules({ version: 1 })).toThrow();
    expect(() => parseOverlayRules({ version: 2, human: [{ id: 'a_b', text: ['('] }] })).toThrow();
    expect(() => parseOverlayRules({ version: 2, human: [{ id: 'a_b' }] })).toThrow();
  });
  it('humanRuleFor: only person-only dialogs match; Share your profile and prompts do not', () => {
    const r = loadOverlayRules();
    expect(humanRuleFor('Quick security check', 'complete the captcha', r)?.id).toBe('captcha');
    expect(humanRuleFor('Sign in', '', r)?.id).toBe('login');
    expect(humanRuleFor('Notice', 'Your account has been restricted', r)?.id).toBe('account_restricted');
    expect(humanRuleFor('Try Premium', 'Enter your credit card number', r)?.id).toBe('payment');
    expect(humanRuleFor('Share your profile?', 'The employer will see your profile', r)).toBeNull();
    expect(humanRuleFor('Not now?', 'Turn on notifications', r)).toBeNull();
    expect(humanRuleFor('Share your profile?', '', null)).toBeNull();
  });
  it('titleSlug is a short code-safe word list', () => {
    expect(titleSlug('Share your profile?')).toBe('share_your_profile');
    expect(titleSlug('')).toBe('untitled');
  });
});

describe('readOverlay (read only)', () => {
  const page = (dialogs: typeof DIAG.dialogs) => ({ diag: async () => ({ shadowRoots: 1, iframes: 0, closedHostCandidates: 8, dialogs }) }) as never;
  const empty: RawTree = { url: 'https://www.linkedin.com/jobs/view/4389741719/', title: 'Job', nodes: [] };

  it('the real 2026-11-02 diag shape (dialog only in the diag list): title and buttons are visible, no refs, an Escape hint', async () => {
    const o = await readOverlay(page(DIAG.dialogs), empty, () => null);
    expect(o).toMatchObject({ title: 'Share your profile?', source: 'diag', buttons: [{ name: 'Dismiss', ref: null }, { name: 'Test User', ref: null }, { name: 'Continue', ref: null }] });
    expect(overlayDetail(o!)).toMatchObject({ overlay_title: 'Share your profile?', overlay_source: 'diag' });
    expect(overlayDetail(o!).overlay_hint).toContain('Escape');
    expect(o!.human).toBeUndefined();
  });
  it('a dialog the flow uses (invite, message) is not a blocker', async () => {
    expect(await readOverlay(page([{ role: 'dialog', name: 'Add a note to your invitation?', buttons: ['Add a note'] }]), empty, () => null)).toBeNull();
    expect(await readOverlay(page([]), empty, () => null)).toBeNull();
  });
});

describe('engine: blocked_by_overlay', () => {
  it('snapshot shows the Share your profile? dialog with refs; reading clicks nothing', async () => {
    const w = mk({ html: profileHtml({ dialog: SHARE }), env: LIVE_ENV });
    const r = await w.engine.snapshot();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatchObject({ blocked_by_overlay: true, overlay_title: 'Share your profile?', overlay_source: 'tree' });
    expect(String(r.detail?.overlay_buttons)).toMatch(/s\d+\.\d+=Dismiss \| s\d+\.\d+=Test User \| s\d+\.\d+=Continue/);
    expect(r.overlay?.buttons.every((b) => b.ref !== null)).toBe(true);
    expect(clicks(w)).toEqual([]);
  });
  it('the operator can dismiss it with an ordinary click by the ref the result gave', async () => {
    const w = mk({ html: profileHtml({ dialog: SHARE }), env: LIVE_ENV });
    const r = await w.engine.overlayState();
    expect(r.code).toBe('blocked_by_overlay');
    const dismiss = r.overlay!.buttons.find((b) => b.name === 'Dismiss')!.ref!;
    expect(dismiss).toBe(refOf(r.state!, 'button', 'Dismiss'));
    w.page.setHtml(profileHtml());
    const c = await w.engine.click(dismiss);
    expect(c.code === 'clicked' || c.code === 'target_gone' || c.code === 'target_changed').toBe(true);
    expect(clicks(w).length).toBeLessThanOrEqual(1);
  });
  it('a clean page reports no_overlay', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    const r = await w.engine.overlayState();
    expect(r).toMatchObject({ ok: true, code: 'no_overlay' });
    expect(r.overlay).toBeUndefined();
  });
  it('an invite dialog (the flow\'s own) is not reported as a blocker', async () => {
    const w = mk({ html: profileHtml({ dialog: inviteDialog() }), env: LIVE_ENV });
    expect((await w.engine.overlayState()).code).toBe('no_overlay');
  });
  it('(unknown dialog) the operator sees title and every button; nothing is parked or clicked by code', async () => {
    const w = mk({ html: profileHtml({ dialog: UNKNOWN }), env: LIVE_ENV });
    const r = await w.engine.overlayState();
    expect(r).toMatchObject({ ok: false, code: 'blocked_by_overlay' });
    expect(r.reason).toContain('Brand new LinkedIn thing');
    expect(r.reason).toContain('Buy now | Maybe later');
    expect(clicks(w)).toEqual([]);
  });
  it('(captcha dialog) overlay_needs_human, an owner notice, nothing clicked', async () => {
    const w = mk({ html: profileHtml({ dialog: CAPTCHA }), env: LIVE_ENV });
    const r = await w.engine.overlayState();
    expect(r).toMatchObject({ ok: false, code: 'overlay_needs_human', status: 'manual_review' });
    expect(r.detail).toMatchObject({ overlay_human: 'payment' });
    expect(w.db.prepare("SELECT COUNT(*) n FROM escalations WHERE platform = 'linkedin' AND reason = 'overlay:payment'").get()).toEqual({ n: 1 });
    expect(clicks(w)).toEqual([]);
  });
  it('a free click that throws because a dialog is in the way returns blocked_by_overlay with refs, not a bare action_failed', async () => {
    const w = mk({ html: profileHtml({ dialog: SHARE }), env: LIVE_ENV });
    const ref = refOf(await w.snap(), 'button', 'More');
    (w.page as unknown as { clickNode: () => Promise<void> }).clickNode = async () => { throw new Error('intercepted'); };
    const r = await w.engine.click(ref);
    expect(r.code).toBe('blocked_by_overlay');
    expect(r.overlay?.title).toBe('Share your profile?');
    expect(String(r.detail?.overlay_buttons)).toContain('=Dismiss');
    expect(r.state).toContain('Dismiss');
  });
  it('the same throw with no dialog stays a plain action_failed', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    const ref = refOf(await w.snap(), 'button', 'More');
    (w.page as unknown as { clickNode: () => Promise<void> }).clickNode = async () => { throw new Error('boom'); };
    expect((await w.engine.click(ref)).code).toBe('action_failed');
  });
  it('open on a page that shows a dialog succeeds and carries the dialog in its detail', async () => {
    const w = mk({ html: profileHtml({ dialog: SHARE }), env: LIVE_ENV });
    const r = await w.engine.open('https://www.linkedin.com/jobs/view/4389741719/');
    expect(r.ok).toBe(true);
    expect(r.detail).toMatchObject({ blocked_by_overlay: true, overlay_title: 'Share your profile?' });
  });
  it('open with a human-only dialog is overlay_needs_human', async () => {
    const w = mk({ html: profileHtml({ dialog: CAPTCHA }), env: LIVE_ENV });
    const r = await w.engine.open('https://www.linkedin.com/jobs/view/4389741719/');
    expect(r.code).toBe('overlay_needs_human');
  });
  it('open that throws gives a precise code and reason', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    (w.page as unknown as { goto: () => Promise<void> }).goto = async () => { throw new Error('page.goto: Timeout 30000ms exceeded.'); };
    const r = await w.engine.open('https://www.linkedin.com/jobs/view/4389741719/');
    expect(r).toMatchObject({ ok: false, code: 'nav_timeout' });
    expect(r.reason).toContain('open failed: code nav_timeout');
  });
});

describe('open failure reasons', () => {
  it('maps error text, url path and title to a closed code', () => {
    expect(classifyOpenFailure({ error: new Error('page.goto: Timeout 30000ms exceeded.'), url: 'about:blank' }).code).toBe('nav_timeout');
    expect(classifyOpenFailure({ error: new Error('net::ERR_NAME_NOT_RESOLVED at https://www.linkedin.com/'), url: '' })).toMatchObject({ code: 'net_error', transient: true });
    expect(classifyOpenFailure({ error: new Error('x'), url: 'https://www.linkedin.com/authwall?trk=x' }).code).toBe('auth_wall');
    expect(classifyOpenFailure({ error: new Error('x'), url: 'https://www.linkedin.com/login?session_redirect=y' }).code).toBe('login_required');
    expect(classifyOpenFailure({ error: new Error('x'), url: 'https://www.linkedin.com/checkpoint/challenge/abc' }).code).toBe('bot_wall');
    expect(classifyOpenFailure({ error: new Error('x'), url: 'https://www.linkedin.com/jobs/view/1/', title: 'Security Verification' }).code).toBe('bot_wall');
    expect(classifyOpenFailure({ url: 'https://www.linkedin.com/jobs/view/1/', status: 404 }).code).toBe('job_removed');
    expect(classifyOpenFailure({ url: 'https://www.linkedin.com/in/x/', status: 404 }).code).toBe('not_found');
    expect(classifyOpenFailure({ error: new Error('weird') }).code).toBe('nav_failed');
  });
  it('the reason carries only the code, the url path and a short title (no query)', () => {
    const f = classifyOpenFailure({ error: new Error('Timeout 30000ms exceeded'), url: 'https://www.linkedin.com/jobs/view/123/?trk=secret&email=a@b.co', title: 'Job | LinkedIn' });
    expect(f.reason).toContain('nav_timeout');
    expect(f.reason).toContain('/jobs/view/123/');
    expect(f.reason).not.toContain('secret');
    expect(f.transient).toBe(true);
    expect(classifyOpenFailure({ url: 'https://www.linkedin.com/authwall' }).transient).toBe(false);
  });
  it('a loaded page that says the job is gone', () => {
    expect(classifyLoadedPage('Job | LinkedIn', 'No longer accepting applications')).toBe('job_removed');
    expect(classifyLoadedPage('Page not found | LinkedIn', '')).toBe('not_found');
    expect(classifyLoadedPage('Full Stack Developer | Acme', 'Apply')).toBeNull();
  });
});
