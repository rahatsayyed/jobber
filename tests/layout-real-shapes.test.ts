import { describe, expect, it } from 'vitest';
import { treeToRawSnapshot } from '../src/browserctl/layoutAdapter.js';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { applyObservation, classify } from '../src/layout/classify.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { observeLinkedin } from '../src/layout/fingerprint.js';
import { emptyLayout } from '../src/layout/store.js';
import type { LayoutFile } from '../src/layout/types.js';

// Trimmed synthetic snapshots that mimic the shapes seen on real LinkedIn pages (no real names).
const NAV = '<a href="/feed/">Home</a><a href="/mynetwork/">Network</a><a href="/jobs/">Jobs</a><a href="/messaging/">Messaging</a><button>Me</button>';
const page = (url: string, body: string) => treeToRawSnapshot(buildTreeFromHtml(`<html><head><title>x | LinkedIn</title></head><body>${NAV}<main>${body}</main></body></html>`, url));

const profile = (rel: '3rd' | '1st' | '2nd') => page('https://www.linkedin.com/in/pat-sample/', `
<a href="/in/pat-sample/overlay/notifications/">Manage notifications about Pat Sample</a>
<a href="/in/pat-sample/">Pat Sample</a>
<h1>Pat Sample</h1><span>· ${rel}</span><div>Engineering Manager at Example Corp</div><div>Springfield, Somewhere</div>
<a href="/in/pat-sample/overlay/contact-info/">Contact info</a>
<button>Follow Pat Sample</button>
${rel === '1st' ? '<a href="/messaging/compose/?x=1">Message</a>' : '<a href="/preload/custom-invite/?vanityName=pat-sample">Invite Pat Sample to connect</a>'}
<button>More</button>
<h2>About</h2><div>Builds teams and products for a living.</div>
<h2>Activity</h2><div>1,000 followers</div>`);

const search = () => page('https://www.linkedin.com/search/results/people/?keywords=recruiter', `
<input type="radio" aria-label="Filter by People"><input type="radio" aria-label="Filter by 1st connections">
<ul><li><a href="/in/a-one/">Alex One</a><a href="/preload/custom-invite/?vanityName=a-one">Invite Alex One to connect</a></li>
<li><a href="/in/b-two/">Bea Two</a><button>Follow Bea Two</button></li></ul>`);

const feed = () => page('https://www.linkedin.com/feed/', `
<button>Start a post</button><button>Sort by: Top</button>
<button aria-label="Open control menu for post by Sam Poster">...</button><button aria-label="Hide post by Sam Poster">x</button>`);

const messaging = () => page('https://www.linkedin.com/messaging/thread/2-abc/', `
<h2>Messaging</h2><input type="search" aria-label="Search messages">
<ul><li><h3>Conversation One</h3><p>hello</p></li><li><h3>Conversation Two</h3><p>hi</p></li></ul>`);

const cfg = loadLayoutConfig({}, '/proj');
const T0 = new Date('2026-10-15T00:00:00.000Z');

function learnFrom(raws: ReturnType<typeof profile>[]): LayoutFile {
  let f = emptyLayout('linkedin', T0);
  let i = 0;
  for (const raw of raws) {
    f = applyObservation(f, observeLinkedin(raw, null), { now: new Date(T0.getTime() + i * 1000), runId: `r${i % 2}` }, cfg).file;
    i += 1;
  }
  return f;
}

describe('layout vocabulary against real snapshot shapes', () => {
  it('profile: reads name, headline, degree, about, bell, follow and connect', () => {
    const o = observeLinkedin(profile('3rd'), null);
    expect(o.kind).toBe('profile');
    expect(o.landmarks).toEqual(expect.arrayContaining([
      'profile.name', 'profile.headline', 'profile.degree', 'profile.about', 'profile.bell', 'action:connect', 'action:follow', 'action:more',
    ]));
    expect(o.shell).toBe(true);
    expect(observeLinkedin(profile('1st'), null).landmarks).toEqual(expect.arrayContaining(['profile.message_button', 'action:message']));
  });

  it('profile learned from a 3rd degree page matches a connected profile', () => {
    const f = learnFrom([profile('3rd'), profile('3rd'), profile('3rd'), profile('3rd')]);
    expect(f.kinds.profile.variants.some((v) => v.promoted)).toBe(true);
    for (const rel of ['1st', '2nd', '3rd'] as const) {
      expect(classify(f, observeLinkedin(profile(rel), null), cfg).class).toBe('match');
    }
  });

  it('search: result cards come from invite and follow controls and filters are seen', () => {
    const o = observeLinkedin(search(), null);
    expect(o.landmarks).toEqual(expect.arrayContaining(['results.cards', 'search.filters']));
  });

  it('search: cards found when the tree carries no profile hrefs', () => {
    const raw = page('https://www.linkedin.com/search/results/people/', '<button>Follow Bea Two</button><a href="/x">Invite Cy Three to connect</a>');
    expect(observeLinkedin(raw, null).landmarks).toContain('results.cards');
  });

  it('feed and messaging are known kinds with their own landmarks', () => {
    expect(observeLinkedin(feed(), null).landmarks).toEqual(expect.arrayContaining(['feed.composer', 'feed.posts']));
    expect(observeLinkedin(messaging(), null).landmarks).toEqual(expect.arrayContaining(['messages.search', 'messages.conversations']));
    const f = learnFrom([feed(), feed(), feed(), feed(), messaging(), messaging(), messaging(), messaging()]);
    expect(f.kinds.feed?.variants.some((v) => v.promoted)).toBe(true);
    expect(f.kinds.messaging?.variants.some((v) => v.promoted)).toBe(true);
    expect(classify(f, observeLinkedin(feed(), null), cfg).class).toBe('match');
    expect(classify(f, observeLinkedin(messaging(), null), cfg).class).toBe('match');
  });
});
