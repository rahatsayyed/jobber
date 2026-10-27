// The LinkedIn invite modal as measured live (invented person "Jane Example"): a light-DOM host at the END of the body
// holds nested OPEN shadow roots; inside, div[data-test-modal-container][aria-hidden] > div[role=dialog] with an h2 and
// buttons whose label sits in aria-label AND in a child span. The page has more nodes than the node cap before it.
import { describe, expect, it } from 'vitest';
import { MAX_NODES, buildTreeFromHtml, type RawTree } from '../src/browserctl/snapshot.js';
import { el, runBc, shadow, type FEl } from './helpers/miniDom.js';

const btn = (label: string, withAria = true): FEl =>
  el('div', { id: 'w' }, el('button', { ...(withAria ? { 'aria-label': label } : {}), id: 'b' }, el('span', {}, label)));

function modal(ariaHidden: string | null): FEl {
  const dialog = el('div', { role: 'dialog', 'data-test-modal': '', 'aria-labelledby': 'h', tabindex: '-1' },
    el('div', { id: 'c' }, el('h2', { id: 'h' }, 'Add a note to your invitation?'),
      el('p', {}, 'Personalize your invitation to Jane Example by adding a note')),
    btn('Add a note'), btn('Send without a note'), el('div', {}, el('textarea', { 'aria-label': 'Add a note' })));
  const container = el('div', { 'data-test-modal-container': '', 'data-test-modal-id': 'x', ...(ariaHidden === null ? {} : { 'aria-hidden': ariaHidden }), id: 'k' }, dialog);
  const inside = el('div', { id: 'i', tabindex: '-1' }, container);
  const inner = shadow(el('div', { id: 'h2' }), [inside]);
  return shadow(el('div', { id: 'host', 'data-testid': 'x' }, el('div', { 'data-strictmode': '' })), [inner]);
}
const page = (m: FEl, bulk = MAX_NODES + 300): FEl =>
  el('body', {}, el('main', {}, el('section', {}, el('h2', {}, 'Jane Example'), el('button', {}, 'Connect'),
    ...Array.from({ length: bulk }, (_v, i) => el('a', { href: `/in/p${i}/` }, `Person ${i}`)))), m);
const walk = (b: FEl): RawTree => runBc<RawTree>(b, 'snapshot')!;

describe('invite modal in nested open shadow roots past the node cap', () => {
  for (const ah of [null, 'false']) {
    it(`reads the dialog controls (aria-hidden on the container: ${ah ?? 'absent'})`, () => {
      const t = walk(page(modal(ah)));
      expect(t.truncated).toBe(true);
      const d = t.nodes.find((x) => x.role === 'dialog')!;
      expect(d).toBeTruthy();
      const inDlg = t.nodes.filter((x) => x.dialog === d.n);
      expect(inDlg.filter((x) => x.role === 'button').map((x) => x.name)).toEqual(['Add a note', 'Send without a note']);
      expect(inDlg.some((x) => x.role === 'textbox')).toBe(true);
      expect(inDlg.some((x) => x.role === 'text' && /Jane Example/.test(x.text))).toBe(true);
    });
  }

  it('a container with aria-hidden="true" is still hidden', () => {
    const t = walk(page(modal('true')));
    expect(t.nodes.some((x) => x.role === 'dialog')).toBe(false);
  });

  it('a button labelled only by its span child (no aria-label) is named from the span', () => {
    const dialog = el('div', { role: 'dialog', 'aria-label': 'Invite' }, btn('Send', false));
    const t = walk(page(shadow(el('div', {}), [dialog])));
    expect(t.nodes.find((x) => x.role === 'button' && x.dialog !== undefined)?.name).toBe('Send');
  });

  it('the fixture builder keeps dialog controls past the cap too', () => {
    const feed = Array.from({ length: MAX_NODES + 50 }, (_v, i) => `<a href="/in/p${i}/">P${i}</a>`).join('');
    const t = buildTreeFromHtml(`<body><main><h1>Jane Example</h1>${feed}</main><div role="dialog"><h2>Invite</h2><button aria-label="Send"><span>Send</span></button></div></body>`, 'https://www.linkedin.com/in/jane-example/');
    expect(t.truncated).toBe(true);
    expect(t.nodes.some((x) => x.role === 'button' && x.name === 'Send' && x.dialog !== undefined)).toBe(true);
  });
});
