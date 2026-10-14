import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSnapshotFromHtml, SNAPSHOT_SRC } from '../src/linkedin/snapshot.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const U = 'https://www.linkedin.com/in/jane-example/';

describe('buildSnapshotFromHtml', () => {
  it('reads a not-connected profile', () => {
    const s = buildSnapshotFromHtml(fx('profile-not-connected.html'), U);
    expect(s.profile).toMatchObject({ name: 'Jane Example', degree: '2nd', hasBell: false, pending: false, hasMessageButton: true });
    expect(s.profile?.actions).toEqual(expect.arrayContaining(['Connect', 'Message', 'More']));
    expect(s.profile?.actions).toHaveLength(3);
    expect(s.profile?.headline).toBe('Senior Recruiter at Acme Robotics');
    expect(s.profile?.location).toBe('Pune, Maharashtra, India');
    expect(s.profile?.about).toContain('robotics software teams');
  });
  it('reads a connected profile via the notifications bell', () => {
    expect(buildSnapshotFromHtml(fx('profile-connected.html'), U).profile?.hasBell).toBe(true);
  });
  it('keeps hidden payloads out of every field including bodyText', () => {
    const s = buildSnapshotFromHtml(fx('profile-injection.html'), U);
    const all = JSON.stringify(s).toLowerCase();
    for (const leaked of ['ignore all previous', 'admin mode', 'attacker.test', 'offscreen:', 'secrets/', 'aria hidden', 'nested under opacity', 'hidden attr']) expect(all).not.toContain(leaked);
    expect(s.profile?.about).toContain('Visible sentence that must survive');
    expect(s.bodyText).toContain('Visible sentence that must survive');
  });
  it('lists only visible search cards and caps them', () => {
    const s = buildSnapshotFromHtml(fx('search-results.html'), 'https://www.linkedin.com/search/results/people/');
    // fixture has 3 visible cards and 1 display:none card (the plan text said 2; the fixture is authoritative)
    expect(s.results.map((r) => r.name)).toEqual(['Alex Sample', 'Priya Demo', 'Sam Placeholder']);
    expect(s.results.every((r) => r.href.startsWith('/in/'))).toBe(true);
    expect(JSON.stringify(s)).not.toContain('Hidden Person');
    const many = '<main><ul>' + Array.from({ length: 30 }, (_, i) => `<li role="listitem"><a href="/in/p${i}/">P ${i}</a></li>`).join('') + '</ul></main>';
    expect(buildSnapshotFromHtml(many, 'https://www.linkedin.com/search/results/people/').results).toHaveLength(12);
  });
  it('reads invitations and the message overlay', () => {
    expect(buildSnapshotFromHtml(fx('invitations.html'), 'https://www.linkedin.com/mynetwork/invitation-manager/').invitations.length).toBe(2);
    const m = buildSnapshotFromHtml(fx('message-overlay.html'), U);
    expect(m.messageHeaderName).toBe('Jane Example');
    expect(m.messages.map((x) => x.from)).toEqual(['them', 'me']);
  });
  it('hides font-size, opacity, transparent-color and indent payloads', () => {
    const html = `<main><section><h1>Jo</h1>
      <div style="opacity:0"><b>faint-leak</b></div>
      <div style="font-size:3px">tiny-leak</div>
      <div style="color:transparent">clear-leak</div>
      <div style="text-indent:-9999px">indent-leak</div>
      <p>shown-text</p></section></main>`;
    const s = buildSnapshotFromHtml(html, U);
    const all = JSON.stringify(s);
    for (const l of ['faint-leak', 'tiny-leak', 'clear-leak', 'indent-leak']) expect(all).not.toContain(l);
    expect(s.bodyText).toContain('shown-text');
  });
  it('documents the fixture-side limit: CSS-class hiding is invisible to the builder', () => {
    // Class/stylesheet hiding needs a layout engine; the fixture builder only sees inline
    // style and attributes. The in-page script (getComputedStyle) covers it and the owner-run
    // parity test checks that in real Chrome. This pins the known gap so nobody assumes the
    // fixture builder proves class-hidden text is removed.
    const html = '<html><head><style>.x{display:none}</style></head><body><main><section><h1>Jo</h1><p class="x">class-hidden</p></section></main></body></html>';
    expect(buildSnapshotFromHtml(html, U).bodyText).toContain('class-hidden');
  });
  it('fails closed on junk input', () => {
    const s = buildSnapshotFromHtml('<<<>>>', 'not a url');
    expect(s.profile).toBeNull();
    expect(s.results).toEqual([]);
  });
});

describe('SNAPSHOT_SRC', () => {
  it('is a self-contained expression that only reads', () => {
    expect(SNAPSHOT_SRC).toContain('getComputedStyle');
    expect(SNAPSHOT_SRC).toContain('getBoundingClientRect');
    expect(SNAPSHOT_SRC).toContain('aria-hidden');
    expect(SNAPSHOT_SRC).not.toMatch(/\.click\(|\.submit\(|fetch\(|XMLHttpRequest|location\s*=|innerHTML\s*=|textContent\s*=/);
  });
  it('mirrors the fixture-side visibility rules', () => {
    for (const k of ['opacity', 'fontSize', 'visibility', 'display', 'hidden', 'textIndent', 'backgroundColor', 'scrollX']) expect(SNAPSHOT_SRC).toContain(k);
    expect(SNAPSHOT_SRC).toContain('-200');
  });
  it('parses as a JS expression', () => {
    expect(() => new Function('return (' + SNAPSHOT_SRC + ')')).not.toThrow();
  });
  it('returns a fail-closed empty snapshot when the document is unusable', () => {
    const run = new Function('document', 'window', 'location', 'getComputedStyle', 'return (' + SNAPSHOT_SRC + ')');
    const fakeDoc = { title: 'T', body: null, querySelector: () => null, querySelectorAll: () => [] };
    const out = run(fakeDoc, { scrollX: 0, scrollY: 0 }, { href: 'https://www.linkedin.com/feed/', pathname: '/feed/' }, () => null);
    expect(out.profile).toBeNull();
    expect(out.bodyText).toBe('');
    expect(out.results).toEqual([]);
  });
});

// Fake-document harness: runs SNAPSHOT_SRC against fake elements with explicit computed style and rect.
type Sty = Record<string, string>;
const BASE: Sty = { display: 'block', visibility: 'visible', opacity: '1', fontSize: '16px', textIndent: '0px',
  color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', overflow: 'visible', overflowX: 'visible', overflowY: 'visible',
  clipPath: 'none', clip: 'auto', webkitTextFillColor: 'rgb(0, 0, 0)' };
function liveBodyText(style: Sty, text: string, rect = { width: 200, height: 20, right: 300, bottom: 40 }): string {
  const mk = (tag: string, parent: any, st: Sty, r: any): any => ({
    tagName: tag, nodeType: 1, parentElement: parent, childNodes: [] as any[],
    hasAttribute: () => false, getAttribute: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => r, _st: st,
  });
  const body = mk('BODY', null, { ...BASE, backgroundColor: 'rgb(255, 255, 255)' }, { width: 1000, height: 800, right: 1000, bottom: 800 });
  const div = mk('DIV', body, { ...BASE, ...style }, rect);
  div.childNodes.push({ nodeType: 3, nodeValue: text });
  body.childNodes.push(div);
  const fakeDoc = { title: '', body, querySelector: () => null, querySelectorAll: () => [] };
  const run = new Function('document', 'window', 'location', 'getComputedStyle', 'return (' + SNAPSHOT_SRC + ')');
  const out = run(fakeDoc, { scrollX: 0, scrollY: 0 }, { href: 'https://www.linkedin.com/feed/', pathname: '/feed/' }, (e: any) => e._st);
  return out.bodyText as string;
}
describe('SNAPSHOT_SRC leak paths (fake computed style)', () => {
  it('shows ordinary text', () => { expect(liveBodyText({}, 'plain-ok')).toContain('plain-ok'); });
  it('hides 1px overflow-hidden sr-only text', () => {
    expect(liveBodyText({ overflow: 'hidden' }, 'srleak', { width: 1, height: 1, right: 5, bottom: 5 })).not.toContain('srleak');
    expect(liveBodyText({ overflowX: 'clip' }, 'srleak2', { width: 200, height: 2, right: 205, bottom: 5 })).not.toContain('srleak2');
  });
  it('hides text under any non-none clip-path', () => {
    for (const cp of ['inset(50%)', 'circle(0)', 'polygon(0 0)']) expect(liveBodyText({ clipPath: cp }, 'cpleak')).not.toContain('cpleak');
  });
  it('hides a clip rect with 1px sides', () => {
    expect(liveBodyText({ clip: 'rect(1px, 1px, 1px, 1px)' }, 'cliprect')).not.toContain('cliprect');
  });
  it('hides text with transparent, background-matching or unparseable -webkit-text-fill-color', () => {
    expect(liveBodyText({ webkitTextFillColor: 'rgba(0, 0, 0, 0)' }, 'fillleak')).not.toContain('fillleak');
    expect(liveBodyText({ webkitTextFillColor: 'rgb(255, 255, 255)' }, 'fillleak2')).not.toContain('fillleak2');
    expect(liveBodyText({ webkitTextFillColor: 'color(display-p3 1 0 0)' }, 'fillleak3')).not.toContain('fillleak3');
  });
  it('hides text-indent of -200px or more negative', () => {
    expect(liveBodyText({ textIndent: '-200px' }, 'indleak')).not.toContain('indleak');
    expect(liveBodyText({ textIndent: '-10px' }, 'indok')).toContain('indok');
  });
  it('hides opacity 0.04, font-size 5.5px and near-background colour', () => {
    expect(liveBodyText({ opacity: '0.04' }, 'opleak')).not.toContain('opleak');
    expect(liveBodyText({ fontSize: '5.5px' }, 'fsleak')).not.toContain('fsleak');
    expect(liveBodyText({ color: 'rgb(250, 250, 250)', webkitTextFillColor: 'rgb(250, 250, 250)' }, 'nearleak')).not.toContain('nearleak');
  });
});
describe('profile-hidden-tricks fixture', () => {
  it('parses, and the visible sentence survives (the tricks are asserted in the owner-run parity test)', () => {
    // The fixture builder only knows inline hiding rules (htmlVisible.ts); several tricks here need
    // computed style, so the real assertion that none leak is the opt-in Chrome parity test below.
    const s = buildSnapshotFromHtml(fx('profile-hidden-tricks.html'), U);
    expect(s.bodyText).toContain('Visible tricks-page sentence');
  });
});

import { describe as d, it as i } from 'vitest';
const RUN = process.env.LINKEDIN_BROWSER_TESTS === 'true';
(RUN ? d : d.skip)('SNAPSHOT_SRC parity in real Chrome (owner-run)', () => {
  i('hides every payload the fixture builder hides', async () => {
    // Real installed Google Chrome via the runtime helper (never bundled Chromium).
    // A missing Chrome throws chrome_unavailable here: a loud failure, never a skip.
    const { launchRealChrome, LINKEDIN_CONTEXT_OPTIONS } = await import('../src/linkedin/browser.js');
    const browser = await launchRealChrome();
    try {
      const page = (await (await browser.newContext({ ...LINKEDIN_CONTEXT_OPTIONS })).newPage()) as any; // setContent is not in LiPage
      for (const name of ['profile-injection.html', 'profile-not-connected.html', 'search-results.html', 'profile-hidden-tricks.html']) {
        await page.setContent(fx(name));
        const live = (await page.evaluate(SNAPSHOT_SRC)) as any;
        const built = buildSnapshotFromHtml(fx(name), U);
        expect(live.profile?.name ?? null).toBe(built.profile?.name ?? null);
        expect(live.results.length).toBe(built.results.length);
        expect(live.bodyText).not.toMatch(/ignore all previous|admin mode|attacker\.test|secrets\//i);
        expect(live.bodyText).not.toMatch(/TRICK-[A-Z0-9-]+-LEAK/);
      }
    } finally { await browser.close(); }
  });
});
