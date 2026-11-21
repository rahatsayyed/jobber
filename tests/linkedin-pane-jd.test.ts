// Jobs search: the description is read from the right-hand pane at click time, the left list is scrolled, budgets and trouble stops.
// Fakes only: no browser, no network. The pane DOM is unverified live, so the in-page read is answered by a scripted fake (site.evaluate).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, saveJob } from '../src/db.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { searchJobs } from '../src/linkedin/searchJobs.js';
import { collectByScrolling, scrollRoundsFor } from '../src/linkedin/discoverCommon.js';
import { PANE_DIAG_SRC } from '../src/linkedin/discoverDiag.js';
import {
  headingMatches, hasMoreTail, looksClamped, PANE_SRC, paneJdText, paneReady, troubleOf, type PaneRead,
} from '../src/linkedin/paneJd.js';
import { jobClicksPerSearchFor, clickCards } from '../src/linkedin/jobIdResolve.js';
import { LINKEDIN_SIGNALS_SRC, linkedinSignalsSrc } from '../src/linkedinSignals.js';
import { countSince, haltPlatform } from '../src/outreach/limits.js';
import { markJdPending } from '../src/jdStore.js';
import { needsJdFetch } from '../src/jdComplete.js';
import type { DiscoveryConfig } from '../src/linkedin/discoveryConfig.js';
import type { ToolDeps, Screen } from '../src/linkedin/toolDeps.js';
import type { RawSnapshot } from '../src/linkedin/types.js';
import { makeFakeLauncher, type FakeElement, type FakeSite } from './helpers/fakeLinkedin.js';
import { FULL_JD } from './helpers/jdFixtures.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const JOBS_URL = 'https://www.linkedin.com/jobs/search-results/?keywords=react&location=Pune';
const SEARCH_PATHS = ['/jobs/search/', '/jobs/search-results/'];
const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const CONFIG: DiscoveryConfig = {
  jobs: [{ name: 'react-india', keyword: 'react developer', location: 'India', remote_only: true, limit: 50 }],
  posts: [{ name: 'default', role: 'react developer', geo: 'in', limit: 25 }],
};
const PASS: Screen = async (t) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const });
const LIVE = { JOBBER_DRY_RUN: 'false', LINKEDIN_JOB_SCROLL_ROUNDS: '0' } as NodeJS.ProcessEnv;
const IDS = ['3912345601', '3912345602', '3912345603', '3912345604'];
const TITLES = ['Frontend Developer', 'Lead Frontend Developer (React.js, Next.js, JavaScript, and TypeScript)', 'Software Engineer', 'Manager UI – React'];
const urlFor = (n: number) => `https://www.linkedin.com/jobs/search-results/?currentJobId=${IDS[n]}&keywords=react`;
const idOf = (url: string) => /currentJobId=(\d+)/.exec(url)?.[1] ?? '';

let dir: string;
const runtimes: Runtime[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'li-pane-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
  chmodSync(path.join(dir, 'state.json'), 0o600);
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

type PaneFn = (id: string, url: string) => Partial<PaneRead> | null;
/** A pane read as the in-page script would return it; `fn` decides per job, `null` means nothing is selected (no "About the job"). */
function evaluator(fn: PaneFn, extra: (src: string) => unknown = () => null) {
  return (src: string, current: string): unknown => {
    if (src === PANE_SRC) {
      const id = idOf(current);
      const p = id ? fn(id, current) : null;
      const base = { url: current, hasAbout: false, paneFound: false, heading: '', paneText: '', bodyText: '', more: false, signals: null };
      return p ? { ...base, hasAbout: true, paneFound: true, ...p } : { ...base, bodyText: '', ...(fn('', current) ?? {}) };
    }
    return extra(src);
  };
}
const goodPane = (id: string, jd = FULL_JD): Partial<PaneRead> => {
  const n = IDS.indexOf(id);
  return { heading: TITLES[n] ?? '', paneText: `${TITLES[n]}\nAbout the job\n${jd}`, bodyText: `list stuff\n${TITLES[n]}\nAbout the job\n${jd}` };
};

function setup(evaluate: FakeSite['evaluate'], env: NodeJS.ProcessEnv = LIVE, o: { screen?: Screen; els?: Record<string, FakeElement[]> } = {}) {
  const log: string[] = [];
  const db = openDb(':memory:');
  const els: Record<string, FakeElement[]> = o.els ?? {};
  if (!o.els) for (let i = 0; i < 4; i++) els[`[data-jobber-card="${i}"]`] = [{ text: `card${i}`, navigateTo: urlFor(i) }];
  const page = { ...buildSnapshotFromHtml(fx('jobs-search-buttons.html'), JOBS_URL), elements: els };
  const site = { pages: Object.fromEntries(SEARCH_PATHS.map((p) => [p, page])), evaluate } as FakeSite;
  const rt = createRuntime({
    db, launcher: makeFakeLauncher(site, log), sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: { JOBBER_DRY_RUN: 'true' },
  });
  runtimes.push(rt);
  const deps: ToolDeps = {
    rt, db, now: () => new Date('2026-11-14T10:00:00Z'), cfg: loadLinkedinConfig(env), env,
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG, screen: o.screen ?? PASS, diagDir: path.join(dir, 'diag'),
  };
  return { deps, db, log, els };
}
const run = (deps: ToolDeps) => searchJobs({ search: 'react-india' }, deps, { config: CONFIG });
const cardClicks = (log: string[]) => log.filter((l) => l.startsWith('click:[data-jobber-card'));
const job = (db: ReturnType<typeof openDb>, n: number) =>
  db.prepare('SELECT id, description, status, jd_fetched_at, li_connections FROM jobs WHERE id = ?').get(`li-job:${IDS[n]}`) as
  { id: string; description: string | null; status: string | null; jd_fetched_at: string | null; li_connections: number | null } | undefined;
const diagFiles = () => { try { return readdirSync(path.join(dir, 'diag')); } catch { return []; } };

describe('pane read at click time', () => {
  it('reads the full description of every card from the pane, saves it, and charges no job page fetch', async () => {
    const { deps, db, log } = setup(evaluator((id) => ({
      ...goodPane(id), signals: { top: 'Acme Remote 3 connections work here', hiring: [], hasHiring: false, probe: [] },
    })));
    const r = await run(deps);
    expect(r).toMatchObject({ status: 'ok', code: 'saved', new: 4, clicks: 4, click_failed: 0, jd_from_pane: 4, jd_pane_incomplete: 0, jd_known_skipped: 0 });
    expect(cardClicks(log)).toHaveLength(4);
    for (let n = 0; n < 4; n++) {
      const j = job(db, n)!;
      expect(j.description!.startsWith('We are hiring')).toBe(true);
      expect(j.description!.length).toBeGreaterThan(400);
      expect(j.jd_fetched_at).toBeTruthy();
      expect(j.status).toBeNull();
      expect(needsJdFetch('linkedin-jobs', j.description)).toBe(false);
    }
    expect(job(db, 0)!.li_connections).toBe(3);
    expect(countSince(db, 'linkedin_jd_fetch', new Date(0))).toBe(0);
    expect(countSince(db, 'linkedin_profile_view', new Date(0))).toBe(0);
    expect(countSince(db, 'linkedin_card_click', new Date(0))).toBe(4);
    expect(JSON.stringify(r)).not.toContain('We are hiring');
  });

  it('expands a clamped description with the "more" control and reads again', async () => {
    let expanded = false;
    const clamped = 'We are hiring a full stack engineer to build React products and more. Short start… more';
    const { deps, db, log, els } = setup(evaluator((id) => (id === IDS[0]
      ? expanded ? goodPane(id) : { heading: TITLES[0], paneText: `${TITLES[0]}\nAbout the job\n${clamped}`, bodyText: clamped, more: true }
      : goodPane(id))));
    els['[data-jobber-more="1"]'] = [{ text: 'more', onClick: () => { expanded = true; } }];
    const r = await run(deps);
    expect(log).toContain('click:[data-jobber-more="1"]:more');
    expect(r).toMatchObject({ jd_from_pane: 4, jd_pane_incomplete: 0 });
    expect(job(db, 0)!.description).toContain('PostgreSQL');
    expect(job(db, 0)!.description!.endsWith('more')).toBe(false);
  });

  it('a short text with a "more" control that never expands is not stored and leaves the job as it is', async () => {
    const short = 'Build React products.';
    const { deps, db } = setup(evaluator((id) => (id === IDS[0]
      ? { heading: TITLES[0], paneText: `${TITLES[0]}\nAbout the job\n${short}`, bodyText: short, more: true }
      : goodPane(id))));
    saveJob(db, { id: `li-job:${IDS[0]}`, source: 'linkedin-jobs', title: TITLES[0], company: 'Zenithbyte', url: `https://www.linkedin.com/jobs/view/${IDS[0]}/`, apply_url: 'u', description: 'Location: India' });
    markJdPending(db, `li-job:${IDS[0]}`);
    const r = await run(deps);
    expect(r).toMatchObject({ jd_from_pane: 3, jd_pane_incomplete: 1, jd_pane_reasons: { more_click_failed: 1 } });
    expect(job(db, 0)).toMatchObject({ description: 'Location: India', status: 'jd_pending', jd_fetched_at: null });
  });

  it('a clamped text with no "more" control found is counted as clamped_no_more and not stored', async () => {
    const { deps, db } = setup(evaluator((id) => (id === IDS[1] ? goodPane(id, `${FULL_JD}… more`) : goodPane(id))));
    const r = await run(deps);
    expect(r).toMatchObject({ jd_from_pane: 3, jd_pane_incomplete: 1, jd_pane_reasons: { clamped_no_more: 1 } });
    expect(job(db, 1)!.description).not.toContain('PostgreSQL');
  });

  it('does not store a pane that shows another job (heading of a different title)', async () => {
    const { deps, db } = setup(evaluator((id) => (id === IDS[2] ? { ...goodPane(id), heading: 'Senior Accountant' } : goodPane(id))));
    const r = await run(deps);
    expect(r).toMatchObject({ jd_from_pane: 3, jd_pane_reasons: { pane_title_mismatch: 1 } });
    expect(job(db, 2)!.description).not.toContain('PostgreSQL');
  });

  it('text the classifier blocks is not stored (counted as blocked)', async () => {
    const screen: Screen = async (t) => (t.includes('PostgreSQL') && t.includes('BLOCKME')
      ? { blocked: true, unscreened: false, text: '', flags: ['x'], code: 'injection_suspected' as const }
      : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const });
    const { deps, db } = setup(evaluator((id) => goodPane(id, id === IDS[3] ? `BLOCKME ${FULL_JD}` : FULL_JD)), LIVE, { screen });
    const r = await run(deps);
    expect(r).toMatchObject({ jd_from_pane: 3, jd_pane_incomplete: 1, jd_pane_reasons: { blocked: 1 } });
    expect(job(db, 3)!.description).not.toContain('BLOCKME');
  });

  it('a job already stored with a full description is not clicked (known, no click needed)', async () => {
    const { deps, db, log } = setup(evaluator((id) => goodPane(id)));
    saveJob(db, { id: `li-job:${IDS[0]}`, source: 'linkedin-jobs', title: TITLES[0], company: 'Zenithbyte', url: 'u', apply_url: 'u', description: FULL_JD });
    const r = await run(deps);
    expect(r).toMatchObject({ jd_known_skipped: 1, clicks: 3, jd_from_pane: 3 });
    expect(cardClicks(log)).not.toContain('click:[data-jobber-card="0"]:card0');
    expect(cardClicks(log)).toHaveLength(3);
    expect(job(db, 0)!.description).toBe(FULL_JD);
  });

  it('a dry run clicks nothing and saves nothing', async () => {
    const { deps, db, log } = setup(evaluator((id) => goodPane(id)), { JOBBER_DRY_RUN: 'true', LINKEDIN_JOB_SCROLL_ROUNDS: '0' });
    const r = await run(deps);
    expect(r.status).toBe('dry_run');
    expect(cardClicks(log)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0);
    expect(countSince(db, 'linkedin_card_click', new Date(0))).toBe(0);
  });
});

describe('click budgets and stops', () => {
  it('stops at LINKEDIN_JOB_CLICKS_PER_SEARCH and counts the rest by reason', async () => {
    const { deps, log } = setup(evaluator((id) => goodPane(id)), { ...LIVE, LINKEDIN_JOB_CLICKS_PER_SEARCH: '2' });
    const r = await run(deps);
    expect(cardClicks(log)).toHaveLength(2);
    // card 0 has an id (pane read); cards 1 and 2 were clicked; card 3 and the last pending card are over the budget
    expect(r).toMatchObject({ clicks: 2, jd_from_pane: 2, no_id: 2, no_id_reasons: { click_limit: 2 } });
    expect(r.jd_pane_reasons).toBeUndefined();
  });

  it('the daily LINKEDIN_MAX_CARD_CLICKS_PER_DAY ceiling ends the clicking', async () => {
    const { deps, log, db } = setup(evaluator((id) => goodPane(id)), { ...LIVE, LINKEDIN_MAX_CARD_CLICKS_PER_DAY: '2' });
    const r = await run(deps);
    expect(cardClicks(log)).toHaveLength(2);
    expect(r).toMatchObject({ status: 'ok', clicks: 2, stopped: 'card_click_limit', jd_from_pane: 2 });
    expect(countSince(db, 'linkedin_card_click', new Date(0))).toBe(2);
  });

  it('stops on a 429 or "unusual activity" page and reports rate_limited, keeping what was read', async () => {
    // card 2 shows a warning page instead of a job
    const { deps, log, db } = setup(evaluator((id) => (id === IDS[1] ? { hasAbout: false, paneFound: false, bodyText: 'Too many requests. We noticed unusual activity.' } : goodPane(id))));
    const r = await run(deps);
    expect(r).toMatchObject({ status: 'rate_limited', code: 'page_rate_limit', stopped: 'rate_limit', clicks: 2, jd_from_pane: 1 });
    expect(cardClicks(log)).toHaveLength(2);
    expect(job(db, 0)!.description).toContain('PostgreSQL');
  });

  it('stops on a login wall and reports failed with the code', async () => {
    const els: Record<string, FakeElement[]> = {
      '[data-jobber-card="0"]': [{ text: 'c0', navigateTo: urlFor(0) }],
      '[data-jobber-card="1"]': [{ text: 'c1', navigateTo: 'https://www.linkedin.com/authwall?trk=x' }],
      '[data-jobber-card="2"]': [{ text: 'c2', navigateTo: urlFor(2) }],
      '[data-jobber-card="3"]': [{ text: 'c3', navigateTo: urlFor(3) }],
    };
    const { deps, log } = setup(evaluator((id) => goodPane(id)), LIVE, { els });
    const r = await run(deps);
    expect(r).toMatchObject({ status: 'failed', code: 'login_wall', stopped: 'login_wall', clicks: 2, jd_from_pane: 1 });
    expect(cardClicks(log)).toHaveLength(2);
  });

  it('stops when a halt is set before the next click', async () => {
    const { deps, db } = setup(evaluator((id) => goodPane(id)));
    haltPlatform(db, 'linkedin', 'test', new Date());
    const r = await run(deps);
    expect(r.status).toBe('halted');
  });

  it('stops when the kill switch answers', async () => {
    const { deps, log } = setup(evaluator((id) => goodPane(id)));
    let calls = 0;
    deps.killed = () => (++calls > 1 ? 'kill switch: STOP file' : null);
    const r = await run(deps);
    expect(cardClicks(log)).toHaveLength(1);
    expect(r).toMatchObject({ status: 'halted', code: 'killed', stopped: 'killed', clicks: 1 });
  });

  it('with clicks per search 0 only cards without an id are clicked and no pane is read (old behaviour)', async () => {
    let paneReads = 0;
    const { deps, log } = setup((src, cur) => { if (src === PANE_SRC) paneReads++; return evaluator((id) => goodPane(id))(src, cur); }, { ...LIVE, LINKEDIN_JOB_CLICKS_PER_SEARCH: '0' });
    const r = await run(deps);
    expect(paneReads).toBe(0);
    expect(cardClicks(log)).toHaveLength(3);
    expect(r.jd_from_pane).toBeUndefined();
  });

  it('writes ONE structure diag when clicks never showed an "About the job" section, and gives up pane reads after three', async () => {
    const { deps, log } = setup(evaluator(() => null, (src) => (src === PANE_DIAG_SRC ? { found: false, chain: [], near: [['button', '', 'Show more', '', 0, 9, 'Show more']], hints: [['span', '', '', 'x', 0, 5, 'About']], body_chars: 100 } : null)));
    const r = await run(deps);
    expect(r.clicks).toBeGreaterThanOrEqual(3);
    expect(r.jd_from_pane).toBe(0);
    expect(r.jd_pane_reasons?.pane_not_found).toBe(3);
    expect(r.pane_diag).toBeTruthy();
    const files = diagFiles().filter((f) => f.startsWith('linkedin-discover-search_jobs-'));
    const paneFiles = files.filter((f) => JSON.parse(readFileSync(path.join(dir, 'diag', f), 'utf8')).kind === 'discover_pane');
    expect(paneFiles).toHaveLength(1);
    const d = JSON.parse(readFileSync(path.join(dir, 'diag', paneFiles[0]), 'utf8'));
    expect(d).toMatchObject({ kind: 'discover_pane', heading_found: false, clicks: r.clicks });
    expect(d.controls_near_pane[0]).toContain('Show more');
    void log;
  });
});

describe('clickCards direct', () => {
  it('a card with a known id and no marker is found by its link', async () => {
    const { deps, log, els } = setup(evaluator((id) => goodPane(id)));
    els[`a[href*="${IDS[0]}"]`] = [{ text: 'link0', navigateTo: urlFor(0) }];
    await deps.rt.open('https://www.linkedin.com/jobs/search/?keywords=react');
    const r = await clickCards(deps, [{ id: IDS[0], title: TITLES[0], pos: 0 }], { paneReads: true, maxClicks: 5, ceiling: false });
    expect(log).toContain(`click:a[href*="${IDS[0]}"]:link0`);
    expect(r.panes.has(IDS[0])).toBe(true);
  });
});

describe('jobs list scrolling', () => {
  const jc = (n: number, idx: number) => ({ title: `T${n}`, company: `C${n}`, href: '', snippet: '', easyApply: false, cardName: `C${n} Dismiss T${n} job`, cardIdx: idx, idHint: '' });
  const snap = (cards: ReturnType<typeof jc>[]): RawSnapshot => ({ url: JOBS_URL, jobCards: cards } as unknown as RawSnapshot);
  function fakeDeps(batches: ReturnType<typeof jc>[][]) {
    let i = 0;
    let scrolls = 0;
    const deps = { rt: { page: () => ({ evaluate: async () => { scrolls++; return 0; }, waitForTimeout: async () => undefined }), snapshot: async () => snap(batches[Math.min(i++, batches.length - 1)]) } };
    return { deps: deps as never, scrolls: () => scrolls };
  }

  it('merges job cards from each scroll by identity, newest marker wins, and stops after two idle rounds', async () => {
    const f = fakeDeps([[jc(1, 0), jc(2, 1), jc(3, 2)], [jc(1, 0), jc(2, 1), jc(3, 2), jc(4, 3), jc(5, 4)], [jc(1, 0), jc(2, 1), jc(3, 2), jc(4, 3), jc(5, 4)], [jc(1, 0), jc(2, 1), jc(3, 2), jc(4, 3), jc(5, 4)], [jc(9, 0)]]);
    const out = await collectByScrolling(f.deps, snap([jc(1, 0)]), 6, 50);
    expect(out.jobCards!.map((c) => c.title)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(f.scrolls()).toBe(4); // 1 round with new cards, then 2 idle rounds ... plus the first merge round
  });

  it('a card that scrolled out of the DOM loses its click marker; a card seen again gets the newest one', async () => {
    const f = fakeDeps([[jc(1, 0), jc(2, 1), jc(3, 2)], [jc(2, 0), jc(3, 1), jc(4, 2)], [jc(2, 0), jc(3, 1), jc(4, 2)], [jc(2, 0), jc(3, 1), jc(4, 2)]]);
    const out = await collectByScrolling(f.deps, snap([jc(1, 0), jc(2, 1)]), 6, 50);
    const byTitle = Object.fromEntries(out.jobCards!.map((c) => [c.title, c.cardIdx]));
    expect(byTitle).toEqual({ T1: undefined, T2: 0, T3: 1, T4: 2 });
  });

  it('stops at the limit, and leaves a snapshot with no job cards or no rounds untouched', async () => {
    const f = fakeDeps([[jc(1, 0), jc(2, 1), jc(3, 2), jc(4, 3)], [jc(1, 0), jc(2, 1), jc(3, 2), jc(4, 3), jc(5, 4), jc(6, 5)]]);
    const out = await collectByScrolling(f.deps, snap([jc(1, 0)]), 6, 4);
    expect(out.jobCards).toHaveLength(4);
    expect(f.scrolls()).toBe(1);
    const first = snap([jc(1, 0)]);
    expect(await collectByScrolling(fakeDeps([[jc(2, 0)]]).deps, first, 0, 50)).toBe(first);
    const plain = { url: JOBS_URL } as unknown as RawSnapshot;
    expect(await collectByScrolling(fakeDeps([[jc(2, 0)]]).deps, plain, 6, 50)).toBe(plain);
  });

  it('searchJobs scrolls the jobs list (rounds from LINKEDIN_JOB_SCROLL_ROUNDS) and 0 turns it off', async () => {
    const count = async (env: NodeJS.ProcessEnv) => {
      let scrolls = 0;
      const s = setup(evaluator((id) => goodPane(id), (src) => { if (src.includes('scrollBy')) scrolls++; return null; }), env);
      await run(s.deps);
      await s.deps.rt.close(); // one LinkedIn session lock per test
      return scrolls;
    };
    expect(await count({ ...LIVE, LINKEDIN_JOB_SCROLL_ROUNDS: '0' })).toBe(0);
    expect(await count({ ...LIVE, LINKEDIN_JOB_SCROLL_ROUNDS: '6' })).toBe(2); // the fake list never grows: two idle rounds
  });

  it('env helpers: defaults, clamps and blank', () => {
    expect(scrollRoundsFor({} as NodeJS.ProcessEnv, 'LINKEDIN_JOB_SCROLL_ROUNDS')).toBe(6);
    expect(scrollRoundsFor({ LINKEDIN_JOB_SCROLL_ROUNDS: '99' } as NodeJS.ProcessEnv, 'LINKEDIN_JOB_SCROLL_ROUNDS')).toBe(12);
    expect(scrollRoundsFor({ LINKEDIN_JOB_SCROLL_ROUNDS: '0' } as NodeJS.ProcessEnv, 'LINKEDIN_JOB_SCROLL_ROUNDS')).toBe(0);
    expect(jobClicksPerSearchFor({} as NodeJS.ProcessEnv)).toBe(25);
    expect(jobClicksPerSearchFor({ LINKEDIN_JOB_CLICKS_PER_SEARCH: '' } as NodeJS.ProcessEnv)).toBe(25);
    expect(jobClicksPerSearchFor({ LINKEDIN_JOB_CLICKS_PER_SEARCH: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(jobClicksPerSearchFor({ LINKEDIN_JOB_CLICKS_PER_SEARCH: '500' } as NodeJS.ProcessEnv)).toBe(60);
    expect(jobClicksPerSearchFor({ LINKEDIN_JOB_CLICKS_PER_SEARCH: 'x' } as NodeJS.ProcessEnv)).toBe(25);
  });
});

describe('pane rules (pure)', () => {
  const read = (o: Partial<PaneRead>): PaneRead => ({ url: urlFor(0), hasAbout: true, paneFound: true, heading: 'Frontend Developer', paneText: '', bodyText: '', more: false, signals: null, ...o });

  it('paneReady: needs the section and the clicked job (url id, or a changed heading when the url has no id)', () => {
    expect(paneReady(read({}), { expectId: IDS[0], prevUrlId: null, prevHeading: '' })).toBe(true);
    expect(paneReady(read({}), { expectId: IDS[1], prevUrlId: null, prevHeading: '' })).toBe(false);
    expect(paneReady(read({ hasAbout: false }), { expectId: IDS[0], prevUrlId: null, prevHeading: '' })).toBe(false);
    expect(paneReady(read({ url: 'https://www.linkedin.com/jobs/search/?keywords=x' }), { expectId: IDS[0], prevUrlId: null, prevHeading: 'Other' })).toBe(true);
    expect(paneReady(read({ url: 'https://www.linkedin.com/jobs/search/?keywords=x' }), { expectId: IDS[0], prevUrlId: null, prevHeading: 'Frontend Developer' })).toBe(false);
    expect(paneReady(read({}), { prevUrlId: IDS[0], prevHeading: 'Frontend Developer' })).toBe(false);
    expect(paneReady(read({}), { prevUrlId: IDS[1], prevHeading: 'Frontend Developer' })).toBe(true);
  });
  it('paneJdText takes the text after "About the job" from the pane, else from the page, and drops a trailing "Show less"', () => {
    expect(paneJdText(read({ paneText: `Title\nAbout the job\n${FULL_JD}\nShow less` }))).toBe(FULL_JD.trim());
    expect(paneJdText(read({ paneFound: false, paneText: '', bodyText: `list\nAbout the job\n${FULL_JD}\nSet alert for similar jobs\nmore` }))).toBe(FULL_JD.trim());
  });
  it('clamp and tail rules', () => {
    expect(looksClamped('abc… more', false)).toBe(true);
    expect(looksClamped('abc ... more', false)).toBe(true);
    expect(looksClamped('abc Show more', false)).toBe(true);
    expect(looksClamped('short text', true)).toBe(true);
    expect(looksClamped('short text', false)).toBe(false);
    expect(looksClamped(FULL_JD, true)).toBe(false);
    expect(hasMoreTail(`${FULL_JD}…more`)).toBe(true);
    expect(hasMoreTail(FULL_JD)).toBe(false);
  });
  it('headingMatches: containment either way, an empty side passes', () => {
    expect(headingMatches('Frontend Developer', 'Frontend Developer')).toBe(true);
    expect(headingMatches('Frontend Developer (React)', 'Frontend Developer')).toBe(true);
    expect(headingMatches('Senior Accountant', 'Frontend Developer')).toBe(false);
    expect(headingMatches('', 'Frontend Developer')).toBe(true);
  });
  it('troubleOf: a warning page without a job section; a normal job page is never trouble', () => {
    expect(troubleOf(read({ hasAbout: false, bodyText: 'Error 429 Too many requests' }))).toBe('rate_limit');
    expect(troubleOf(read({ hasAbout: false, bodyText: 'We noticed unusual activity on your account' }))).toBe('rate_limit');
    expect(troubleOf(read({ hasAbout: false, bodyText: 'Sign in to view more jobs. Join LinkedIn' }))).toBe('login_wall');
    expect(troubleOf(read({ hasAbout: true, bodyText: 'unusual activity captcha in the job text' }))).toBeNull();
    expect(troubleOf(null)).toBeNull();
  });
  it('the in-page scripts are valid JavaScript and the signals collector keeps its document form', () => {
    expect(() => new Function(`return ${PANE_SRC}`)).not.toThrow();
    expect(() => new Function(`return ${PANE_DIAG_SRC}`)).not.toThrow();
    expect(() => new Function(`return ${linkedinSignalsSrc('document.body')}`)).not.toThrow();
    expect(LINKEDIN_SIGNALS_SRC).toContain('const ROOT = document;');
  });
});
