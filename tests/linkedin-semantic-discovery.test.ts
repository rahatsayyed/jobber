// Layout-proof LinkedIn discovery: the href-based fallback parser (proved on pages with NO known class names), the
// zero-card detection (real empty page vs broken parse), the diag file, the streak, the hourly alert, `status health`,
// and the seeker-post rejection. All fixtures are synthetic; no browser, no real tool.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { searchJobs, parseJobCards } from '../src/linkedin/searchJobs.js';
import { searchPosts, parsePostCards } from '../src/linkedin/searchPosts.js';
import { classifyZeroCards, listStreaks, readStreak, STREAK_ALERT_AT } from '../src/linkedin/discoverHealth.js';
import { classifyPost } from '../src/linkedin/postExtract.js';
import { renderHealth } from '../src/status/render.js';
import { buildSnapshot } from '../src/status/snapshot.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import type { DiscoveryConfig } from '../src/linkedin/discoveryConfig.js';
import type { ToolDeps, Screen } from '../src/linkedin/toolDeps.js';
import type { Notifier } from '../src/platform/notify.js';
import { makeFakeLauncher, type FakeSite } from './helpers/fakeLinkedin.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const JOBS_URL = 'https://www.linkedin.com/jobs/search/?keywords=react';
const POSTS_URL = 'https://www.linkedin.com/search/results/content/?keywords=hiring';
const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const LIVE = { JOBBER_DRY_RUN: 'false' };
const CONFIG: DiscoveryConfig = {
  jobs: [{ name: 'react-india', keyword: 'react developer', location: 'India', remote_only: true, limit: 25 }],
  posts: [{ name: 'default', role: 'react developer', geo: 'in', limit: 25 }],
};
const PASS: Screen = async (t) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const });

// ---- synthetic pages: hashed class names only, so only the href patterns can work --------------------------------
// Fields are written as <span>; real cards put each field in its own block, so they are turned into <div> here.
const blocks = (h: string): string => h.replace(/<(\/?)span/g, '<$1div');
const JOBS_NO_CLASSES = () => blocks(JOBS_RAW);
const POSTS_NO_CLASSES = () => blocks(POSTS_RAW);
const POSTS_DATA_URN = () => blocks(POSTS_URN_RAW);
const JOBS_RAW = `<html><head><title>Jobs</title></head><body><main>
<nav><a href="/feed/">Home</a><a href="/jobs/">Jobs</a></nav>
<div class="x9f2"><ul class="q1">
 <li class="a7k"><div class="b2"><div class="c3"><a class="zz1" href="/jobs/view/3912345678/?refId=abc&trackingId=t" aria-label="Senior React Developer with verification">Senior React Developer</a>
   <span class="d4">Acme Systems</span><span class="d5">Pune, Maharashtra (Hybrid)</span><span class="d6">Promoted</span><span class="d7">Easy Apply</span></div></div></li>
 <li class="a7k"><div class="b2"><div class="c3"><a class="zz1" href="/jobs/view/full-stack-engineer-at-globex-3999999999">Full Stack Engineer</a>
   <span class="d4">Globex Corp</span><span class="d5">Remote</span></div><a class="logo" href="/jobs/view/full-stack-engineer-at-globex-3999999999"><img alt=""></a></div></li>
 <li class="a7k"><div class="b2"><div class="c3"><a class="zz1" href="/jobs/view/3888888888/">Node.js Backend Developer</a>
   <span class="d4">Initech</span><span class="d5">Bengaluru</span></div></div></li>
</ul></div></main></body></html>`;

const POSTS_RAW = `<html><head><title>Content</title></head><body><main><div class="k1">
 <div class="p9"><div class="h1"><a href="/in/jane-doe-123/"><span>Jane Doe</span></a><span>Engineering Manager at Acme Systems</span><span>2d</span></div>
  <div class="t2"><span>We are hiring a React developer in Pune. 3+ years experience, Node.js. Email hr@acme.example</span></div>
  <a class="perma" href="/feed/update/urn:li:activity:7000000000000000001/">Open post</a><button>Like</button><button>Comment</button></div>
 <div class="p9"><div class="h1"><a href="/in/raj-kumar-9/"><span>Raj Kumar</span></a><span>Founder at Globex</span><span>1w</span></div>
  <div class="t2"><span>Hiring: Full Stack Engineer (React, Node). Remote friendly. Apply via the link.</span></div>
  <a class="perma" href="/posts/raj-kumar-9_hiring-fullstack-activity-7000000000000000002-AbCd">Open post</a></div>
</div></main></body></html>`;

const POSTS_URN_RAW = `<html><head><title>Content</title></head><body><main>
 <div class="p9" data-urn="urn:li:activity:7000000000000000003"><a href="/in/sam-lee-7/"><span>Sam Lee</span></a><span>CTO at Hooli</span><span>3d</span>
  <div>We're hiring a full stack developer to join our team in Bengaluru. React, TypeScript, 4 years experience.</div></div>
 <div class="p9" data-urn="urn:li:activity:7000000000000000004"><a href="/in/ana-ray-2/"><span>Ana Ray</span></a><span>Lead at Pied Piper</span><span>4d</span>
  <div>Hiring a Node.js engineer. Send your CV.</div></div>
</main></body></html>`;

const EMPTY_PAGE = `<html><head><title>Jobs</title></head><body><main><h1>No matching jobs found.</h1>
<p>Try again with different keywords or remove some filters.</p></main></body></html>`;

// Results exist (job links) but no card can be built: links carry no title text and no aria-label.
const BROKEN_LINKS = `<html><head><title>Jobs</title></head><body><main><div class="r1"><div class="r2"><a href="/jobs/view/3911111111/"></a></div>
<div class="r2"><a href="/jobs/view/3922222222/"></a></div></div></main></body></html>`;

// Lots of text, no links, no empty-state wording.
const TEXT_ROWS = Array.from({ length: 24 }, (_, i) => `<div class="r${i}"><span>Visible result text number ${i} without any link in it, long enough to count as substance.</span></div>`).join('');
const BROKEN_TEXT = `<html><head><title>Jobs</title></head><body><main>${TEXT_ROWS}</main></body></html>`;

describe('semantic card parser (no known class names)', () => {
  it('builds job cards from /jobs/view hrefs alone, dedupes the two links of one card, and says it was the semantic parser', () => {
    const snap = buildSnapshotFromHtml(JOBS_NO_CLASSES(), JOBS_URL);
    expect(snap.cardParser).toBe('semantic');
    expect(snap.jobCards).toHaveLength(3);
    expect(snap.linkEvidence).toEqual({ jobs: 3, posts: 0 });
    const [a, b, c] = snap.jobCards!;
    expect(a.title).toContain('Senior React Developer');
    expect(a.company).toBe('Acme Systems');
    expect(a.snippet).toContain('Pune');
    expect(a.snippet).not.toContain('Promoted');
    expect(a.easyApply).toBe(true);
    expect(a.href).toBe('/jobs/view/3912345678/');
    expect(b.title).toBe('Full Stack Engineer');
    expect(b.company).toBe('Globex Corp');
    expect(b.href).toBe('/jobs/view/3999999999/');
    expect(c.company).toBe('Initech');
    const parsed = parseJobCards(snap, 25);
    expect(parsed.jobs.map((j) => j.id)).toEqual(['li-job:3912345678', 'li-job:3999999999', 'li-job:3888888888']);
    expect(parsed.jobs[0].title).toBe('Senior React Developer');
    expect(parsed.jobs[0].company).toBe('Acme Systems');
  });

  it('builds post cards from permalink hrefs (feed/update and /posts/ slug) with the author from the /in/ link', () => {
    const snap = buildSnapshotFromHtml(POSTS_NO_CLASSES(), POSTS_URL);
    expect(snap.cardParser).toBe('semantic');
    expect(snap.postCards).toHaveLength(2);
    expect(snap.postCards![0].profileHref).toBe('/in/jane-doe-123/');
    expect(snap.postCards![0].authorName).toBe('Jane Doe');
    const p = parsePostCards(snap, 25, 'react developer', new Date('2026-10-16T10:00:00Z'));
    expect(p.jobs.map((j) => j.id)).toEqual(['li-post:7000000000000000001', 'li-post:7000000000000000002']);
    expect(p.jobs[0].poster_url).toBe('https://www.linkedin.com/in/jane-doe-123/');
    expect(p.jobs[0].apply_email).toBe('hr@acme.example');
    expect(p.authors.length).toBeGreaterThan(0);
  });

  it('builds post cards from data-urn when the card has no permalink link', () => {
    const snap = buildSnapshotFromHtml(POSTS_DATA_URN(), POSTS_URL);
    expect(snap.cardParser).toBe('semantic');
    expect(snap.postCards).toHaveLength(2);
    expect(snap.postCards![0].urn).toBe('urn:li:activity:7000000000000000003');
    const p = parsePostCards(snap, 25, 'react developer', new Date('2026-10-16T10:00:00Z'));
    expect(p.jobs.map((j) => j.id)).toEqual(['li-post:7000000000000000003', 'li-post:7000000000000000004']);
  });

  it('keeps the primary parser first: the class-based fixture reports parser primary and is not touched', () => {
    const snap = buildSnapshotFromHtml(fx('jobs-search.html'), JOBS_URL);
    expect(snap.jobCards!.length).toBeGreaterThan(0);
    expect(snap.cardParser).toBe('primary');
  });
});

describe('zero cards: real empty page vs broken parse', () => {
  it('an explicit no-results page is a real empty page', () => {
    expect(classifyZeroCards(buildSnapshotFromHtml(EMPTY_PAGE, JOBS_URL))).toBe('real_empty');
  });
  it('job links that produced no card, or a page full of text with no empty-state wording, is a broken parse', () => {
    const a = buildSnapshotFromHtml(BROKEN_LINKS, JOBS_URL);
    expect(a.jobCards).toEqual([]);
    expect(a.linkEvidence!.jobs).toBe(2);
    expect(classifyZeroCards(a)).toBe('broken');
    const b = buildSnapshotFromHtml(BROKEN_TEXT, JOBS_URL);
    expect(b.jobCards).toEqual([]);
    expect(classifyZeroCards(b)).toBe('broken');
  });
});

describe('discovery tools on broken and empty pages', () => {
  let dir: string;
  const runtimes: Runtime[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'li-sem-'));
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
    chmodSync(path.join(dir, 'state.json'), 0o600);
  });
  afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(html: string, url: string, pathKey: string, env: NodeJS.ProcessEnv = LIVE) {
    const sent: string[] = [];
    const notify: Notifier = { send: async (t) => { sent.push(t); return { ok: true, detail: 'test' }; } };
    const log: string[] = [];
    const db = openDb(':memory:');
    const site = { pages: { [pathKey]: buildSnapshotFromHtml(html, url) } } as FakeSite;
    const rt = createRuntime({ db, launcher: makeFakeLauncher(site, log), sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: LIVE });
    runtimes.push(rt);
    let t = new Date('2026-10-16T10:00:00Z').getTime();
    const deps: ToolDeps = {
      rt, db, now: () => new Date(t), cfg: loadLinkedinConfig(env), env,
      factCheck: (x) => ({ verdict: 'pass', normalized_text: x }), styleCfg: DEFAULT_STYLE_CONFIG, screen: PASS, notify, diagDir: path.join(dir, 'diag'),
    };
    return { deps, db, sent, advance: (ms: number) => { t += ms; } };
  }

  it('real empty page: ok, no_results, no diag file, no alert, no streak', async () => {
    const { deps, sent, db } = setup(EMPTY_PAGE, JOBS_URL, '/jobs/search/');
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'ok', code: 'no_results', fetched: 0, new: 0, parser: 'primary' });
    expect(existsSync(path.join(dir, 'diag'))).toBe(false);
    expect(sent).toHaveLength(0);
    expect(listStreaks(db)).toEqual([]);
  });

  it('broken parse: failed no_cards_parse_drift, diag file (0600, structure only), streak, one alert per hour, status health line', async () => {
    const { deps, sent, db, advance } = setup(BROKEN_LINKS, JOBS_URL, '/jobs/search/');
    const r1 = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r1).toMatchObject({ status: 'failed', code: 'no_cards_parse_drift', fetched: 0, new: 0, streak: 1 });
    expect(r1.diag).toBeTruthy();
    const files = readdirSync(path.join(dir, 'diag'));
    expect(files).toHaveLength(1);
    const f = path.join(dir, 'diag', files[0]);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(f, 'utf8'));
    expect(body).toMatchObject({ kind: 'discover_no_cards', tool: 'search_jobs', search: 'react-india', url_path: '/jobs/search/', card_parser: 'primary' });
    expect(body.link_evidence).toEqual({ jobs: 2, posts: 0 });
    expect(JSON.stringify(body)).not.toMatch(/li_at|SENTINEL|keywords=/);
    // The operator gets a summary to diagnose; plain drift does NOT alert the owner (the system heals first).
    expect(r1.summary).toMatchObject({ job_links: 2, post_links: 0, login_wall: false, guest_hint: null });
    expect(sent).toHaveLength(0);

    // Second and third failure: streak grows, still no alert.
    advance(10 * 60_000);
    const r2 = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r2.streak).toBe(2);
    advance(10 * 60_000);
    const r3 = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r3.streak).toBe(STREAK_ALERT_AT);
    expect(sent).toHaveLength(0);
    expect(readStreak(db, 'search_jobs', 'react-india')?.count).toBe(3);

    const health = renderHealth(buildSnapshot(db, loadOutreachConfig(LIVE), new Date(), LIVE), []);
    expect(health).toMatch(/PROBLEM linkedin search_jobs "react-india": 3 broken parses in a row/);
    expect(health).toContain('evidence:');

    // Still broken after 24h with no good read: CRITICAL, one alert, then at most one per hour.
    advance(25 * 3600_000);
    await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('react-india');
    expect(sent[0]).toContain('not reading any cards');
    advance(10 * 60_000);
    await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(sent).toHaveLength(1);
    advance(61 * 60_000);
    await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(sent).toHaveLength(2);
  });

  it('a guest or logged-out page with 0 cards alerts at once (critical), summary says login wall, once per hour', async () => {
    const guest = '<html><head><title>Sign in</title></head><body><main><h1>Sign in to view more jobs</h1><div>Join LinkedIn or sign in to continue</div>'
      + `${TEXT_ROWS}</main></body></html>`;
    const { deps, sent, advance } = setup(guest, JOBS_URL, '/jobs/search/');
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'failed', code: 'no_cards_parse_drift' });
    expect(r.summary).toMatchObject({ login_wall: true });
    expect(r.summary!.headings).toContain('Sign in to view more jobs');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('session problem');
    advance(5 * 60_000);
    await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(sent).toHaveLength(1);
  });

  it('broken parse also fails in dry run (the search never counts as done)', async () => {
    const { deps } = setup(BROKEN_TEXT, JOBS_URL, '/jobs/search/', { JOBBER_DRY_RUN: 'true' });
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'failed', code: 'no_cards_parse_drift' });
  });

  it('posts search: a page of post links that gives no card is a broken parse too', async () => {
    const html = '<html><head><title>c</title></head><body><main><div><a href="/feed/update/urn:li:activity:7000000000000000009/">x</a></div></main></body></html>';
    const { deps } = setup(html, POSTS_URL, '/search/results/content/');
    const r = await searchPosts({ search: 'default' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'failed', code: 'no_cards_parse_drift' });
  });

  it('a layout-changed page is saved through the semantic parser, reports parser semantic and clears the streak', async () => {
    const { deps, db } = setup(JOBS_NO_CLASSES(), JOBS_URL, '/jobs/search/');
    db.prepare("INSERT INTO scheduler_state (key, value, updated_at) VALUES ('li_discover_broken:search_jobs:react-india', ?, ?)")
      .run(JSON.stringify({ count: 4, since: '2026-10-10T00:00:00Z', last_at: '2026-10-15T00:00:00Z', search: 'react-india', diag: null }), '2026-10-15T00:00:00Z');
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'ok', code: 'saved', fetched: 3, new: 3, parser: 'semantic' });
    expect(listStreaks(db)).toEqual([]);
  });
});

describe('classifyPost: job-seeker posts', () => {
  const SEEKER_POST = "I'm looking for Full-Stack Developer roles (React, Node.js). 4 years experience. Open to work, happy to relocate. Please share any openings you know of.";
  it('rejects the real seeker post pattern', () => {
    expect(classifyPost(SEEKER_POST)).toEqual({ hiring: false, reason: 'seeker' });
  });
  it.each([
    'I am actively looking for a React developer role. Open to work.',
    'Seeking a role as a full stack developer, 3 years of experience in Node.js.',
    'Today was my last day at my company. Looking for my next role as a frontend developer.',
    'I was laid off last week. Any React developer openings? Please refer me.',
    'Hire me: full stack developer, React and Node. Available to join immediately.',
    "I'm looking for opportunities as a backend engineer. #hiring managers please DM.",
  ])('rejects: %s', (t) => {
    expect(classifyPost(t)).toEqual({ hiring: false, reason: 'seeker' });
  });
  it('still accepts a poster who hires for their own team, even when seeker words appear', () => {
    expect(classifyPost("We're hiring a React developer in Pune. If you're open to work with a small team, send your CV.").hiring).toBe(true);
    expect(classifyPost('My team is hiring a full stack engineer. Apply at the link, 3+ years of experience in Node.').hiring).toBe(true);
    expect(classifyPost('Join us at Acme: we are looking for a React developer, remote. Email jobs@acme.example').hiring).toBe(true);
  });
  it('still accepts plain hiring posts', () => {
    expect(classifyPost('We are hiring a React developer in Pune.').hiring).toBe(true);
  });
});
