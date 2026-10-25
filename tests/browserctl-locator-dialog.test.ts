// LinkedIn invite modal in a CLOSED shadow root: the walker never sees it, locators do. The engine reads and
// acts on it through the locator dialog layer with the same guard, epoch, re-describe and armed-intent rules.
// Fakes only (invented profile "Jane Example").
import { afterEach, describe, expect, it } from 'vitest';
import { countSince } from '../src/outreach/limits.js';
import { listDryRun } from '../src/safety/dryRun.js';
import { LOCATOR_BASE, withLocatorDialogs } from '../src/browserctl/locatorDialogs.js';
import { LIVE_ENV, NOTE, URL_, inviteDialog, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';
import { shadowWorld, type ShadowWorld } from './helpers/fakeShadowDialog.js';

const DRY_ENV = { JOBBER_DRY_RUN: 'true' };
const SINCE = new Date('2026-10-01T00:00:00Z');
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });

function mk(env: Record<string, string> = LIVE_ENV, html = profileHtml()): { w: World; sh: ShadowWorld } {
  const sh = shadowWorld();
  const w = world({ html, env, wrapPage: (p) => withLocatorDialogs(p, () => sh.page) });
  worlds.push(w);
  // The page reacts: Connect opens the (walker-invisible) modal, Escape closes it.
  w.page.onAct = (what) => {
    if (what.startsWith('click')) sh.open();
    if (what === 'press Escape') sh.close();
  };
  return { w, sh };
}
const armNote = (w: World, text = NOTE) => w.arm({ kind: 'connect_note', profile_url: URL_, text, job_id: 'j1', company: 'Acme' });
const walkerClicks = (w: World) => w.page.log.filter((l) => l.startsWith('click'));

/** Open the modal by hand, snapshot it, and click "Add a note" so the textbox is there. */
async function toNoteStep(w: World, sh: ShadowWorld): Promise<string> {
  sh.open();
  const add = refOf(await w.snap(), 'button', 'Add a note');
  expect((await w.engine.click(add)).code).toBe('clicked');
  return w.snap();
}

describe('locator-only dialog', () => {
  it('Connect opens it: dialog_opened, and the snapshot lists its controls with refs', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    expect(r).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(sh.isOpen()).toBe(true);
    const state = await w.snap();
    for (const name of ['Dismiss', 'Add a note', 'Send without a note']) expect(state).toContain(`button "${name}"`);
    expect(state).toContain('dialog');
    // The ordinals come from the locator layer, not from data-bc stamps.
    const t = w.engine.lastTree()!;
    expect(t.nodes.filter((x) => x.role === 'dialog').every((x) => x.n >= LOCATOR_BASE)).toBe(true);
    expect(sh.sendCount()).toBe(0);
  });

  it('refs of locator nodes resolve and re-describe live', async () => {
    const { w, sh } = mk();
    sh.open();
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'));
    expect(r).toMatchObject({ ok: true, code: 'clicked' });
    expect(sh.clicks).toEqual(['button:Add a note']);
    // After the click the old refs are stale (epoch moved) and refused.
    const stale = refOf(await w.snap(), 'button', 'Dismiss');
    await w.snap();
    expect((await w.engine.click(stale)).ok).toBe(false);
  });

  it('full flow: Connect, Add a note, type the exact note, Send: sent once, ceiling consumed', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Connect'))).code).toBe('dialog_opened');
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'))).code).toBe('clicked');
    const state = await w.snap();
    expect((await w.engine.type(refOf(state, 'textbox', 'Add a note'), NOTE)).code).toBe('typed');
    expect(sh.fills).toEqual([NOTE]);
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(sh.sendCount()).toBe(1);
    expect(sh.isOpen()).toBe(false);
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
  });

  it('typing a different text than the armed note is refused', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    const state = await toNoteStep(w, sh);
    const r = await w.engine.type(refOf(state, 'textbox', 'Add a note'), 'something else entirely');
    expect(r.ok).toBe(false);
    expect(sh.fills).toEqual([]);
  });

  it('Send without an armed intent is refused and nothing is clicked', async () => {
    const { w, sh } = mk();
    const state = await toNoteStep(w, sh);
    const r = await w.engine.click(refOf(state, 'button', 'Send'));
    expect(r.code).toBe('no_armed_intent');
    expect(sh.sendCount()).toBe(0);
    expect(sh.clicks).toEqual(['button:Add a note']);
  });

  it('Send is refused when the live textbox text differs from the armed text', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    const state = await toNoteStep(w, sh);
    expect((await w.engine.type(refOf(state, 'textbox', 'Add a note'), NOTE)).code).toBe('typed');
    sh.setBox('a different note');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('intent_text_mismatch');
    expect(sh.sendCount()).toBe(0);
  });

  it('"Send without a note" is refused when a note was armed (the note was never typed)', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    sh.open();
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send without a note'));
    expect(r.code).toBe('intent_text_mismatch');
    expect(sh.sendCount()).toBe(0);
    expect(sh.isOpen()).toBe(false); // the refusal closes the dialog (Escape)
  });

  it('"Send without a note" with no armed intent is refused', async () => {
    const { w, sh } = mk();
    sh.open();
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Send without a note'))).code).toBe('no_armed_intent');
    expect(sh.sendCount()).toBe(0);
  });

  it('a modal that addresses another person is refused', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    sh.open({ name: 'Mallory Evil' });
    await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'));
    sh.open({ name: 'Mallory Evil' });
    await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'));
    const state = await w.snap();
    await w.engine.type(refOf(state, 'textbox', 'Add a note'), NOTE);
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('dialog_recipient_mismatch');
    expect(sh.sendCount()).toBe(0);
  });

  it('dry run records instead of clicking Send', async () => {
    const { w, sh } = mk(DRY_ENV);
    expect(await armNote(w)).toMatchObject({ status: 'armed', dry_run: true });
    const state = await toNoteStep(w, sh);
    expect((await w.engine.type(refOf(state, 'textbox', 'Add a note'), NOTE)).code).toBe('typed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r).toMatchObject({ ok: true, status: 'dry_run' });
    expect(sh.sendCount()).toBe(0);
    expect(w.page.log).toContain('press Escape');
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(0);
    expect(listDryRun(w.db).map((x) => x.action)).toContain('linkedin_commit_connect_send');
  });

  it('Dismiss is free: it closes the dialog without an arm', async () => {
    const { w, sh } = mk();
    sh.open();
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Dismiss'));
    expect(r).toMatchObject({ ok: true, code: 'clicked' });
    expect(sh.clicks).toEqual(['button:Dismiss']);
    expect(sh.isOpen()).toBe(false);
    expect(await w.snap()).not.toContain('Send without a note');
  });

  it('no dialog for either view: no_dialog_after_connect, diag carries locator_dialogs 0', async () => {
    const { w, sh } = mk();
    w.page.onAct = undefined;
    expect((await armNote(w)).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    expect(r).toMatchObject({ status: 'failed', code: 'no_dialog_after_connect' });
    expect(sh.isOpen()).toBe(false);
  });

  it('the walker wins when it sees the dialog too: nothing is added', async () => {
    const { w, sh } = mk(LIVE_ENV, profileHtml({ dialog: inviteDialog() }));
    sh.open();
    await w.snap();
    expect(w.engine.lastTree()!.nodes.some((x) => x.n >= LOCATOR_BASE)).toBe(false);
  });

  it('diag reports the locator view: dialog count and button names only', async () => {
    const sh = shadowWorld();
    const w = world({ html: profileHtml(), env: LIVE_ENV });
    worlds.push(w);
    const bc = withLocatorDialogs(w.page, () => sh.page);
    expect((await bc.diag?.())).toMatchObject({ locatorDialogs: 0, locatorDialogButtons: [] });
    sh.open();
    await bc.snapshot();
    expect(await bc.diag?.()).toMatchObject({ locatorDialogs: 1, locatorDialogButtons: ['Dismiss', 'Add a note', 'Send without a note'] });
  });
});
