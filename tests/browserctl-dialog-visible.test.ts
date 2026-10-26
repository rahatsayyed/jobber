// Bug 2 of wake a3cb0b53: on a long profile the page text hit the render budget and the dialog and menu nodes,
// which sit at the END of the tree, were cut off, so the operator never saw "Add a note". Dialog and menu controls
// must survive the budget, a walker dialog shell without controls must not hide the locator view, and an open dialog
// without controls must leave a structural diag. Fakes only (invented profile "Jane Example").
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCATOR_BASE, withLocatorDialogs } from '../src/browserctl/locatorDialogs.js';
import { renderTree, type RawNode, type RawTree } from '../src/browserctl/snapshot.js';
import { LIVE_ENV, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';
import { shadowWorld } from './helpers/fakeShadowDialog.js';

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });

const node = (n: number, role: RawNode['role'], name: string, extra: Partial<RawNode> = {}): RawNode => ({ n, role, name, text: '', disabled: false, ...extra });

function longPageTree(): RawTree {
  const nodes: RawNode[] = [];
  for (let i = 0; i < 400; i++) nodes.push(node(i, 'link', `View post number ${i} by somebody with a fairly long display name`));
  nodes.push(node(LOCATOR_BASE, 'dialog', 'Add a note'));
  nodes.push(node(LOCATOR_BASE + 1, 'text', '', { text: 'Personalize your invitation', dialog: LOCATOR_BASE }));
  for (const [i, name] of ['Dismiss', 'Add a note', 'Send without a note'].entries()) {
    nodes.push(node(LOCATOR_BASE + 2 + i, 'button', name, { dialog: LOCATOR_BASE, inFooter: true }));
  }
  nodes.push(node(LOCATOR_BASE + 2000, 'menuitem', 'Connect'));
  return { url: 'https://www.linkedin.com/in/jane-example/', title: 'Jane Example | LinkedIn', nodes };
}

describe('render budget keeps dialog and menu controls', () => {
  it('a long page is trimmed from the page controls, not from the dialog at the tail', () => {
    const text = renderTree(longPageTree(), 5);
    for (const want of ['dialog "Add a note" (open)', 'button "Dismiss"', 'button "Add a note"', 'button "Send without a note"', 'menuitem "Connect"']) {
      expect(text).toContain(want);
    }
    expect(text).toContain('link "View post number 0 ');
    expect(text.length).toBeLessThanOrEqual(6000 + 60);
    expect(text).toMatch(/\(\d+ lines omitted\)/);
  });

  it('a page that fits is rendered whole', () => {
    const t: RawTree = { url: 'https://www.linkedin.com/in/a/', title: 'A', nodes: [node(0, 'button', 'Connect'), node(1, 'button', 'More')] };
    expect(renderTree(t, 1)).not.toContain('omitted');
  });
});

describe('engine snapshot with a long profile', () => {
  const posts = Array.from({ length: 400 }, (_, i) => `<a href="/feed/update/${i}">View post number ${i} by somebody with a fairly long display name</a>`).join('\n');

  it('lists the locator dialog controls as refs even when the page text is over budget', async () => {
    const sh = shadowWorld();
    const w = world({ html: profileHtml({ extra: posts }), env: LIVE_ENV, wrapPage: (p) => withLocatorDialogs(p, () => sh.page) });
    worlds.push(w);
    sh.open();
    const state = await w.snap();
    for (const name of ['Dismiss', 'Add a note', 'Send without a note']) expect(refOf(state, 'button', name)).toMatch(/^s\d+\.\d+$/);
  });

  it('a walker dialog shell without controls does not hide the locator dialog', async () => {
    const sh = shadowWorld();
    const shell = '<div role="dialog" aria-label="Add a note"></div>';
    const w = world({ html: profileHtml({ dialog: shell }), env: LIVE_ENV, wrapPage: (p) => withLocatorDialogs(p, () => sh.page) });
    worlds.push(w);
    sh.open();
    const state = await w.snap();
    expect(refOf(state, 'button', 'Add a note')).toBeTruthy();
    expect(w.engine.lastTree()!.nodes.some((x) => x.n >= LOCATOR_BASE && x.role === 'button')).toBe(true);
  });

  it('an open dialog without any control writes a structural diag (no page text in it)', async () => {
    const shell = '<div role="dialog" aria-label="Add a note"></div>';
    const w = world({ html: profileHtml({ dialog: shell }), env: LIVE_ENV });
    worlds.push(w);
    await w.snap();
    const dir = path.join(path.dirname(w.stopFile), 'diag');
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const d = JSON.parse(readFileSync(path.join(dir, files[0]!), 'utf8'));
    expect(d).toMatchObject({ platform: 'linkedin', code: 'dialog_controls_missing' });
    expect(d.tree_dialogs).toEqual([{ name: 'Add a note', buttons: [] }]);
    expect(JSON.stringify(d)).not.toContain('Jane Example');
  });

  it('a dialog with controls writes no diag, and repeated snapshots of an empty dialog stay bounded', async () => {
    const ok = world({ html: profileHtml({ dialog: '<dialog open aria-label="Add a note"><button>Add a note</button></dialog>' }), env: LIVE_ENV });
    worlds.push(ok);
    await ok.snap();
    expect(existsSync(path.join(path.dirname(ok.stopFile), 'diag'))).toBe(false);

    const empty = world({ html: profileHtml({ dialog: '<div role="dialog" aria-label="Add a note"></div>' }), env: LIVE_ENV });
    worlds.push(empty);
    for (let i = 0; i < 8; i++) await empty.snap();
    expect(readdirSync(path.join(path.dirname(empty.stopFile), 'diag')).length).toBeLessThanOrEqual(3);
  });
});
