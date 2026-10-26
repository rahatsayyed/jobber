// LinkedIn More menu replayed from a live read-only probe (invented person "Jane Example"): the popover sits at the END
// of the body in a portal (body > div[data-floating-ui-portal] > div[popover] > div[role=menu] > rows), is a top-layer
// element (offsetParent null) and its rows are `div[role=menuitem] > div > div > p` or `a[role=menuitem][href]` with the
// label ONLY in a nested <p> (no aria-label). The page is far bigger than the node cap, so the portal is past it.
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildTreeFromHtml, MAX_NODES, type RawNode, type RawTree } from '../src/browserctl/snapshot.js';
import { connectionStateOf } from '../src/browserctl/topCard.js';
import { el, runBc, type FEl } from './helpers/miniDom.js';
import { LIVE_ENV, NOTE, URL_, inviteDialog, refOf, world, type World } from './helpers/bcWorld.js';

const worlds: World[] = [];
const mk = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const clicks = (w: World) => w.page.log.filter((l) => l.startsWith('click'));

const NAME = 'Jane Example';
const ROWS = ['Send profile in a message', 'Save to PDF', 'Follow', `Report ${NAME}`, `Block ${NAME}`, 'About this member'];

const divRow = (label: string): FEl => el('div', { role: 'menuitem', tabindex: '0' }, el('div', {}, el('div', {}, el('p', {}, label))));
const aRow = (label: string): FEl => el('a', { role: 'menuitem', href: '/messaging/compose/?x=1', componentkey: 'k' },
  el('div', { 'data-display-contents': 'true' }, el('div', {}, el('div', {}, el('p', {}, label)))));
const portal = (rows: FEl[]): FEl => el('div', { id: 'p1', 'data-floating-ui-portal': '' },
  el('div', { popover: 'manual', tabindex: '-1', 'data-floating-ui-focusable': '' }, el('div', { role: 'menu' }, ...rows)));

/** A profile body: header nav, the name heading, the top-card row, a long page, then optionally the portal at the end. */
function profileBody(portalEl: FEl | null, bulk = MAX_NODES + 200, nav = ['Home', 'My Network']): FEl {
  const feed = Array.from({ length: bulk }, (_v, i) => el('a', { href: `/in/p${i}/` }, `Person ${i}`));
  return el('body', {},
    el('header', {}, ...nav.map((t) => el('a', { href: `/${t}/` }, t))),
    el('main', {},
      el('section', {}, el('h2', {}, NAME),
        el('a', { href: '/messaging/compose/' }, 'Message'), el('button', {}, 'More')),
      el('section', {}, el('h2', {}, 'Activity'), ...feed)),
    ...(portalEl ? [portalEl] : []));
}
const walk = (b: FEl) => runBc<RawTree>(b, 'snapshot')!;
const rowsOf = (t: RawTree): RawNode[] => t.nodes.filter((x) => x.role === 'menuitem');

describe('in-page walker: the popover menu', () => {
  it('reads every row of a top-layer popover past the node cap, named from the nested <p>, region menu', () => {
    const t = walk(profileBody(portal([aRow(ROWS[0]!), divRow(ROWS[1]!), divRow(ROWS[2]!), divRow(ROWS[3]!), divRow(ROWS[4]!), divRow(ROWS[5]!)])));
    expect(t.truncated).toBe(true);
    const rows = rowsOf(t);
    expect(rows.map((x) => x.name)).toEqual(ROWS);
    expect(rows.every((x) => x.region === 'menu')).toBe(true);
  });

  it('a Personalize invite row (div and a shapes) is read', () => {
    for (const row of [divRow('Personalize invite'), aRow('Personalize invite')]) {
      const rows = rowsOf(walk(profileBody(portal([row, divRow('Save to PDF')]))));
      expect(rows.map((x) => x.name)).toEqual(['Personalize invite', 'Save to PDF']);
    }
  });

  it('no popover on the page: no menu rows, and the header links are never menu', () => {
    const t = walk(profileBody(null, 10));
    expect(rowsOf(t)).toHaveLength(0);
    expect(t.nodes.some((x) => x.region === 'menu')).toBe(false);
  });

  it('header nav links that changed between two snapshots are not tagged menu', () => {
    const a = walk(profileBody(null, 10, ['Home', 'My Network']));
    const b = walk(profileBody(null, 10, ['linkedin', 'notifications']));
    for (const t of [a, b]) {
      const nav = t.nodes.filter((x) => x.role === 'link' && /^(Home|My Network|linkedin|notifications)$/.test(x.name));
      expect(nav).toHaveLength(2);
      expect(nav.some((x) => x.region === 'menu')).toBe(false);
    }
  });

  it('a menuitem inside an open popover without role=menu is a menu row too', () => {
    const p = el('div', { popover: '' }, el('div', { role: 'menuitem' }, el('p', {}, 'Personalize invite')));
    expect(rowsOf(walk(profileBody(p, 5))).map((x) => `${x.name}:${x.region}`)).toEqual(['Personalize invite:menu']);
  });

  it('a closed menu (display:none) is not read', () => {
    const p = el('div', { popover: '', style: 'display:none' }, el('div', { role: 'menu' }, divRow('Connect')));
    expect(rowsOf(walk(profileBody(p, 5)))).toHaveLength(0);
  });

  it('describe re-reads a popover row by its ordinal (the click path)', () => {
    const body = profileBody(portal([aRow('Personalize invite')]), 5);
    const row = rowsOf(walk(body))[0]!;
    expect(runBc<RawNode>(body, 'describe', { n: row.n })).toMatchObject({ role: 'menuitem', name: 'Personalize invite', region: 'menu' });
  });
});

// ---- engine level (fixture builder; the page re-renders after the More click) ----
const NAV = (a: string, b: string) => `<header><a href="/feed/">${a}</a><a href="/mynetwork/">${b}</a></header>`;
const MORE_ACTIONS = '<a href="/messaging/compose/">Message</a><button>More</button>';
const dRow = (l: string) => `<div role="menuitem" tabindex="0"><div><div><p>${l}</p></div></div></div>`;
const aRowH = (l: string) => `<a role="menuitem" href="/messaging/compose/?x=1" componentkey="k"><div data-display-contents="true"><div><div><p>${l}</p></div></div></div></a>`;
const popoverHtml = (rows: string[]) => `<div id="p1" data-floating-ui-portal><div popover tabindex="-1"><div role="menu">${rows.join('')}</div></div></div>`;
const page = (o: { nav?: string; popover?: string; dialog?: string } = {}): string => `<html><head><title>${NAME} | LinkedIn</title></head><body>${o.nav ?? NAV('Home', 'Network')}<main>
<section><h2>${NAME}</h2><p>· 3rd</p>${MORE_ACTIONS}</section><section><h2>About</h2><p>Builds things.</p></section>${o.dialog ?? ''}</main>${o.popover ?? ''}</body></html>`;

async function openMore(popover: string | null) {
  const w = mk({ html: page(), env: LIVE_ENV });
  const more = refOf(await w.snap(), 'button', 'More');
  w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ nav: NAV('linkedin', 'notifications'), popover: popover ?? '' })); };
  const opened = await w.engine.click(more);
  return { w, opened };
}

describe('engine: More click then the popover menu', () => {
  it('rows without Connect: not_connectable, only real rows are menu, nav links changed by the re-render are not', async () => {
    const { w, opened } = await openMore(popoverHtml([aRowH(ROWS[0]!), dRow(ROWS[1]!), dRow('Follow'), dRow(`Report ${NAME}`), dRow(`Block ${NAME}`), dRow('About this member')]));
    expect(opened.state).toMatch(/connect_state: not_connectable/);
    const menu = w.engine.lastTree()!.nodes.filter((x) => x.region === 'menu').map((x) => x.name);
    expect(menu).toEqual(ROWS);
    expect(await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).toMatchObject({ code: 'not_connectable' });
  });

  for (const [shape, row] of [['div', dRow], ['a', aRowH]] as const) {
    it(`Personalize invite (${shape} row): via_more, armed, clicked; every other row is refused`, async () => {
      const { w, opened } = await openMore(popoverHtml(['Personalize invite', ...ROWS].map(row)));
      expect(opened.state).toMatch(/connect_state: via_more/);
      expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
      for (const name of ROWS) {
        const r = await w.engine.click(refOf(opened.state!, 'menuitem', name));
        expect(r.ok).toBe(false);
        expect(['menu_row_not_allowed', 'irreversible_refused']).toContain(r.code);
      }
      expect(clicks(w)).toHaveLength(1); // only the More click
      w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page({ dialog: inviteDialog() })); };
      expect(await w.engine.click(refOf(opened.state!, 'menuitem', 'Personalize invite'))).toMatchObject({ ok: true, code: 'dialog_opened' });
    });
  }

  it('a Connect row reads as via_more; a named "Invite X to connect" row does not', async () => {
    const a = await openMore(popoverHtml([dRow('Connect'), dRow('Save to PDF')]));
    expect(a.opened.state).toMatch(/connect_state: via_more/);
    const b = await openMore(popoverHtml([dRow('Invite Other Person to connect'), dRow('Save to PDF')]));
    expect(b.opened.state).toMatch(/connect_state: not_connectable/);
  });

  it('More clicked and the popover never shows: check_more with a more_menu_missing diag, never not_connectable', async () => {
    const { w, opened } = await openMore(null);
    expect(opened.state).toMatch(/connect_state: check_more/);
    expect(opened.state).not.toMatch(/not_connectable/);
    expect(w.engine.lastTree()!.nodes.some((x) => x.region === 'menu')).toBe(false);
    const dir = path.join(path.dirname(w.stopFile), 'diag');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(dir, files[0]!), 'utf8')).code).toBe('more_menu_missing');
    expect(await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).toMatchObject({ code: 'more_not_checked' });
  });

  it('a popover Connect row that was not opened from the top-card More is refused', async () => {
    const w = mk({ html: page({ popover: popoverHtml([dRow('Connect')]) }), env: LIVE_ENV });
    const state = await w.snap();
    await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE });
    expect((await w.engine.click(refOf(state, 'menuitem', 'Connect'))).code).toBe('connect_not_top_card');
    expect(clicks(w)).toEqual([]);
  });
});

describe('connection state from the menu rows', () => {
  const st = (html: string) => connectionStateOf(buildTreeFromHtml(html, URL_))?.state;
  it('menu read with no Connect: not_connectable; More with no menu rows: check_more; no More: not_connectable', () => {
    expect(st(page({ popover: popoverHtml([dRow('Save to PDF')]) }))).toBe('not_connectable');
    expect(st(page())).toBe('check_more');
    expect(st(page().replace(MORE_ACTIONS, '<a href="/messaging/compose/">Message</a>'))).toBe('not_connectable');
  });
});
