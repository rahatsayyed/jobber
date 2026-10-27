// The live Send path: what counts as sent. Fakes only (invented profile "Jane Example"). Sent needs the dialog gone AND
// (the page shows the invite as sent OR a LinkedIn POST succeeded with no error text on the page). An error modal that
// replaces the invite dialog is a failure, a limit message is a platform signal, anything else stays unconfirmed.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/layout/config.js';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { CONFIRM_POLL_MS, errorSignalOf } from '../src/browserctl/sendSignals.js';
import { countSince } from '../src/outreach/limits.js';
import { LIVE_ENV, NOTE, URL_, inviteDialog, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';

const worlds: World[] = [];
const mk = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const SINCE = new Date('2026-10-01T00:00:00Z');

const topCard = (actions: string, extra = ''): string => `<html><head><title>Jane Example | LinkedIn</title></head><body><main>
<section><h1>Jane Example</h1><p>· 3rd</p><p>Technical Recruiter at Acme</p>${actions}</section>${extra}</main></body></html>`;
const PENDING = topCard('<button>Pending</button><button>Message</button><button>More</button>');
const LIMIT_MODAL = '<div role="dialog" aria-label="Invitation limit"><h2>You have reached the weekly invitation limit</h2><button>Got it</button></div>';

const armed = async (dialog = inviteDialog(), sendName = 'Send', screenshot = false) => {
  const w = mk({ html: profileHtml({ dialog }), env: LIVE_ENV, screenshot });
  expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE, job_id: 'j1', company: 'Acme' })).status).toBe('armed');
  const send = refOf(await w.snap(), 'button', sendName);
  return { w, send };
};
const touchStatus = (w: World, id: unknown) => (w.db.prepare('SELECT status FROM touches WHERE id = ?').get(id) as { status: string }).status;
const connections = (w: World) => (w.db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }).n;
const afterClick = (w: World, html: string) => { w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(html); }; };
const diagOf = (reason: string | undefined): Record<string, unknown> => {
  const m = /\(diag: (.+?)\)/.exec(reason ?? '');
  expect(m).toBeTruthy();
  return JSON.parse(readFileSync(path.resolve(PROJECT_ROOT, m![1]), 'utf8')) as Record<string, unknown>;
};

describe('Send confirmation', () => {
  it('Pending appears a little after the click: strong confirmation, sent, diag says so', async () => {
    const { w, send } = await armed();
    afterClick(w, profileHtml());
    let waits = 0;
    w.page.waitMs = async () => { if (++waits === 3) w.page.setHtml(PENDING); };
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(touchStatus(w, r.touch_id)).toBe('sent');
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
    expect(diagOf(r.reason).send_check).toEqual({ strong: true, network: true, dialog_gone: true, error_signal: 'none', polled_ms: 1000 });
  });

  it('an "Invitation sent" toast is strong confirmation even without a network response', async () => {
    const { w, send } = await armed();
    w.page.responseOk = false;
    afterClick(w, profileHtml({ extra: '<div>Invitation sent</div>' }));
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(diagOf(r.reason).send_check).toMatchObject({ strong: true, network: false, polled_ms: 0 });
  });

  it('only a network 2xx, dialog gone, no error text: sent, and the diag shows network only', async () => {
    const { w, send } = await armed();
    afterClick(w, profileHtml());
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(w.db.prepare('SELECT status FROM connections').get()).toMatchObject({ status: 'sent' });
    expect(diagOf(r.reason).send_check).toEqual({ strong: false, network: true, dialog_gone: true, error_signal: 'none', polled_ms: CONFIRM_POLL_MS });
  });

  it('no network response, dialog gone, nothing on the page: unconfirmed, never sent', async () => {
    const { w, send } = await armed();
    w.page.responseOk = false;
    afterClick(w, profileHtml());
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed', code: 'unconfirmed' });
    expect(touchStatus(w, r.touch_id)).toBe('unconfirmed');
    expect(connections(w)).toBe(0);
    expect(diagOf(r.reason).send_check).toMatchObject({ strong: false, network: false, dialog_gone: true, error_signal: 'none' });
  });

  it('dialog still open (network ok): unconfirmed', async () => {
    const { w, send } = await armed();
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed' });
    expect(touchStatus(w, r.touch_id)).toBe('unconfirmed');
    expect(diagOf(r.reason).send_check).toMatchObject({ network: true, dialog_gone: false, error_signal: 'none' });
  });

  it('a limit modal replaces the dialog: failed with invite_limit_reached, never sent, Escape pressed', async () => {
    const { w, send } = await armed();
    afterClick(w, profileHtml({ dialog: LIMIT_MODAL }));
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: false, status: 'failed', code: 'invite_limit_reached' });
    expect(touchStatus(w, r.touch_id)).toBe('failed');
    expect(connections(w)).toBe(0);
    expect(w.page.log).toContain('press Escape');
    expect(w.intents.peek('linkedin')).toBeNull();
    expect(diagOf(r.reason).send_check).toMatchObject({ network: true, dialog_gone: true, error_signal: 'limit' });
  });

  it('a generic error toast: failed with send_error_modal, even next to a successful POST', async () => {
    const { w, send } = await armed();
    afterClick(w, profileHtml({ extra: '<div>Something went wrong. Please try again.</div>' }));
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: false, status: 'failed', code: 'send_error_modal' });
    expect(touchStatus(w, r.touch_id)).toBe('failed');
    expect(connections(w)).toBe(0);
  });

  it('an error beats a Pending that shows up in the same read (error first)', async () => {
    const { w, send } = await armed();
    afterClick(w, topCard('<button>Pending</button>', '<div>Verify you are not a robot</div>'));
    expect((await w.engine.click(send)).code).toBe('send_error_modal');
  });

  it('error text that was already on the page before the click is not an error signal', async () => {
    const note = '<p>Our team will verify your request</p>';
    const w = mk({ html: profileHtml({ dialog: inviteDialog(), extra: note }), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const send = refOf(await w.snap(), 'button', 'Send');
    afterClick(w, profileHtml({ extra: note }));
    expect(await w.engine.click(send)).toMatchObject({ ok: true, status: 'sent' });
  });

  it('click_at on Send goes through the same path', async () => {
    const { w, send } = await armed(inviteDialog(), 'Send', true);
    w.page.points.set('30,30', Number(send.split('.')[1]));
    await w.engine.screenshot();
    w.page.onAct = (what) => { if (what.startsWith('clickPoint')) w.page.setHtml(profileHtml({ dialog: LIMIT_MODAL })); };
    const r = await w.engine.clickAt(30, 30);
    expect(r).toMatchObject({ ok: false, status: 'failed', code: 'invite_limit_reached' });
  });

  it('"Send without a note" goes through the same path', async () => {
    const dlg = '<dialog open aria-label="Add a note"><h2>Add a note to your invitation?</h2><p>Personalize your invitation to Jane Example by adding a note</p>'
      + `<textarea>${NOTE}</textarea><footer><button>Send without a note</button></footer></dialog>`;
    const a = await armed(dlg, 'Send without a note');
    afterClick(a.w, profileHtml({ dialog: LIMIT_MODAL }));
    expect(await a.w.engine.click(a.send)).toMatchObject({ status: 'failed', code: 'invite_limit_reached' });
    const b = await armed(dlg, 'Send without a note');
    afterClick(b.w, PENDING);
    expect(await b.w.engine.click(b.send)).toMatchObject({ ok: true, status: 'sent' });
  });
});

describe('errorSignalOf', () => {
  const t = (html: string) => buildTreeFromHtml(html, URL_);
  it('reads only new short texts, limit before error, none otherwise', () => {
    const base = t(profileHtml({ dialog: inviteDialog() }));
    expect(errorSignalOf(base, t(profileHtml()))).toBe('none');
    expect(errorSignalOf(base, t(profileHtml({ extra: '<div>Try again later</div>' })))).toBe('error');
    expect(errorSignalOf(base, t(profileHtml({ extra: '<div>Try again later</div><div>Too many requests</div>' })))).toBe('limit');
    expect(errorSignalOf(base, t(profileHtml({ extra: `<div>${'limit '.repeat(60)}</div>` })))).toBe('none');
  });
});
