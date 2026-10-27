// Live result: the LinkedIn invite dialog ("Add a note to your invitation?") shows no recipient name, so the old
// commit check could never pass. Safety rule 5 stays fail-closed: with a nameless dialog the recipient is verified
// from the armed person, the live URL, the top card name (or the name captured when the engine opened the dialog)
// and the engine's own Connect click. Fakes only (invented profile "Jane Example").
import { afterEach, describe, expect, it } from 'vitest';
import { countSince } from '../src/outreach/limits.js';
import { LIVE_ENV, NOTE, URL_, inviteDialog, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';

const worlds: World[] = [];
const mk = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const clicks = (w: World) => w.page.log.filter((l) => l.startsWith('click'));
const SINCE = new Date('2026-10-01T00:00:00Z');
const NAMELESS = (note = NOTE) => `<dialog open aria-label="Add a note">
<h2>Add a note to your invitation?</h2><textarea>${note}</textarea>
<footer><button>Cancel</button><button>Send without a note</button><button>Send</button></footer></dialog>`;
const NO_TOPCARD = (dialog: string) => profileHtml({ dialog }).replace('<h1>Jane Example</h1>', '');

/** Arm on the open profile, click the top card Connect (the engine's own click), land on the nameless dialog. */
async function opened(dialogPage: (d: string) => string = (d) => profileHtml({ dialog: d })) {
  const w = mk({ html: profileHtml(), env: LIVE_ENV });
  const connect = refOf(await w.snap(), 'button', 'Connect');
  expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE, job_id: 'j1', company: 'Acme' })).status).toBe('armed');
  w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(dialogPage(NAMELESS())); };
  expect(await w.engine.click(connect)).toMatchObject({ ok: true, code: 'dialog_opened' });
  w.page.onAct = undefined;
  return w;
}

describe('commit: nameless invite dialog', () => {
  it('matching top card and same URL: Send is allowed once and the touch becomes sent', async () => {
    const w = await opened();
    const send = refOf(await w.snap(), 'button', 'Send');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml()); };
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(clicks(w)).toHaveLength(2);
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
    expect((w.db.prepare('SELECT status FROM touches WHERE id = ?').get(r.touch_id) as { status: string }).status).toBe('sent');
    expect(w.intents.peek('linkedin')).toBeNull();
  });

  it('Send without a note: the typed note is missing, so the armed text refuses it', async () => {
    const w = await opened();
    w.page.setHtml(profileHtml({ dialog: NAMELESS().replace(/<textarea>.*<\/textarea>/, '') }));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send without a note'));
    expect(r.code).toBe('intent_text_mismatch');
    expect(clicks(w)).toHaveLength(1);
  });

  it('the name captured before the click is used when the modal hides the top card', async () => {
    const w = await opened(NO_TOPCARD);
    const send = refOf(await w.snap(), 'button', 'Send');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml()); };
    expect(await w.engine.click(send)).toMatchObject({ ok: true, status: 'sent' });
  });

  it('top card shows another person: refused, nothing sent', async () => {
    const w = await opened();
    w.page.setHtml(profileHtml({ dialog: NAMELESS() }).replace('<h1>Jane Example</h1>', '<h1>Mallory Evil</h1>'));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('dialog_recipient_mismatch');
    expect(clicks(w)).toHaveLength(1);
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(0);
  });

  it('URL changed since the click: refused', async () => {
    const w = await opened();
    const send = refOf(await w.snap(), 'button', 'Send');
    w.page.currentUrl = 'https://www.linkedin.com/in/mallory-evil/';
    expect((await w.engine.click(send)).code).toBe('profile_url_mismatch');
    expect(clicks(w)).toHaveLength(1);
  });

  it('a new open after the click drops the captured facts: refused even on the same URL', async () => {
    const w = await opened(NO_TOPCARD);
    await w.engine.open(URL_);
    w.page.setHtml(NO_TOPCARD(NAMELESS()));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('dialog_name_unverified');
    expect(clicks(w)).toHaveLength(1);
  });

  it('a dialog that names another person is refused as before', async () => {
    const w = await opened();
    w.page.setHtml(profileHtml({ dialog: inviteDialog({ name: 'Mallory Evil' }) }));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('dialog_recipient_mismatch');
    expect(clicks(w)).toHaveLength(1);
  });

  it('no name in the dialog, none in the top card and none captured: dialog_name_unverified', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    w.page.setHtml(NO_TOPCARD(NAMELESS()));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('dialog_name_unverified');
    expect(clicks(w)).toEqual([]);
  });

  it('a dialog opened by the operator, not by the engine click: no captured facts, refused', async () => {
    const w = mk({ html: profileHtml({ dialog: NAMELESS() }), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('dialog_name_unverified');
    expect(clicks(w)).toEqual([]);
  });
});
