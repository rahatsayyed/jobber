// Card-as-button jobs layout and permalink-less hiring posts (live evidence 14 Nov 2026). Synthetic fixtures only: no browser, no real tool.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, saveJob } from '../src/db.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml, SNAPSHOT_SRC } from '../src/linkedin/snapshot.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { searchJobs, parseJobCards } from '../src/linkedin/searchJobs.js';
import { searchPosts, parsePostCards } from '../src/linkedin/searchPosts.js';
import { descriptionOf, jobIdFromUrl, parseButtonCard } from '../src/linkedin/buttonCard.js';
import { CARD_ATTR_SRC, writeDiscoverDiag } from '../src/linkedin/discoverDiag.js';
import { pauseMs, PAUSE_MAX_MS, PAUSE_MIN_MS, MAX_CLICKS } from '../src/linkedin/jobIdResolve.js';
import { syntheticPostRef } from '../src/linkedin/postExtract.js';
import { observeLinkedin } from '../src/layout/fingerprint.js';
import type { DiscoveryConfig } from '../src/linkedin/discoveryConfig.js';
import type { ToolDeps, Screen } from '../src/linkedin/toolDeps.js';
import type { LiPage } from '../src/linkedin/types.js';
import { makeFakeLauncher, type FakeElement, type FakeSite } from './helpers/fakeLinkedin.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const JOBS_URL = 'https://www.linkedin.com/jobs/search-results/?keywords=react&location=Pune';
const POSTS_URL = 'https://www.linkedin.com/search/results/content/?keywords=hiring';
const JP = '/jobs/search/'; // the tool opens /jobs/search/, LinkedIn redirects to /jobs/search-results/ (the snapshot url below)
const PP = '/search/results/content/';
const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const LIVE = { JOBBER_DRY_RUN: 'false' };
const DRY = { JOBBER_DRY_RUN: 'true' };
const CONFIG: DiscoveryConfig = {
  jobs: [{ name: 'react-india', keyword: 'react developer', location: 'India', remote_only: true, limit: 50 }],
  posts: [{ name: 'default', role: 'react developer', geo: 'in', limit: 25 }],
};
const PASS: Screen = async (t) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const });
let dir: string;
const runtimes: Runtime[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'li-bc-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
  chmodSync(path.join(dir, 'state.json'), 0o600);
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(site: FakeSite, env: NodeJS.ProcessEnv = LIVE) {
  const log: string[] = [];
  const db = openDb(':memory:');
  const rt = createRuntime({
    db, launcher: makeFakeLauncher(site, log), sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: DRY,
  });
  runtimes.push(rt);
  const deps: ToolDeps = {
    rt, db, now: () => new Date('2026-11-14T10:00:00Z'), cfg: loadLinkedinConfig(env), env,
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG, screen: PASS, diagDir: path.join(dir, 'diag'),
  };
  return { deps, log, db };
}
const clickEl = (url?: string): FakeElement[] => [{ text: 'card', ...(url ? { navigateTo: url } : {}) }];
// The same page is served under both paths: a click on a card moves the fake browser to the redirected path (as LinkedIn's URL does).
const jobsSite = (html: string, elements: Record<string, FakeElement[]> = {}): FakeSite => {
  const page = { ...buildSnapshotFromHtml(html, JOBS_URL), elements };
  return { pages: { [JP]: page, '/jobs/search-results/': page } } as FakeSite;
};
const rowsOf = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT id, source, title, company, url, description, apply_email, poster_url FROM jobs ORDER BY id').all() as Array<Record<string, string | null>>;
const diagFiles = () => { try { return readdirSync(path.join(dir, 'diag')); } catch { return []; } };

describe('parseButtonCard (the live examples)', () => {
  it('reads company, location, workplace, title, salary and easy apply from the accessible name', () => {
    const a = parseButtonCard('Zenithbyte India (Remote) Dismiss Frontend Developer job 15K INR/month · Be an early applicant');
    expect(a).toMatchObject({ company: 'Zenithbyte', location: 'India', workplace: 'Remote', title: 'Frontend Developer', salary: '15K INR/month', easyApply: false, meta: '' });
    const b = parseButtonCard('Beyond Border Consultants India (Remote) Dismiss Lead Frontend Developer (React.js, Next.js, JavaScript, and TypeScript) job 1M INR/yr - 1.8M INR/yr · Be an early applicant · Easy Apply');
    expect(b).toMatchObject({ company: 'Beyond Border Consultants', location: 'India', workplace: 'Remote', salary: '1M INR/yr - 1.8M INR/yr', easyApply: true });
    expect(b!.title).toBe('Lead Frontend Developer (React.js, Next.js, JavaScript, and TypeScript)');
    expect(parseButtonCard('PayPal Bengaluru Dismiss Software Engineer job · Be an early applicant')).toMatchObject({ company: 'PayPal', location: 'Bengaluru', workplace: '', title: 'Software Engineer', salary: '' });
    expect(parseButtonCard('Amgen Hyderabad (On-site) Dismiss Manager UI – React job · Be an early applicant')).toMatchObject({ company: 'Amgen', location: 'Hyderabad', workplace: 'On-site', title: 'Manager UI – React' });
  });

  it('keeps useful meta, drops noise, and uses the exact dismiss label when the title contains the word job', () => {
    const c = parseButtonCard('Acme Pune (Hybrid) Dismiss Job Coach job Viewed · Actively reviewing applicants · Hiring for a new team', 'Job Coach');
    expect(c).toMatchObject({ company: 'Acme', location: 'Pune', workplace: 'Hybrid', title: 'Job Coach', meta: 'Hiring for a new team' });
    expect(parseButtonCard('no dismiss part here')).toBeNull();
  });

  it('prefers the card lines when company and location are separate lines', () => {
    const c = parseButtonCard('Some Odd Name Quarter Dismiss Dev job', '', ['Some Odd Name', 'Quarter', 'Dev']);
    expect(c).toMatchObject({ company: 'Some Odd Name', location: 'Quarter' });
  });

  it('writes the location as the first description line in the board convention', () => {
    const c = parseButtonCard('Zenithbyte India (Remote) Dismiss Frontend Developer job 15K INR/month · Easy Apply')!;
    expect(descriptionOf(c)).toBe('Location: India (remote)\nSalary: 15K INR/month\nEasy Apply');
    expect(descriptionOf(parseButtonCard('Amgen Hyderabad (On-site) Dismiss X job')!)).toMatch(/^Location: Hyderabad \(on-site\)/);
  });

  it('reads the job id from currentJobId first, else from a /jobs/view path, digits only', () => {
    expect(jobIdFromUrl('https://www.linkedin.com/jobs/search-results/?currentJobId=3912345602&keywords=react')).toBe('3912345602');
    expect(jobIdFromUrl('https://www.linkedin.com/jobs/view/react-dev-at-x-3912345603/?trk=1')).toBe('3912345603');
    expect(jobIdFromUrl('https://www.linkedin.com/jobs/search-results/?currentJobId=abc')).toBeNull();
    expect(jobIdFromUrl('https://www.linkedin.com/jobs/search-results/?keywords=react')).toBeNull();
    expect(jobIdFromUrl('not a url')).toBeNull();
  });
});

describe('button layout snapshot', () => {
  it('builds cards with the button parser, finds the id attribute of card 1 only, and marks the cards for clicking', () => {
    const snap = buildSnapshotFromHtml(fx('jobs-search-buttons.html'), JOBS_URL);
    expect(snap.cardParser).toBe('button');
    expect(snap.linkEvidence).toEqual({ jobs: 0, posts: 0 });
    expect(snap.jobCards).toHaveLength(4);
    expect(snap.jobCards!.map((c) => [c.cardIdx, c.idHint, c.idFrom])).toEqual([
      [0, '3912345601', 'data_job_id'], [1, '', ''], [2, '', ''], [3, '', ''],
    ]);
    expect(snap.jobCards![1].title).toBe('Lead Frontend Developer (React.js, Next.js, JavaScript, and TypeScript)');
  });

  it('counts as a verified results.cards for the layout memory (the permanent drift flag was the missing cards)', () => {
    const snap = buildSnapshotFromHtml(fx('jobs-search-buttons.html'), JOBS_URL);
    expect(observeLinkedin(snap, null).landmarks).toContain('results.cards');
  });

  it('the old link layout still parses with the class-based parser, and a link layout reports its ids as from links', () => {
    const snap = buildSnapshotFromHtml(readFileSync(new URL('./fixtures/linkedin/jobs-search.html', import.meta.url), 'utf8'), 'https://www.linkedin.com/jobs/search/?keywords=react');
    expect(snap.cardParser).toBe('primary');
    const p = parseJobCards(snap, 25);
    expect(p.jobs.length).toBeGreaterThan(0);
    expect(p.pending).toEqual([]);
    expect(p.idFrom).toEqual({ link: p.jobs.length });
  });

  it('the in-page script and the diag script are valid JavaScript', () => {
    expect(() => new Function(`return ${SNAPSHOT_SRC}`)).not.toThrow();
    expect(() => new Function(`return ${CARD_ATTR_SRC}`)).not.toThrow();
  });
});

describe('searchJobs, card-as-button layout', () => {
  it('saves the card with an attribute id, resolves one by a click, skips a stored company+title before clicking, and counts the card with no id', async () => {
    const html = fx('jobs-search-buttons.html');
    const els = {
      '[data-jobber-card="1"]': clickEl('https://www.linkedin.com/jobs/search-results/?currentJobId=3912345602&keywords=react'),
      '[data-jobber-card="2"]': clickEl(), // the click changes nothing: the URL still holds the previous card's id
      '[data-jobber-card="3"]': clickEl('https://www.linkedin.com/jobs/search-results/?currentJobId=3999999999'),
    };
    const { deps, db, log } = setup(jobsSite(html, els));
    saveJob(db, { id: 'li-job:111111111', source: 'naukri', title: 'Manager UI – React', company: 'Amgenix', url: 'u', apply_url: 'u', description: '' });
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({
      status: 'ok', code: 'saved', parser: 'button', fetched: 4, new: 2, seen: 1, known: 1, clicks: 2, no_id: 1,
      no_id_reasons: { stale_id: 1 }, id_from: { attr: 1, click: 1 },
    });
    expect(r.job_ids).toEqual(['li-job:3912345601', 'li-job:3912345602']);
    // card 3 was known by company+title: never clicked; cards 1 and 2 were
    expect(log.filter((l) => l.startsWith('click:'))).toEqual(['click:[data-jobber-card="1"]:card', 'click:[data-jobber-card="2"]:card']);
    const saved = rowsOf(db).filter((x) => x.source === 'linkedin-jobs');
    expect(saved).toEqual([
      expect.objectContaining({
        id: 'li-job:3912345601', title: 'Frontend Developer', company: 'Zenithbyte', url: 'https://www.linkedin.com/jobs/view/3912345601/',
        description: 'Location: India (remote)\nSalary: 15K INR/month',
      }),
      expect.objectContaining({ id: 'li-job:3912345602', company: 'Beyond Border Consultants', url: 'https://www.linkedin.com/jobs/view/3912345602/' }),
    ]);
    expect(saved[1].description).toBe('Location: India (remote)\nSalary: 1M INR/yr - 1.8M INR/yr\nEasy Apply');
    // the result carries counts only, and a counts-only diag file explains the card that has no id
    expect(JSON.stringify(r)).not.toContain('Zenithbyte');
    expect(r.diag).toBeTruthy();
    const f = JSON.parse(readFileSync(path.join(dir, 'diag', diagFiles()[0]), 'utf8'));
    expect(f).toMatchObject({ kind: 'discover_summary', no_id: 1, no_id_reasons: { stale_id: 1 }, id_from: { attr: 1, click: 1 }, clicks: 2, known: 1 });
  });

  it('clicks at most 10 cards per search; the rest are counted as click_limit', async () => {
    const cards = Array.from({ length: 12 }, (_, i) =>
      `<li><div><button aria-label="Company${i}x India Dismiss Unique Role ${i}x job">c</button><button aria-label="Dismiss Unique Role ${i}x job">x</button></div></li>`).join('');
    const html = `<html><body><main><ul>${cards}</ul></main></body></html>`;
    const els: Record<string, FakeElement[]> = {};
    for (let i = 0; i < 12; i++) els[`[data-jobber-card="${i}"]`] = clickEl(i < 3 ? `https://www.linkedin.com/jobs/search-results/?currentJobId=${4000000000 + i}` : undefined);
    const { deps, db, log } = setup(jobsSite(html, els));
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(MAX_CLICKS).toBe(10);
    expect(log.filter((l) => l.startsWith('click:'))).toHaveLength(10);
    expect(r).toMatchObject({ new: 3, clicks: 10, no_id: 9, no_id_reasons: { stale_id: 7, click_limit: 2 } });
    expect(rowsOf(db)).toHaveLength(3);
  });

  it('stops clicking on a login wall and counts the rest with that reason', async () => {
    const html = fx('jobs-search-buttons.html');
    const els = {
      '[data-jobber-card="1"]': clickEl('https://www.linkedin.com/authwall?trk=x'),
      '[data-jobber-card="2"]': clickEl('https://www.linkedin.com/jobs/search-results/?currentJobId=3999999991'),
      '[data-jobber-card="3"]': clickEl('https://www.linkedin.com/jobs/search-results/?currentJobId=3999999992'),
    };
    const { deps, log } = setup(jobsSite(html, els));
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(log.filter((l) => l.startsWith('click:'))).toHaveLength(1);
    expect(r).toMatchObject({ new: 1, clicks: 1, no_id: 3, no_id_reasons: { login_wall: 3 } });
  });

  it('a click that leaves no currentJobId in the URL is counted as no_current_job_id', async () => {
    const els = { '[data-jobber-card="1"]': clickEl(), '[data-jobber-card="2"]': clickEl(), '[data-jobber-card="3"]': clickEl() };
    const { deps } = setup(jobsSite(fx('jobs-search-buttons.html'), els));
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ new: 1, clicks: 3, no_id: 3, no_id_reasons: { no_current_job_id: 3 } });
  });

  it('a click that fails is counted as click_failed, not dropped', async () => {
    const { deps } = setup(jobsSite(fx('jobs-search-buttons.html'), {}));
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ new: 1, no_id: 3, no_id_reasons: { click_failed: 3 } });
  });

  it('a dry run never clicks: the cards without an id are reported as dry_run_no_click', async () => {
    const { deps, log, db } = setup(jobsSite(fx('jobs-search-buttons.html'), {}), DRY);
    const r = await searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'dry_run', no_id: 3, no_id_reasons: { dry_run_no_click: 3 } });
    expect(log.filter((l) => l.startsWith('click:'))).toEqual([]);
    expect(rowsOf(db)).toEqual([]);
  });

  it('the pause between clicks stays in 1.5 to 4 seconds', () => {
    expect(pauseMs(() => 0)).toBe(PAUSE_MIN_MS);
    expect(pauseMs(() => 0.999999)).toBeLessThanOrEqual(PAUSE_MAX_MS);
    expect(PAUSE_MIN_MS).toBe(1500);
    expect(PAUSE_MAX_MS).toBe(4000);
  });
});

describe('hiring posts without a permalink', () => {
  const snap = () => buildSnapshotFromHtml(fx('posts-search-nopermalink.html'), POSTS_URL);

  it('reads company, person and aggregator cards from the control-menu boxes, with links and mailtos', () => {
    const s = snap();
    expect(s.postCards).toHaveLength(5);
    const [co, person, agg, rec] = s.postCards!;
    expect(co).toMatchObject({ authorName: 'Quillfeather Systems', companyName: 'Quillfeather Systems', mailtos: ['hr@quillfeather.example'], outLinks: 1, permalinkHref: '', urn: '' });
    expect(person).toMatchObject({ authorName: 'Meera Nair', profileHref: '/in/meera-nair-demo/', hiringBadge: true });
    expect(agg.outLinks).toBe(10);
    expect(rec.mailtos).toHaveLength(10);
  });

  it('saves the real hiring posts, skips the aggregator and the seeker, and counts every skip by reason', () => {
    const p = parsePostCards(snap(), 25, 'react developer', new Date('2026-11-14T10:00:00Z'));
    expect(p.fetched).toBe(5);
    expect(p.rejected).toEqual({ aggregator: 1, seeker: 1 });
    expect(p.skipped).toBe(2);
    expect(p.jobs).toHaveLength(3);
    const [co, person, rec] = p.jobs;
    // company page author: company from the page, no poster, the mailto is the contact address
    expect(co).toMatchObject({ company: 'Quillfeather Systems', apply_email: 'hr@quillfeather.example', source: 'linkedin-posts' });
    expect(co.poster_url).toBeUndefined();
    expect(co.id).toBe(syntheticPostRef('https://www.linkedin.com/company/quillfeather-demo', 'We are hiring a Senior React Developer.\nLocation: Pune, India (remote friendly)\n3+ years of React and TypeScript experience. Mail resumes to hr@quillfeather.example').id);
    expect(co.url).toMatch(/^https:\/\/www\.linkedin\.com\/company\/quillfeather-demo\/#post-[0-9a-f]{16}$/);
    expect(co.description).toMatch(/^Location: Pune, India/);
    // person with a Hiring badge: lifted although no hiring phrase, company from the headline, poster registered
    expect(person).toMatchObject({ company: 'Brightloom', title: 'Full Stack Developer', poster_url: 'https://www.linkedin.com/in/meera-nair-demo/' });
    // recruiter with ten mailto links: the first non-free-mail address
    expect(rec).toMatchObject({ company: 'Globexa', apply_email: 'talent@globexa.example', poster_url: 'https://www.linkedin.com/in/ravi-shah-demo/' });
    expect(p.authors.map((a) => a.name)).toEqual(['Meera Nair', 'Ravi Shah']);
  });

  it('the post id is stable for the same author and text, and differs for another text', () => {
    const a = syntheticPostRef('https://www.linkedin.com/in/x', '  We are HIRING  a React dev ');
    expect(a.id).toBe(syntheticPostRef('https://www.linkedin.com/in/x', 'we are hiring a react dev').id);
    expect(a.id).not.toBe(syntheticPostRef('https://www.linkedin.com/in/x', 'we are hiring a java dev').id);
    expect(a.id).not.toBe(syntheticPostRef('https://www.linkedin.com/in/y', 'we are hiring a react dev').id);
    expect(a.id).toMatch(/^li-post:[0-9a-f]{16}$/);
  });

  it('searchPosts saves them live, dedupes on the next run, and puts the reasons in the result', async () => {
    const site = { pages: { [PP]: buildSnapshotFromHtml(fx('posts-search-nopermalink.html'), POSTS_URL) } } as FakeSite;
    const { deps, db } = setup(site);
    const r = await searchPosts({ search: 'default' }, deps, { config: CONFIG });
    expect(r).toMatchObject({ status: 'ok', code: 'saved', fetched: 5, new: 3, skipped: 2, people: 2, rejected: { aggregator: 1, seeker: 1 } });
    expect((rowsOf(db)).map((x) => x.company).sort()).toEqual(['Brightloom', 'Globexa', 'Quillfeather Systems']);
    const again = await searchPosts({ search: 'default' }, deps, { config: CONFIG });
    expect(again).toMatchObject({ code: 'no_new', new: 0, seen: 3, rejected: { aggregator: 1, seeker: 1 } });
    // nothing came of the second read except skips: the counts-only file exists
    expect(JSON.parse(readFileSync(path.join(dir, 'diag', diagFiles()[0]), 'utf8'))).toMatchObject({ kind: 'discover_summary', tool: 'search_posts', rejected: { aggregator: 1, seeker: 1 } });
  });
});

describe('diag: attribute names of the cards and query parameter names', () => {
  it('writes attribute names (values only for digit ids) for the card and its ancestors, and the URL query names, not values', async () => {
    const page = {
      evaluate: async (src: string) => (src === CARD_ATTR_SRC
        ? { cards: [[['button', [['class', ''], ['aria-label', ''], ['data-job-id', '3912345601']]], ['li', [['data-occludable-job-id', '3912345601']]]]], query: ['keywords', 'location', 'currentJobId'] }
        : []),
    } as unknown as LiPage;
    const snap = buildSnapshotFromHtml(fx('jobs-search-buttons.html'), JOBS_URL);
    const file = await writeDiscoverDiag(
      { now: () => new Date('2026-11-14T10:00:00Z'), page, diagDir: path.join(dir, 'diag') },
      { tool: 'search_jobs', search: 'react-india', url: JOBS_URL, snapshot: snap, layout: 'match', reason: 'no_cards_parse_drift' },
    );
    expect(file).toBeTruthy();
    const f = JSON.parse(readFileSync(path.join(dir, 'diag', diagFiles()[0]), 'utf8'));
    expect(f.url_query_names).toEqual(['keywords', 'location']);
    expect(f.card_attrs.page_query_names).toEqual(['keywords', 'location', 'currentJobId']);
    expect(f.card_attrs.cards[0][0]).toEqual({ tag: 'button', attrs: ['class', 'aria-label', 'data-job-id=3912345601'] });
    expect(f.card_attrs.cards[0][1].attrs).toEqual(['data-occludable-job-id=3912345601']);
    expect(JSON.stringify(f)).not.toContain('Pune');
  });
});
