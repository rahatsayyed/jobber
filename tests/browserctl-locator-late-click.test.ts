// LinkedIn invite modal and More menu in a CLOSED shadow root that fill in LATE, and click_at on a point inside them.
// 1. The locator layer polls (bounded) until a dialog or menu has controls, so the snapshot after dialog_opened
//    lists refs for Add a note, Send, Send without a note; arm, Connect, type, Send works end to end.
// 2. Controls still missing after the wait: code dialog_controls_missing (with the dialog kind) and a structural diag.
// 3. linkedin_click_at resolves a point inside the closed shadow root through the locator boxes and then goes through
//    the same guard and commit rules as a click by ref.
// Fakes only (invented profile "Jane Example").
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { countSince } from '../src/outreach/limits.js';
import { withLocatorDialogs } from '../src/browserctl/locatorDialogs.js';
import { LIVE_ENV, NOTE, URL_, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';
import { shadowWorld, type Box, type ShadowWorld } from './helpers/fakeShadowDialog.js';

const SINCE = new Date('2026-10-01T00:00:00Z');
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });

const NEVER = 1_000_000_000;
// One ceiling from the click for the dialog to appear AND fill (OPEN_CEILING_MS, 15 s) plus the settle and one poll of slack.
const WAIT_BUDGET_MS = 15000 + 1500;

function mk(o: { menu?: boolean; fillAfterMs?: number; menuFillAfterMs?: number; appearAfterMs?: number; roleBlind?: boolean; labelOnly?: boolean } = {}): { w: World; sh: ShadowWorld } {
  const sh = shadowWorld();
  const html = o.menu ? profileHtml().replace('<button>Connect</button>', '') : profileHtml();
  const w = world({ html, env: LIVE_ENV, screenshot: true, wrapPage: (p) => withLocatorDialogs(p, () => sh.page) });
  worlds.push(w);
  // Time only passes when the engine waits: every waitMs moves the fake page clock.
  w.page.waitMs = async (ms) => { sh.advance(ms); };
  w.page.onAct = (what) => {
    if (what.startsWith('clickPoint ')) {
      const [x, y] = what.slice('clickPoint '.length).split(',').map(Number);
      sh.mouseClick(x, y);
    } else if (what.startsWith('click ')) {
      if (o.menu) sh.openMenu(undefined, { fillAfterMs: o.menuFillAfterMs ?? 0 });
      else sh.open({ fillAfterMs: o.fillAfterMs ?? 0, appearAfterMs: o.appearAfterMs ?? 0, roleBlind: o.roleBlind === true, labelOnly: o.labelOnly === true });
    }
    if (what === 'press Escape') { sh.close(); sh.closeMenu(); }
  };
  return { w, sh };
}
const armNote = (w: World) => w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE, job_id: 'j1', company: 'Acme' });
const centre = (b: Box | null): { x: number; y: number } => {
  if (!b) throw new Error('control not shown');
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};
/** Snapshot then screenshot at the current epoch: what click_at requires. */
async function ready(w: World): Promise<string> {
  const s = await w.snap();
  expect((await w.engine.screenshot()).ok).toBe(true);
  return s;
}
const clickAtCtl = async (w: World, sh: ShadowWorld, role: string, name: string) => {
  const c = centre(sh.boxOf(role, name));
  return w.engine.clickAt(c.x, c.y);
};
const touchStatus = (w: World): string[] => (w.db.prepare('SELECT status FROM touches').all() as { status: string }[]).map((r) => r.status);

describe('dialog that fills in late', () => {
  it('arm, Connect, snapshot lists the controls as refs, Add a note, type, Send: sent once', async () => {
    const { w, sh } = mk({ fillAfterMs: 3000 });
    expect((await armNote(w)).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    expect(r).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(sh.elapsed()).toBeGreaterThanOrEqual(3000);
    const after = await w.snap();
    for (const n of ['Add a note', 'Send without a note', 'Dismiss']) expect(after).toContain(`button "${n}"`);
    expect((await w.engine.click(refOf(after, 'button', 'Add a note'))).code).toBe('clicked');
    const note = refOf(await w.snap(), 'textbox', 'Add a note');
    expect((await w.engine.type(note, NOTE)).code).toBe('typed');
    expect(sh.fills).toEqual([NOTE]);
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Send'))).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(sh.sendCount()).toBe(1);
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
  });

  it('a plain snapshot taken while the dialog is still empty waits (bounded) and then lists the controls', async () => {
    const { w, sh } = mk();
    sh.open({ fillAfterMs: 3000 });
    const state = await w.snap();
    expect(state).toContain('button "Add a note"');
    expect(state).toContain('button "Send without a note"');
    expect(sh.elapsed()).toBeLessThanOrEqual(15000);
  });

  it('a dialog that never fills: dialog_controls_missing with the kind, touch released, diag written, nothing sent', async () => {
    const { w, sh } = mk({ fillAfterMs: NEVER });
    expect((await armNote(w)).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    expect(r).toMatchObject({ ok: false, status: 'failed', code: 'dialog_controls_missing' });
    expect(r.reason).toContain('dialog kind: invite');
    expect(r.reason).not.toContain(NOTE);
    expect(sh.elapsed()).toBeLessThanOrEqual(WAIT_BUDGET_MS);
    expect(sh.sendCount()).toBe(0);
    expect(touchStatus(w)).toEqual(['no_dialog']);
    const file = /\(diag: (.+)\)/.exec(r.reason ?? '')?.[1];
    expect(file).toBeTruthy();
    const diag = JSON.parse(readFileSync(file!, 'utf8')) as { code: string; locator_dialogs: number; tree_dialogs: { buttons: string[] }[] };
    expect(diag).toMatchObject({ code: 'dialog_controls_missing', locator_dialogs: 1 });
    expect(diag.tree_dialogs.every((d) => d.buttons.length === 0)).toBe(true);
  });

  it('after the wait ran out, later snapshots do not wait again for the same empty dialog', async () => {
    const { w, sh } = mk();
    sh.open({ fillAfterMs: NEVER });
    await w.snap();
    const t = sh.elapsed();
    expect(t).toBeLessThanOrEqual(15000);
    await w.snap();
    await w.snap();
    expect(sh.elapsed()).toBe(t);
  });
});

describe('dialog that appears seconds after the click (live: 4 to 6 s) and whose role tree lists no control', () => {
  it('appears after 5 s and fills 3 s later: dialog_opened, controls are refs, the note flow sends once', async () => {
    const { w, sh } = mk({ appearAfterMs: 5000, fillAfterMs: 3000 });
    expect((await armNote(w)).status).toBe('armed');
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Connect'))).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(sh.elapsed()).toBeGreaterThanOrEqual(8000);
    expect(sh.elapsed()).toBeLessThanOrEqual(WAIT_BUDGET_MS);
    const after = await w.snap();
    for (const n of ['Add a note', 'Send without a note']) expect(after).toContain(`button "${n}"`);
    expect((await w.engine.click(refOf(after, 'button', 'Add a note'))).code).toBe('clicked');
    expect((await w.engine.type(refOf(await w.snap(), 'textbox', 'Add a note'), NOTE)).code).toBe('typed');
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Send'))).toMatchObject({ ok: true, status: 'sent' });
    expect(sh.sendCount()).toBe(1);
  });

  it('a dialog that never appears: no_dialog_after_connect only after the full ceiling, nothing sent', async () => {
    const { w, sh } = mk({ appearAfterMs: NEVER });
    expect((await armNote(w)).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    expect(r).toMatchObject({ ok: false, code: 'no_dialog_after_connect' });
    expect(sh.elapsed()).toBeGreaterThanOrEqual(14000);
    expect(sh.elapsed()).toBeLessThanOrEqual(WAIT_BUDGET_MS);
    expect(sh.sendCount()).toBe(0);
  });

  it('role tree blind (only text, no button): the controls are still read by a CSS locator and the flow sends', async () => {
    const { w, sh } = mk({ roleBlind: true });
    expect((await armNote(w)).status).toBe('armed');
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Connect'))).toMatchObject({ ok: true, code: 'dialog_opened' });
    const after = await w.snap();
    for (const n of ['Add a note', 'Send without a note', 'Dismiss']) expect(after).toContain(`button "${n}"`);
    expect((await w.engine.click(refOf(after, 'button', 'Add a note'))).code).toBe('clicked');
    const note = refOf(await w.snap(), 'textbox', 'Add a note');
    expect((await w.engine.type(note, NOTE)).code).toBe('typed');
    expect(sh.fills).toEqual([NOTE]);
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Send'))).toMatchObject({ ok: true, status: 'sent' });
    expect(sh.sendCount()).toBe(1);
  });

  it('a button whose label is only in aria-label (with a span child) is read by name', async () => {
    const { w, sh } = mk();
    sh.open({ labelOnly: true, roleBlind: true });
    expect(await w.snap()).toContain('button "Send without a note"');
  });

  it('never fills: the diag counts the locator path, the poll time and the node cap (counts only)', async () => {
    const { w, sh } = mk({ fillAfterMs: NEVER, appearAfterMs: 2000 });
    expect((await armNote(w)).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    expect(r.code).toBe('dialog_controls_missing');
    expect(sh.elapsed()).toBeLessThanOrEqual(WAIT_BUDGET_MS);
    const file = /\(diag: (.+)\)/.exec(r.reason ?? '')?.[1];
    const diag = JSON.parse(readFileSync(file!, 'utf8')) as Record<string, unknown>;
    expect(diag).toMatchObject({ found_by: 'locator', node_cap_hit: false });
    expect(diag['waited_ms']).toBeGreaterThanOrEqual(14000);
    expect(diag['aria_hidden_chain']).toEqual({ true: 0, false: 0, absent: expect.any(Number) });
    expect(diag).toHaveProperty('shadow_roots');
    expect(diag).toHaveProperty('closed_host_candidates');
  });
});

describe('More menu that fills in late', () => {
  it('menu items are refs once the menu has them; Connect menuitem (armed) then the note flow sends', async () => {
    const { w, sh } = mk({ menu: true, menuFillAfterMs: 2000 });
    const more = await w.engine.click(refOf(await w.snap(), 'button', 'More'));
    expect(more.ok).toBe(true);
    for (const n of ['Connect', 'Follow', 'Message']) expect(more.state).toContain(`menuitem "${n}"`);
    expect(sh.elapsed()).toBeGreaterThanOrEqual(2000);
    // The arm comes after the More menu was read: with no top-card Connect it needs the menu's Connect.
    expect((await armNote(w)).status).toBe('armed');
    expect(await w.engine.click(refOf(more.state!, 'menuitem', 'Connect'))).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'))).code).toBe('clicked');
    expect((await w.engine.type(refOf(await w.snap(), 'textbox', 'Add a note'), NOTE)).code).toBe('typed');
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Send'))).toMatchObject({ ok: true, status: 'sent' });
    expect(sh.sendCount()).toBe(1);
  });

  it('a menu that never fills: the snapshot ends within the wait, lists no menuitem, and does not wait twice', async () => {
    const { w, sh } = mk({ menu: true, menuFillAfterMs: NEVER });
    const more = await w.engine.click(refOf(await w.snap(), 'button', 'More'));
    expect(more.ok).toBe(true);
    expect(more.state).not.toContain('menuitem');
    const t = sh.elapsed();
    expect(t).toBeLessThanOrEqual(15000);
    await w.snap();
    expect(sh.elapsed()).toBe(t);
  });
});

describe('click_at inside a closed shadow root', () => {
  it('a free control (Add a note) is resolved through the locator box and clicked', async () => {
    const { w, sh } = mk();
    sh.open();
    await ready(w);
    expect(await clickAtCtl(w, sh, 'button', 'Add a note')).toMatchObject({ ok: true, code: 'clicked' });
    expect(sh.clicks).toEqual(['button:Add a note']);
  });

  it('Send without an armed intent: no_armed_intent, nothing clicked', async () => {
    const { w, sh } = mk();
    sh.open();
    await ready(w);
    const r = await clickAtCtl(w, sh, 'button', 'Send without a note');
    expect(r.code).toBe('no_armed_intent');
    expect(sh.sendCount()).toBe(0);
    expect(sh.clicks).toEqual([]);
  });

  it('Send without a note while a note is armed: intent_text_mismatch, nothing sent', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    sh.open();
    await ready(w);
    const r = await clickAtCtl(w, sh, 'button', 'Send without a note');
    expect(r.code).toBe('intent_text_mismatch');
    expect(sh.sendCount()).toBe(0);
  });

  it('armed flow ends with click_at on the Send button: committed once through the normal commit rules', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Connect'))).code).toBe('dialog_opened');
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'))).code).toBe('clicked');
    expect((await w.engine.type(refOf(await w.snap(), 'textbox', 'Add a note'), NOTE)).code).toBe('typed');
    await ready(w);
    expect(await clickAtCtl(w, sh, 'button', 'Send')).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(sh.sendCount()).toBe(1);
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
  });

  it('an unnamed invite dialog (no heading, no aria-label): click_at Send is still classified as the invite send', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    sh.open({ noHeading: true });
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'))).code).toBe('clicked');
    expect((await w.engine.type(refOf(await w.snap(), 'textbox', 'Add a note'), NOTE)).code).toBe('typed');
    await ready(w);
    expect(await clickAtCtl(w, sh, 'button', 'Send')).toMatchObject({ ok: true, status: 'sent' });
    expect(sh.sendCount()).toBe(1);
  });

  it('click_at Send when the typed text differs from the armed note is refused', async () => {
    const { w, sh } = mk();
    expect((await armNote(w)).status).toBe('armed');
    sh.open();
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Add a note'))).code).toBe('clicked');
    expect((await w.engine.type(refOf(await w.snap(), 'textbox', 'Add a note'), NOTE)).code).toBe('typed');
    sh.setBox('a different note');
    await ready(w);
    expect((await clickAtCtl(w, sh, 'button', 'Send')).code).toBe('intent_text_mismatch');
    expect(sh.sendCount()).toBe(0);
  });

  it('a point on the dialog but on no control is unresolvable and clicks nothing', async () => {
    const { w, sh } = mk();
    sh.open();
    await ready(w);
    expect((await w.engine.clickAt(310, 120)).code).toBe('unresolvable_point');
    expect(sh.clicks).toEqual([]);
    expect(w.page.log.some((l) => l.startsWith('clickPoint'))).toBe(false);
  });

  it('a point outside every shadow container falls through to the walker (nothing there: unresolvable)', async () => {
    const { w, sh } = mk();
    sh.open();
    await ready(w);
    expect((await w.engine.clickAt(5, 5)).code).toBe('unresolvable_point');
  });

  it('menu items: Follow is refused, Message is free, Connect needs the arm and then opens the dialog', async () => {
    const { w, sh } = mk({ menu: true });
    // The menu must be opened by an engine click on the top-card More (a menu opened elsewhere is not trusted).
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'More'))).ok).toBe(true);
    await ready(w);
    expect((await clickAtCtl(w, sh, 'menuitem', 'Follow')).code).toBe('irreversible_refused');
    expect((await clickAtCtl(w, sh, 'menuitem', 'Connect')).code).toBe('no_armed_intent');
    expect(sh.clicks).toEqual([]);
    expect((await armNote(w)).status).toBe('armed');
    await ready(w);
    expect(await clickAtCtl(w, sh, 'menuitem', 'Connect')).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(sh.clicks).toEqual(['menuitem:Connect']);
    expect(sh.isOpen()).toBe(true);
    expect(sh.sendCount()).toBe(0);
  });

  it('with no snapshot or screenshot at the current epoch click_at is still refused', async () => {
    const { w, sh } = mk();
    sh.open();
    await w.snap();
    expect((await clickAtCtl(w, sh, 'button', 'Add a note')).code).toBe('screenshot_required');
    expect(sh.clicks).toEqual([]);
  });
});
