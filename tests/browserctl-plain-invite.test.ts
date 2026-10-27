// Note-less invites: the monthly quota of personalized notes ran out live (Premium upsell after "Add a note").
// connect_plain arms no text and may click ONLY "Send without a note"; the upsell becomes custom_note_limit_reached,
// stored until the 1st of next month (IST). Fakes only (invented profile "Jane Example"); the upsell markup is a guess.
import { afterEach, describe, expect, it } from 'vitest';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { noteQuotaModal } from '../src/browserctl/sendSignals.js';
import { NOTE_QUOTA_KEY, nextMonthStartIst, noteQuotaUntil } from '../src/linkedin/noteQuota.js';
import { countSince } from '../src/outreach/limits.js';
import { LIVE_ENV, NOTE, NOW, URL_, inviteDialog, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';

const worlds: World[] = [];
const mk = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const SINCE = new Date('2026-10-01T00:00:00Z');
const NOTE_DIALOG = `<dialog open aria-label="Add a note"><h2>Add a note to your invitation?</h2>
<footer><button>Cancel</button><button>Add a note</button><button>Send without a note</button></footer></dialog>`;
const UPSELL = `<dialog open aria-label="Premium"><h2>Personalize invites with Premium</h2>
<p>You have reached your monthly limit of personalized invitations.</p><button>Try Premium</button><button>Dismiss</button></dialog>`;
const touch = (w: World, id: unknown) => w.db.prepare('SELECT status, body FROM touches WHERE id = ?').get(id) as { status: string; body: string | null };
const connections = (w: World) => w.db.prepare('SELECT note, status FROM connections').all() as { note: string; status: string }[];

/** Arm, click the top card Connect (the engine's own click) and land on the invite dialog. */
async function opened(kind: 'connect_note' | 'connect_plain') {
  const w = mk({ html: profileHtml(), env: LIVE_ENV });
  const connect = refOf(await w.snap(), 'button', 'Connect');
  const armed = await w.arm({ kind, profile_url: URL_, ...(kind === 'connect_note' ? { text: NOTE } : {}), job_id: 'j1', company: 'Acme' });
  expect(armed.status).toBe('armed');
  w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: NOTE_DIALOG })); };
  expect(await w.engine.click(connect)).toMatchObject({ ok: true, code: 'dialog_opened' });
  w.page.onAct = undefined;
  return { w, touchId: armed.touch_id };
}

describe('connect_plain', () => {
  it('end to end: Connect, dialog, Send without a note: sent touch with no body, empty connection note, ceiling used', async () => {
    const { w, touchId } = await opened('connect_plain');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml()); };
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send without a note'));
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent', touch_id: touchId });
    expect(touch(w, touchId)).toEqual({ status: 'sent', body: null });
    expect(connections(w)).toEqual([{ note: '', status: 'sent' }]);
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
    expect(w.intents.peek('linkedin')).toBeNull();
  });

  it('the arm takes no text, and a second plain invite to the same person is refused after the first was sent', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    expect(await w.arm({ kind: 'connect_plain', profile_url: URL_, text: 'hello' })).toMatchObject({ status: 'refused', code: 'text_not_allowed' });
    const a = await w.arm({ kind: 'connect_plain', profile_url: URL_ });
    expect(a).toMatchObject({ status: 'armed', class: 'commit_connect_send' });
    expect(w.intents.peek('linkedin')?.text).toBeNull();
    w.db.prepare("UPDATE touches SET status = 'sent' WHERE id = ?").run(a.touch_id);
    expect(await w.arm({ kind: 'connect_plain', profile_url: URL_ })).toMatchObject({ status: 'refused', code: 'already_sent' });
  });

  it('keeps the other gates: an unknown recipient is refused at arm', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV, seed: false });
    expect(await w.arm({ kind: 'connect_plain', profile_url: URL_ })).toMatchObject({ status: 'refused', code: 'unknown_recipient' });
  });

  it('a Send or Send invitation click is refused, nothing is sent and the touch is released', async () => {
    const { w, touchId } = await opened('connect_plain');
    w.page.setHtml(profileHtml({ dialog: NOTE_DIALOG.replace('<button>Send without a note</button>', '<button>Send invitation</button>') }));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send invitation'));
    expect(r.code).toBe('plain_invite_send_only');
    expect(w.page.log.filter((l) => l.startsWith('click'))).toHaveLength(1);
    expect(touch(w, touchId).status).toBe('failed');
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(0);
  });

  it('"Add a note" is refused under connect_plain and nothing can be typed', async () => {
    const { w } = await opened('connect_plain');
    const state = await w.snap();
    const r = await w.engine.click(refOf(state, 'button', 'Add a note'));
    expect(r.code).toBe('plain_invite_no_note');
    expect(w.page.log.filter((l) => l.startsWith('click'))).toHaveLength(1);
    w.page.setHtml(profileHtml({ dialog: inviteDialog() }));
    const t = await w.engine.type(refOf(await w.snap(), 'textbox', ''), NOTE);
    expect(t.ok).toBe(false);
    expect(w.page.log.some((l) => l.startsWith('fill'))).toBe(false);
  });
});

describe('note quota', () => {
  it('the upsell after "Add a note": custom_note_limit_reached, key stored, touch failed, retry once with connect_plain', async () => {
    const { w, touchId } = await opened('connect_note');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: UPSELL })); };
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'));
    w.page.onAct = undefined;
    expect(r).toMatchObject({ ok: false, status: 'failed', code: 'custom_note_limit_reached' });
    expect(w.page.log).toContain('press Escape');
    expect(touch(w, touchId).status).toBe('failed');
    expect(noteQuotaUntil(w.db, NOW)?.toISOString()).toBe(nextMonthStartIst(NOW).toISOString());
    expect(nextMonthStartIst(NOW).toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(0);

    // The key is set: a note is refused at arm, the same person is retried without one and goes out.
    w.page.setHtml(profileHtml());
    expect(await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).toMatchObject({ status: 'refused', code: 'note_quota_exhausted' });
    await w.engine.open(URL_);
    const connect = refOf(await w.snap(), 'button', 'Connect');
    const plain = await w.arm({ kind: 'connect_plain', profile_url: URL_ });
    expect(plain.status).toBe('armed');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: NOTE_DIALOG })); };
    expect(await w.engine.click(connect)).toMatchObject({ code: 'dialog_opened' });
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml()); };
    const sent = await w.engine.click(refOf(await w.snap(), 'button', 'Send without a note'));
    expect(sent).toMatchObject({ ok: true, status: 'sent' });
    expect(touch(w, sent.touch_id)).toEqual({ status: 'sent', body: null });
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
  });

  it('the key expires on the 1st of next month (IST) and is cleared', async () => {
    const { w } = await opened('connect_note');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: UPSELL })); };
    await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'));
    const until = noteQuotaUntil(w.db, NOW)!;
    expect(noteQuotaUntil(w.db, new Date(until.getTime() - 1))).not.toBeNull();
    expect(noteQuotaUntil(w.db, until)).toBeNull();
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM scheduler_state WHERE key = ?').get(NOTE_QUOTA_KEY)).toEqual({ n: 0 });
  });

  it('the normal note dialog is not the upsell', () => {
    expect(noteQuotaModal(buildTreeFromHtml(profileHtml({ dialog: inviteDialog() }), URL_))).toBe(false);
    expect(noteQuotaModal(buildTreeFromHtml(profileHtml({ dialog: NOTE_DIALOG }), URL_))).toBe(false);
    expect(noteQuotaModal(buildTreeFromHtml(profileHtml({ dialog: UPSELL }), URL_))).toBe(true);
  });
});
