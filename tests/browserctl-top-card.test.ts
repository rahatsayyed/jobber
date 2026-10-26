// A Connect click on a LinkedIn profile is legal only in the profile's own top card (or in the More menu opened
// from it). A Connect in a sidebar or recommendation card sends an invitation directly, so it is refused before
// any click. Fakes only (invented profile "Jane Example"; the sidebar people are invented too).
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { connectionStateOf } from '../src/browserctl/topCard.js';
import { connectPlacementRefusal } from '../src/browserctl/guard.js';
import { LIVE_ENV, NOTE, URL_, inviteDialog, refOf, world, type World } from './helpers/bcWorld.js';

const worlds: World[] = [];
const mk = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const clicks = (w: World) => w.page.log.filter((l) => l.startsWith('click'));

const SIDEBAR_CARD = `<aside><h2>People also viewed</h2><ul>
<li><a href="/in/other-person/">Other Person</a><p>Engineer at Globex</p><button aria-label="Invite Other Person to connect">Connect</button></li>
</ul></aside>`;
const MODULE_CARD = `<section><h2>More profiles for you</h2><div><button>Connect</button></div></section>`;
const CARD_NO_ASIDE = `<ul><li><a href="/in/third-person/">Third Person</a><button>Connect</button></li></ul>`;

interface P { before?: string; after?: string; actions?: string; degree?: string; menu?: string; dialog?: string }
const page = (o: P = {}): string => `<html><head><title>Jane Example | LinkedIn</title></head><body><main>
${o.before ?? ''}
<section><h1>Jane Example</h1><p>${o.degree ?? '· 3rd'}</p><p>Technical Recruiter at Acme</p>
${o.actions ?? '<button>Connect</button><button>Message</button><button>More</button><button>Follow</button>'}
${o.menu ?? ''}</section>
${o.after ?? ''}
${o.dialog ?? ''}
</main></body></html>`;
const MENU = (items: string[]) => `<div role="menu">${items.map((i) => `<button role="menuitem">${i}</button>`).join('')}</div>`;

const regionsOf = (html: string, url = URL_) => buildTreeFromHtml(html, url).nodes
  .filter((x) => x.role === 'button' || x.role === 'link' || x.role === 'menuitem')
  .map((x) => `${x.name}:${x.region ?? '-'}`);

describe('regions in the snapshot', () => {
  it('tags the profile own action row as topcard and sidebar or module cards as sidebar', () => {
    const r = regionsOf(page({ before: SIDEBAR_CARD, after: MODULE_CARD + CARD_NO_ASIDE }));
    expect(r).toContain('Connect:topcard');
    expect(r.filter((x) => x === 'Connect:topcard')).toHaveLength(1);
    expect(r).toContain('Invite Other Person to connect:sidebar');
    expect(r.filter((x) => x === 'Connect:sidebar')).toHaveLength(1);
    expect(r.filter((x) => x === 'Connect:main')).toHaveLength(1);
    expect(r).toContain('More:topcard');
  });

  it('puts no region on a page that is not a profile', () => {
    const t = buildTreeFromHtml(page(), 'https://www.linkedin.com/jobs/search/');
    expect(t.nodes.every((x) => x.region === undefined)).toBe(true);
  });

  it('renders the region on controls and the computed connection state in the header', async () => {
    const w = mk({ html: page({ before: SIDEBAR_CARD }), env: LIVE_ENV });
    const s = await w.snap();
    expect(s).toMatch(/button "Connect" @topcard/);
    expect(s).toMatch(/button "Invite Other Person to connect" @sidebar/);
    expect(s).toMatch(/connect_state: connectable/);
  });

  it('a Connect in the menu opened from the top card is region menu', () => {
    const r = regionsOf(page({ actions: '<button>Message</button><button>More</button>', menu: MENU(['Connect', 'Save to PDF']) }));
    expect(r).toContain('Connect:menu');
  });
});

describe('connection state from the top card and the More menu', () => {
  const st = (html: string) => connectionStateOf(buildTreeFromHtml(html, URL_))?.state;

  it('a top-card Connect is connectable, whatever the sidebar shows', () => {
    expect(st(page({ before: SIDEBAR_CARD }))).toBe('connectable');
  });
  it('a sidebar Connect alone is never connectable', () => {
    expect(st(page({ actions: '<button>Message</button><button>More</button>', before: SIDEBAR_CARD, after: MODULE_CARD }))).toBe('check_more');
  });
  it('no top-card Connect and More not opened yet: check_more', () => {
    expect(st(page({ actions: '<button>Message</button><button>Follow</button><button>More</button>' }))).toBe('check_more');
  });
  it('More menu with Connect or Personalize invite: via_more', () => {
    const a = '<button>Message</button><button>More</button>';
    expect(st(page({ actions: a, menu: MENU(['Connect', 'Save to PDF']) }))).toBe('via_more');
    expect(st(page({ actions: a, menu: MENU(['Personalize invite', 'Save to PDF']) }))).toBe('via_more');
  });
  it('More menu with neither: not_connectable (1st degree or follow only)', () => {
    expect(st(page({ actions: '<button>Message</button><button>More</button>', menu: MENU(['Save to PDF', 'Report / Block']), degree: '· 1st' }))).toBe('not_connectable');
  });
  it('no More button and no Connect: not_connectable', () => {
    expect(st(page({ actions: '<button>Message</button>', degree: '· 1st' }))).toBe('not_connectable');
  });
  it('Pending or Withdraw in the top card: already_pending', () => {
    expect(st(page({ actions: '<button>Pending</button><button>Message</button><button>More</button>' }))).toBe('already_pending');
    expect(st(page({ actions: '<button>Withdraw</button><button>More</button>' }))).toBe('already_pending');
  });
  it('a Pending in a sidebar card does not count', () => {
    expect(st(page({ after: '<ul><li><a href="/in/other-person/">Other</a><button>Pending</button></li></ul>' }))).toBe('connectable');
  });
});

describe('connectPlacementRefusal (pure)', () => {
  const n = (o: object) => ({ role: 'button', name: 'Connect', ...o });
  const P = 'Jane Example';
  it('allows the top card, a menu after More, and any dialog control', () => {
    expect(connectPlacementRefusal(n({ region: 'topcard' }), false, P)).toBeNull();
    expect(connectPlacementRefusal(n({ region: 'topcard', role: 'link', name: 'Invite Jane Example to connect' }), false, P)).toBeNull();
    expect(connectPlacementRefusal(n({ region: 'menu', role: 'link' }), true, P)).toBeNull();
    expect(connectPlacementRefusal(n({ region: 'menu', name: 'Personalize invite' }), true, P)).toBeNull();
    expect(connectPlacementRefusal(n({ region: 'dialog', dialog: 3, name: 'Send' }), false, P)).toBeNull();
  });
  it('refuses sidebar, main, a menu not opened from the top card, and a page without regions', () => {
    for (const r of [{ region: 'sidebar' }, { region: 'main' }, {}]) expect(connectPlacementRefusal(n(r), true, P)?.code).toBe('connect_not_top_card');
    expect(connectPlacementRefusal(n({ region: 'menu', role: 'menuitem' }), false, P)?.code).toBe('connect_not_top_card');
  });
  it('an "Invite X to connect" control must name the profile person, even inside the top card', () => {
    expect(connectPlacementRefusal(n({ region: 'topcard', name: 'Invite Other Person to connect' }), false, P)?.code).toBe('connect_not_top_card');
    expect(connectPlacementRefusal(n({ region: 'topcard', name: 'Invite Jane Example to connect' }), false, '')?.code).toBe('connect_not_top_card');
    expect(connectPlacementRefusal(n({ region: 'topcard', name: 'Invite Jane Example, PhD to connect' }), false, P)).toBeNull();
    // a named invite is never a menu row
    expect(connectPlacementRefusal(n({ region: 'menu', name: 'Invite Jane Example to connect' }), true, P)?.code).toBe('connect_not_top_card');
  });
  it('ignores controls that are not connect controls', () => {
    expect(connectPlacementRefusal(n({ name: 'Message', region: 'sidebar' }), false, P)).toBeNull();
  });
});

// Structures replayed from a live read-only probe: the top-card Connect is a LINK "Invite <Name> to connect", the
// "More profiles for you" cards are BUTTONS "Invite <Other> to connect" later in the tree, and the More menu rows are
// plain links and buttons (no menu or menuitem role) that appear in a portal after the More click.
describe('live structures', () => {
  const LINK_CONNECT = '<a href="/preload/custom-invite/?vanityName=jane-example">Invite Jane Example to connect</a><a href="/messaging/compose/">Message</a><button>More</button>';
  const CARDS = `<h2>Activity</h2><a href="/feed/follow/">Follow</a><h2>More profiles for you</h2>
<button>Invite Other Person to connect</button><button>Invite Third Person to connect</button>`;
  const ROWS_NO_CONNECT = '<div class="portal"><a href="/x/">Send profile in a message</a><button>Save to PDF</button><a href="/f/">Follow</a><button>Report Jane Example</button><button>Block Jane Example</button><a href="/a/">About this member</a></div>';
  const MORE_ACTIONS = '<a href="/messaging/compose/">Message</a><button>More</button>';

  it('the top-card link is the only clickable Connect; the card buttons are refused', async () => {
    const html = page({ actions: LINK_CONNECT, after: CARDS });
    expect(regionsOf(html)).toContain('Invite Jane Example to connect:topcard');
    const w = mk({ html, env: LIVE_ENV });
    const state = await w.snap();
    expect(state).toMatch(/connect_state: connectable/);
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    expect((await w.engine.click(refOf(state, 'button', 'Invite Other Person to connect'))).code).toBe('connect_not_top_card');
    expect(clicks(w)).toEqual([]);
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions: LINK_CONNECT, dialog: inviteDialog() })); };
    expect(await w.engine.click(refOf(state, 'link', 'Invite Jane Example to connect'))).toMatchObject({ ok: true, code: 'dialog_opened' });
  });

  it('a card button that names another person is refused even if it sits in the top-card row', async () => {
    const html = page({ actions: '<button>Message</button><button>More</button><button>Invite Other Person to connect</button>' });
    const w = mk({ html, env: LIVE_ENV });
    const state = await w.snap();
    expect((await w.engine.click(refOf(state, 'button', 'Invite Other Person to connect'))).code).toBe('connect_not_top_card');
    expect(clicks(w)).toEqual([]);
  });

  it('More rows that are plain links and buttons in a portal are read as the menu (diff after the More click)', async () => {
    const w = mk({ html: page({ actions: MORE_ACTIONS, after: CARDS }), env: LIVE_ENV });
    const more = refOf(await w.snap(), 'button', 'More');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions: MORE_ACTIONS, after: CARDS + ROWS_NO_CONNECT })); };
    const opened = await w.engine.click(more);
    expect(opened.state).toMatch(/connect_state: not_connectable/);
    expect(await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).toMatchObject({ code: 'not_connectable' });
  });

  it('a portal row Connect after More is clickable', async () => {
    const w = mk({ html: page({ actions: MORE_ACTIONS, after: CARDS }), env: LIVE_ENV });
    const more = refOf(await w.snap(), 'button', 'More');
    const rows = '<div class="portal"><button>Connect</button><button>Save to PDF</button></div>';
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions: MORE_ACTIONS, after: CARDS + rows })); };
    const opened = await w.engine.click(more);
    expect(opened.state).toMatch(/connect_state: via_more/);
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions: MORE_ACTIONS, dialog: inviteDialog() })); };
    expect(await w.engine.click(refOf(opened.state!, 'button', 'Connect'))).toMatchObject({ ok: true, code: 'dialog_opened' });
  });

  it('a named card button that appears after More is not a menu row and stays refused', async () => {
    const w = mk({ html: page({ actions: MORE_ACTIONS }), env: LIVE_ENV });
    const more = refOf(await w.snap(), 'button', 'More');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions: MORE_ACTIONS, after: '<button>Invite Late Person to connect</button>' })); };
    const opened = await w.engine.click(more);
    expect((await w.engine.click(refOf(opened.state!, 'button', 'Invite Late Person to connect'))).code).toBe('connect_not_top_card');
  });

  // Owner's DOM: every More row is an <a>; its label is on the <a> or on a <div aria-label> inside it.
  const rowA = (label: string) => `<a href="/r/" aria-label="${label}"><span>${label}</span></a>`;
  const rowDiv = (label: string) => `<a href="/r/"><div aria-label="${label}"><svg></svg></div></a>`;
  for (const [shape, row] of [['label on the <a>', rowA], ['label on a div inside the <a>', rowDiv]] as const) {
    it(`More rows with the ${shape}: Personalize invite is read and clicked, other rows are refused`, async () => {
      const w = mk({ html: page({ actions: MORE_ACTIONS, after: CARDS }), env: LIVE_ENV });
      const more = refOf(await w.snap(), 'button', 'More');
      const portal = `<div class="portal">${['Personalize invite', 'Follow', 'Save to PDF', 'Send profile in a message', 'Report Jane Example', 'Block Jane Example', 'About this member'].map(row).join('')}</div>`;
      w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions: MORE_ACTIONS, after: CARDS + portal })); };
      const opened = await w.engine.click(more);
      expect(opened.state).toMatch(/connect_state: via_more/);
      expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
      for (const name of ['Follow', 'Save to PDF', 'Send profile in a message', 'Report Jane Example', 'Block Jane Example', 'About this member']) {
        const r = await w.engine.click(refOf(opened.state!, 'link', name));
        expect(r.ok).toBe(false);
        expect(['menu_row_not_allowed', 'irreversible_refused']).toContain(r.code);
      }
      expect(clicks(w)).toHaveLength(1);
      w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions: MORE_ACTIONS, dialog: inviteDialog() })); };
      expect(await w.engine.click(refOf(opened.state!, 'link', 'Personalize invite'))).toMatchObject({ ok: true, code: 'dialog_opened' });
    });
  }

  it('a top-card Connect link with the name on a descendant div is read and clickable', async () => {
    const link = '<a href="/preload/custom-invite/?vanityName=jane-example"><div aria-label="Invite Jane Example to connect"></div></a><a href="/m/">Message</a><button>More</button>';
    const w = mk({ html: page({ actions: link }), env: LIVE_ENV });
    const state = await w.snap();
    expect(state).toMatch(/link "Invite Jane Example to connect" @topcard/);
    expect(state).toMatch(/connect_state: connectable/);
  });

  it('More clicked and no new row at all: a structural diag is written', async () => {
    const w = mk({ html: page({ actions: '<button>Message</button><button>More</button>' }), env: LIVE_ENV });
    const more = refOf(await w.snap(), 'button', 'More');
    const r = await w.engine.click(more);
    expect(r.state).toMatch(/connect_state: check_more/);
    const dir = path.join(path.dirname(w.stopFile), 'diag');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(dir, files[0]!), 'utf8')).code).toBe('more_menu_missing');
  });
});

describe('engine: only the top-card Connect is clickable', () => {
  const armed = async (html: string, o: Partial<Parameters<typeof world>[0]> = {}) => {
    const w = mk({ html, env: LIVE_ENV, ...o });
    const state = await w.snap();
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    return { w, state };
  };

  it('a sidebar Connect earlier in the DOM is refused and nothing is clicked; the top-card one works', async () => {
    const { w, state } = await armed(page({ before: SIDEBAR_CARD, after: MODULE_CARD }));
    const side = refOf(state, 'button', 'Invite Other Person to connect');
    expect(await w.engine.click(side)).toMatchObject({ ok: false, code: 'connect_not_top_card' });
    const mod = refOf(state, 'button', 'Connect', 1);
    expect((await w.engine.click(mod)).code).toBe('connect_not_top_card');
    expect(clicks(w)).toEqual([]);
    const top = refOf(state, 'button', 'Connect', 0);
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ dialog: inviteDialog() })); };
    expect(await w.engine.click(top)).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(clicks(w)).toHaveLength(1);
  });

  it('the refusal does not need an armed intent', async () => {
    const w = mk({ html: page({ before: SIDEBAR_CARD }), env: LIVE_ENV });
    const state = await w.snap();
    expect((await w.engine.click(refOf(state, 'button', 'Invite Other Person to connect'))).code).toBe('connect_not_top_card');
    expect(clicks(w)).toEqual([]);
  });

  it('click_at on a sidebar Connect is refused the same way', async () => {
    const w = mk({ html: page({ before: SIDEBAR_CARD }), env: LIVE_ENV, screenshot: true });
    const state = await w.snap();
    await w.engine.screenshot();
    const n = Number(/\[s\d+\.(\d+)\] button "Invite Other Person to connect"/.exec(state)![1]);
    w.page.points.set('10,10', n);
    expect(await w.engine.clickAt(10, 10)).toMatchObject({ ok: false, code: 'connect_not_top_card' });
    expect(w.page.log.some((l) => l.startsWith('clickPoint'))).toBe(false);
  });

  it('a profile whose Connect is only in More: click More, then the menu Connect works', async () => {
    const actions = '<button>Message</button><button>More</button><button>Follow</button>';
    const w = mk({ html: page({ actions }), env: LIVE_ENV });
    const more = refOf(await w.snap(), 'button', 'More');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions, menu: MENU(['Connect', 'Save to PDF']) })); };
    const opened = await w.engine.click(more);
    expect(opened.state).toMatch(/connect_state: via_more/);
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const item = refOf(opened.state!, 'menuitem', 'Connect');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions, dialog: inviteDialog() })); };
    expect(await w.engine.click(item)).toMatchObject({ ok: true, code: 'dialog_opened' });
  });

  it('a menu Connect that was not opened from the top-card More is refused', async () => {
    const actions = '<button>Message</button><button>More</button>';
    const { w, state } = await armed(page({ actions, menu: MENU(['Connect']) }));
    expect((await w.engine.click(refOf(state, 'menuitem', 'Connect'))).code).toBe('connect_not_top_card');
    expect(clicks(w)).toEqual([]);
  });

  it('Personalize invite in the More menu is a connect control and needs the arm', async () => {
    const actions = '<button>Message</button><button>More</button>';
    const w = mk({ html: page({ actions }), env: LIVE_ENV });
    const more = refOf(await w.snap(), 'button', 'More');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions, menu: MENU(['Personalize invite']) })); };
    const opened = await w.engine.click(more);
    const item = refOf(opened.state!, 'menuitem', 'Personalize invite');
    expect((await w.engine.click(item)).code).toBe('no_armed_intent');
    expect(clicks(w)).toHaveLength(1);
  });

  it('arm refuses not_connectable when More shows no Connect and already_pending for Pending', async () => {
    const actions = '<button>Message</button><button>More</button>';
    const a = mk({ html: page({ actions, menu: MENU(['Save to PDF']), degree: '· 3rd' }), env: LIVE_ENV });
    await a.snap();
    expect(await a.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).toMatchObject({ status: 'refused', code: 'not_connectable' });
    const b = mk({ html: page({ actions: '<button>Pending</button><button>More</button>' }), env: LIVE_ENV });
    await b.snap();
    expect(await b.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).toMatchObject({ status: 'refused', code: 'already_pending' });
  });

  it('arm refuses when More was not read yet (no top-card Connect, no menu)', async () => {
    const w = mk({ html: page({ actions: '<button>Message</button><button>More</button>' }), env: LIVE_ENV });
    await w.snap();
    expect(await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).toMatchObject({ status: 'refused', code: 'more_not_checked' });
  });

  it('a sidebar Connect does not make a connected person look connectable at arm', async () => {
    const w = mk({ html: page({ before: SIDEBAR_CARD, actions: '<button>Message</button><button>More</button>', degree: '· 1st' }), env: LIVE_ENV });
    await w.snap();
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).code).toBe('already_connected');
  });

  it('the commit refuses when the browser left the armed profile', async () => {
    const { w, state } = await armed(page());
    w.page.currentUrl = 'https://www.linkedin.com/in/someone-else/';
    expect((await w.engine.click(refOf(state, 'button', 'Connect'))).code).toBe('profile_url_mismatch');
    expect(clicks(w)).toEqual([]);
  });
});

describe('a Connect click that sends directly', () => {
  const armedTop = async () => {
    const w = mk({ html: page(), env: LIVE_ENV });
    const connect = refOf(await w.snap(), 'button', 'Connect');
    const r = await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE });
    expect(r.status).toBe('armed');
    return { w, connect, touchId: r.touch_id! };
  };
  const touch = (w: World, id: number) => w.db.prepare('SELECT status, body, sent_at FROM touches WHERE id = ?').get(id) as { status: string; body: string | null; sent_at: string | null };

  it('no dialog but the top card now shows Pending: recorded as sent, note-less, never retried', async () => {
    const { w, connect, touchId } = await armedTop();
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ actions: '<button>Pending</button><button>Message</button><button>More</button>' })); };
    const r = await w.engine.click(connect);
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent_without_note', touch_id: touchId });
    expect(touch(w, touchId)).toMatchObject({ status: 'sent', body: null });
    expect(touch(w, touchId).sent_at).not.toBeNull();
    expect(w.intents.peek('linkedin')).toBeNull();
    expect(w.db.prepare("SELECT COUNT(*) AS c FROM rate_events WHERE key = 'linkedin_invite'").get()).toMatchObject({ c: 1 });
    expect(w.db.prepare("SELECT status, note FROM connections").get()).toMatchObject({ status: 'sent', note: '' });
    // A second attempt on the same person is refused at arm.
    w.page.setHtml(page());
    await w.snap();
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('refused');
  });

  it('no dialog but an "Invitation sent" toast: recorded as sent', async () => {
    const { w, connect, touchId } = await armedTop();
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ after: '<div role="status"><p>Invitation sent</p></div>' })); };
    expect(await w.engine.click(connect)).toMatchObject({ ok: true, status: 'sent', code: 'sent_without_note' });
    expect(touch(w, touchId).status).toBe('sent');
  });

  it('no dialog and no Pending or toast keeps the no_dialog handling', async () => {
    const { w, connect, touchId } = await armedTop();
    const r = await w.engine.click(connect);
    expect(r).toMatchObject({ status: 'failed', code: 'no_dialog_after_connect' });
    expect(touch(w, touchId)).toMatchObject({ status: 'no_dialog', body: NOTE });
  });

  it('a Pending in a sidebar card after the click is not proof of a send', async () => {
    const { w, connect, touchId } = await armedTop();
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ after: '<ul><li><a href="/in/other-person/">Other</a><button>Pending</button></li></ul>' })); };
    expect((await w.engine.click(connect)).code).toBe('no_dialog_after_connect');
    expect(touch(w, touchId).status).toBe('no_dialog');
  });
});
