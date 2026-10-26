// LinkedIn "More" dropdown: a menu in a closed shadow root is invisible to the walker but readable through
// locators. Its menuitems become ordinary nodes; Connect needs the armed intent, state-changing items are refused.
// Fakes only (invented profile "Jane Example").
import { afterEach, describe, expect, it } from 'vitest';
import { countSince } from '../src/outreach/limits.js';
import { LOCATOR_BASE, withLocatorDialogs } from '../src/browserctl/locatorDialogs.js';
import { classify } from '../src/browserctl/guard.js';
import { LIVE_ENV, NOTE, URL_, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';
import { shadowWorld, type ShadowWorld } from './helpers/fakeShadowDialog.js';

const SINCE = new Date('2026-10-01T00:00:00Z');
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });

// A profile with a Follow-style layout: no direct Connect control, only More.
function mk(): { w: World; sh: ShadowWorld } {
  const sh = shadowWorld();
  const w = world({ html: profileHtml().replace('<button>Connect</button>', ''), env: LIVE_ENV, wrapPage: (p) => withLocatorDialogs(p, () => sh.page) });
  worlds.push(w);
  w.page.onAct = (what) => {
    if (what.startsWith('click')) sh.openMenu(); // the only walker-visible control the tests click is More
    if (what === 'press Escape') { sh.close(); sh.closeMenu(); }
  };
  return { w, sh };
}
const armNote = (w: World) => w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE, job_id: 'j1', company: 'Acme' });
async function openMore(w: World): Promise<string> {
  expect((await w.engine.click(refOf(await w.snap(), 'button', 'More'))).ok).toBe(true);
  return w.snap();
}

describe('locator menu (More dropdown)', () => {
  it('the menu is invisible to the walker and listed after a snapshot as menuitem nodes with refs', async () => {
    const { w } = mk();
    const state = await openMore(w);
    for (const n of ['Connect', 'Follow', 'Message', 'Save to PDF', 'Report or block']) expect(state).toContain(`menuitem "${n}"`);
    const items = w.engine.lastTree()!.nodes.filter((x) => x.role === 'menuitem');
    expect(items).toHaveLength(5);
    expect(items.every((x) => x.n >= LOCATOR_BASE && x.dialog === undefined)).toBe(true);
  });

  it('flow: More, Connect menuitem (armed), Add a note, type, Send: sent once, ceiling consumed', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    const state = await openMore(w);
    const r = await w.engine.click(refOf(state, 'menuitem', 'Connect'));
    expect(r).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(sh.clicks).toEqual(['menuitem:Connect']);
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'))).code).toBe('clicked');
    const box = refOf(await w.snap(), 'textbox', 'Add a note');
    expect((await w.engine.type(box, NOTE)).code).toBe('typed');
    const sent = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(sent).toMatchObject({ ok: true, status: 'sent' });
    expect(sh.sendCount()).toBe(1);
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
  });

  it('the Connect menuitem without an armed intent is refused and never clicked', async () => {
    const { w, sh } = mk();
    const r = await w.engine.click(refOf(await openMore(w), 'menuitem', 'Connect'));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_armed_intent');
    expect(sh.clicks).toEqual([]);
    expect(sh.isOpen()).toBe(false);
  });

  it.each(['Follow', 'Report or block'])('the %s menuitem is refused even with an armed intent', async (name) => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    const r = await w.engine.click(refOf(await openMore(w), 'menuitem', name));
    expect(r.ok).toBe(false);
    expect(sh.clicks).toEqual([]);
  });

  it.each(['Message', 'Save to PDF'])('the %s menuitem is free', async (name) => {
    const { w, sh } = mk();
    const r = await w.engine.click(refOf(await openMore(w), 'menuitem', name));
    expect(r).toMatchObject({ ok: true, code: 'clicked' });
    expect(sh.clicks).toEqual([`menuitem:${name}`]);
  });

  it('a menuitem ref from an old snapshot is stale', async () => {
    const { w, sh } = mk();
    const state = await openMore(w);
    const old = refOf(state, 'menuitem', 'Message');
    await w.snap();
    const r = await w.engine.click(old);
    expect(r.ok).toBe(false);
    expect(sh.clicks).toEqual([]);
  });

  it('the item is re-read at click: a closed menu means the target is gone', async () => {
    const { w, sh } = mk();
    const ref = refOf(await openMore(w), 'menuitem', 'Message');
    sh.closeMenu();
    const r = await w.engine.click(ref);
    expect(r.ok).toBe(false);
    expect(sh.clicks).toEqual([]);
  });

  it('a menuitem is listed once per snapshot, next to the walker button of the same name', async () => {
    const { w, sh } = mk();
    sh.openMenu(['Message']);
    await w.snap();
    expect(w.engine.lastTree()!.nodes.filter((x) => x.role === 'menuitem')).toHaveLength(1);
  });
});

describe('guard: menu items and options', () => {
  const mi = (name: string, role = 'menuitem') => classify({ platform: 'linkedin', role, name });
  it.each([
    ['Connect', 'commit_connect_send'], ['Invite Jane Example to connect', 'commit_connect_send'],
    ['Follow', 'irreversible_other'], ['Follow Jane Example', 'irreversible_other'], ['Unfollow', 'irreversible_other'],
    ['Remove connection', 'irreversible_other'], ['Block', 'irreversible_other'], ['Report or block', 'irreversible_other'],
    ['Report', 'irreversible_other'], ['Mute', 'irreversible_other'],
    ['Message', 'free'], ['Save to PDF', 'free'], ['Share', 'free'], ['Share profile in a message', 'free'],
  ])('menuitem %s -> %s', (name, want) => { expect(mi(name)).toBe(want); });

  it('an option named Connect is a commit class; other options stay free', () => {
    expect(mi('Connect', 'option')).toBe('commit_connect_send');
    expect(mi('Follow', 'option')).toBe('irreversible_other');
    expect(mi('English', 'option')).toBe('free');
  });
});
