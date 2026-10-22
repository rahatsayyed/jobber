import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTreeFromHtml, renderTree, formatTree, MAX_RENDER_CHARS } from '../src/browserctl/snapshot.js';
import { classify, guardInputOf } from '../src/browserctl/guard.js';

// Real Naukri search-results card markup (structure only, text replaced), live capture 2026-10-22.
// The page puts a large filter sidebar before the cards, so the old 400-node cap and the 6000-char
// render cap both cut the tree before the first card.
const CARD = readFileSync(new URL('./fixtures/naukri/srp-card.html', import.meta.url), 'utf8');
const TITLE_RE = /(class="title "[^>]*>)X(<\/a>)/;

const filters = Array.from({ length: 40 }, (_, g) =>
  `<div class="styles_filter"><div><span>Filter group ${g}</span></div>` +
  `<label><input type="checkbox"><span>Option ${g}</span></label>` +
  Array.from({ length: 6 }, (_, o) => `<div><span>Facet ${g}.${o}</span><span>(${o})</span></div>`).join('') +
  '</div>').join('');
const cards = (n: number) => Array.from({ length: n }, (_, i) =>
  CARD.replace(TITLE_RE, `$1Role Title ${i}$2`).replace(/job-listings-[a-z0-9-]+/, `job-listings-role-${i}-000`)).join('');
const PAGE = `<html><head><title>Search</title></head><body><aside>${filters}</aside><main>${cards(20)}</main>` +
  '<footer><a href="/about">About us</a><a href="/help">Help</a></footer></body></html>';

describe('search result cards survive page chrome', () => {
  const tree = buildTreeFromHtml(PAGE, 'https://www.naukri.com/react-developer-jobs-in-pune');
  const links = tree.nodes.filter((n) => n.role === 'link' && /job-listings/.test(n.href ?? ''));

  it('keeps every card title link in the tree', () => {
    expect(links.length).toBe(20);
    expect(links[0]!.name).toBe('Role Title 0');
    expect(links[19]!.name).toBe('Role Title 19');
  });

  it('renders every card title link within the default render budget', () => {
    const txt = renderTree(tree, 1);
    expect(txt.length).toBeLessThanOrEqual(MAX_RENDER_CHARS + 20);
    for (let i = 0; i < 20; i++) expect(txt).toContain(`link "Role Title ${i}"`);
    expect(formatTree(tree, 1)).toContain('Role Title 19');
  });

  it('keeps the footer links too and stays bounded', () => {
    expect(renderTree(tree, 1)).toContain('link "About us"');
    expect(tree.nodes.length).toBeLessThanOrEqual(1500);
  });

  it('does not turn a title link into a commit class', () => {
    const l = links[0]!;
    expect(classify(guardInputOf(l, 'naukri'))).toBe('free');
  });
});
