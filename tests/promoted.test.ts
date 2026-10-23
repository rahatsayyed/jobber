import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { openDb, saveJob, listUnscoredJobs, setJobExcluded, type Job } from '../src/db.js';
import { sqlTime } from '../src/pipelineWork.js';
import { laneOrder, promotedLaneSize, sortPreparePool, PROMOTED_TIEBREAK_BONUS } from '../src/promoted.js';
import { isNaukriPromoted } from '../src/naukri/promoted.js';
import { isWellfoundPromoted } from '../src/wellfound/promoted.js';
import { parseDiscoverCards as parseNaukri, runNaukriDiscover, type DiscoverIo, type NaukriDiscoveryConfig } from '../src/naukri/discover.js';
import { parseDiscoverCards as parseWellfound } from '../src/wellfound/discover.js';
import { parseSearchCards } from '../src/naukri/parse.js';
import { parseNaukriCards } from '../src/sources/naukri.js';
import type { ScreenVerdict } from '../src/safety/screen.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const at = sqlTime(new Date(NOW.getTime() - 3600_000));
type Db = ReturnType<typeof openDb>;

function add(db: Db, id: string, o: { source?: string; promoted?: boolean; priority?: number; score?: number } = {}): void {
  const job: Job = {
    id, source: o.source ?? 'greenhouse', title: `Role ${id}`, company: `Co ${id}`, url: `https://x.test/${id}`,
    apply_url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'Location: Remote\n\nbody',
    ...(o.promoted ? { promoted: true } : {}), ...(o.priority ? { priority: o.priority } : {}),
  };
  saveJob(db, job);
  db.prepare('UPDATE jobs SET created_at = ?, score = ? WHERE id = ?').run(at, o.score ?? null, id);
}
const list = (db: Db, o: Parameters<typeof listUnscoredJobs>[1] = {}) => listUnscoredJobs(db, { now: NOW, ...o });
const flag = (db: Db, id: string) => (db.prepare('SELECT promoted FROM jobs WHERE id = ?').get(id) as { promoted: number | null }).promoted;

describe('promotion markers', () => {
  it.each([isNaukriPromoted, isWellfoundPromoted])('matches badge words, class and aria hints case-insensitively', (fn) => {
    expect(fn({ badges: ['Promoted'] })).toBe(true);
    expect(fn({ badges: ['FEATURED'] })).toBe(true);
    expect(fn({ badges: ['Sponsored'] })).toBe(true);
    expect(fn({ badges: ['Hot Job'] })).toBe(true);
    expect(fn({ badges: ['Premium'] })).toBe(true);
    expect(fn({ attrs: ['jobTuple isPromoted'] })).toBe(true);
    expect(fn({ attrs: ['card-featured_x1'] })).toBe(true);
    expect(fn({ attrs: ['  aria Sponsored listing'] })).toBe(true);
    expect(fn({ attrs: ['hotJob-badge'] })).toBe(true);
  });
  it.each([isNaukriPromoted, isWellfoundPromoted])('does not match plain cards, substrings or junk', (fn) => {
    expect(fn(null)).toBe(false);
    expect(fn(undefined)).toBe(false);
    expect(fn({})).toBe(false);
    expect(fn({ badges: ['Easy Apply', 'Remote'], attrs: ['srp-jobtuple-wrapper', 'job-card'] })).toBe(false);
    expect(fn({ badges: ['Unsponsored'], attrs: ['hotel photo'] })).toBe(false);
    expect(fn({ badges: [42, null, {}], attrs: 'x' as unknown })).toBe(false);
  });
  it('ignores long text (body text is not a badge) and never reads descriptions', () => {
    expect(isNaukriPromoted({ badges: ['This role is featured in our promoted sponsored premium hot job list for all candidates'] })).toBe(false);
    const naukri = parseNaukri([{ title: 'Dev', company: 'A', href: 'https://www.naukri.com/job-listings-dev-a-pune-1-to-3-years-1010260001', snippet: 'A featured, promoted, sponsored premium hot job' }], 10);
    expect(naukri.jobs[0].promoted).toBeUndefined();
    const wf = parseWellfound([{ title: 'Dev', company: 'A', href: 'https://wellfound.com/jobs/1234567-dev', snippet: 'Promoted! Featured! Sponsored!' }], 10);
    expect(wf.jobs[0].promoted).toBeUndefined();
    const nk = parseNaukriCards([{ titleText: 'Dev', companyText: 'A', hrefRaw: 'https://www.naukri.com/job-listings-dev-a-pune-1-to-3-years-1010260001', descriptionText: 'featured promoted' }]);
    expect(nk.jobs[0].promoted).toBeUndefined();
  });
  it('sets promoted on parsed cards from badges or attrs', () => {
    const naukri = parseNaukri([{ title: 'Dev', company: 'A', href: 'https://www.naukri.com/job-listings-dev-a-pune-1-to-3-years-1010260001', snippet: '', badges: ['Promoted'] }], 10);
    expect(naukri.jobs[0].promoted).toBe(true);
    const wf = parseWellfound([{ title: 'Dev', company: 'A', href: 'https://wellfound.com/jobs/1234567-dev', attrs: ['x featured'] }], 10);
    expect(wf.jobs[0].promoted).toBe(true);
    const sr = parseSearchCards([{ title: 'Dev', company: 'A', location: '', href: 'https://www.naukri.com/job-listings-dev-a-pune-1-to-3-years-1010260001', badges: ['Hot Job'] }], 5);
    expect(sr[0].promoted).toBe(true);
    const nk = parseNaukriCards([{ titleText: 'Dev', companyText: 'A', hrefRaw: 'https://www.naukri.com/job-listings-dev-a-pune-1-to-3-years-1010260001', descriptionText: '', attrs: ['sponsored'] }]);
    expect(nk.jobs[0].promoted).toBe(true);
  });
});

describe('promoted column', () => {
  it('exists with default 0 on a new database', () => {
    const db = openDb(':memory:');
    const col = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string; dflt_value: string | null; notnull: number }[]).find((c) => c.name === 'promoted');
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe('0');
    expect(col?.notnull).toBe(0);
    add(db, 'a');
    expect(flag(db, 'a')).toBe(0);
  });
  it('is added by migration to an older database and existing rows read as not promoted', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'promoted-mig-'));
    const file = path.join(dir, 'old.sqlite');
    const first = openDb(file);
    add(first, 'old');
    first.exec('ALTER TABLE jobs DROP COLUMN promoted');
    first.close();
    const raw = new BetterSqlite3(file);
    expect((raw.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).some((c) => c.name === 'promoted')).toBe(false);
    raw.close();
    const db = openDb(file);
    expect(flag(db, 'old') ?? 0).toBe(0);
    add(db, 'new', { promoted: true });
    expect(flag(db, 'new')).toBe(1);
  });
  it('a stored job later seen as promoted gets promoted = 1, and is never un-promoted', () => {
    const db = openDb(':memory:');
    add(db, 'j');
    expect(flag(db, 'j')).toBe(0);
    saveJob(db, { id: 'j', source: 'naukri', title: 'x', company: 'y', url: 'u', apply_url: 'u', description: '', promoted: true });
    expect(flag(db, 'j')).toBe(1);
    saveJob(db, { id: 'j', source: 'naukri', title: 'x', company: 'y', url: 'u', apply_url: 'u', description: '' });
    saveJob(db, { id: 'j', source: 'naukri', title: 'x', company: 'y', url: 'u', apply_url: 'u', description: '', promoted: false });
    expect(flag(db, 'j')).toBe(1);
  });
});

describe('lane and tie-break helpers', () => {
  it('lane is 40 percent of the page, rounded down', () => {
    expect(promotedLaneSize(20)).toBe(8);
    expect(promotedLaneSize(5)).toBe(2);
    expect(promotedLaneSize(1)).toBe(0);
    expect(promotedLaneSize(0)).toBe(0);
  });
  it('laneOrder pulls at most the lane of promoted items forward per page and keeps the rest in order', () => {
    const items: { id: string; promoted?: boolean }[] = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, promoted: true })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })),
    ];
    const out = laneOrder(items, 20);
    expect(out.slice(0, 8).every((x) => x.promoted)).toBe(true);
    expect(out.slice(0, 20).filter((x) => x.promoted)).toHaveLength(8);
    expect(out).toHaveLength(24);
    expect(new Set(out.map((x) => x.id)).size).toBe(24);
    expect(out.slice(8, 20).map((x) => x.id)).toEqual(Array.from({ length: 12 }, (_, i) => `n${i}`));
    expect(out.slice(20).map((x) => x.id)).toEqual(['p8', 'p9', 'p10', 'p11']);
  });
  it('sortPreparePool: promoted wins ties and gets +3 for ordering only, never changing the score', () => {
    expect(PROMOTED_TIEBREAK_BONUS).toBe(3);
    const pool = [
      { id: 'a', score: 80, already_matched: true },
      { id: 'b', score: 80, promoted: true },
      { id: 'c', score: 78, promoted: true },
      { id: 'd', score: 82 },
      { id: 'e', score: 76, promoted: true },
    ];
    const out = sortPreparePool(pool);
    expect(out.map((x) => x.id)).toEqual(['b', 'd', 'c', 'a', 'e']);
    expect(out.find((x) => x.id === 'c')?.score).toBe(78);
    expect(pool.find((x) => x.id === 'b')?.score).toBe(80);
  });
  it('sortPreparePool with equal ordering value: promoted first, then already matched', () => {
    const out = sortPreparePool([{ id: 'm', score: 70, already_matched: true }, { id: 'n', score: 70 }, { id: 'p', score: 67, promoted: true }]);
    expect(out.map((x) => x.id)).toEqual(['p', 'm', 'n']);
  });
});

describe('listUnscoredJobs ordering', () => {
  it('manual priority first, then promoted, then the round-robin by source', () => {
    const db = openDb(':memory:');
    add(db, 'g1', { source: 'greenhouse' });
    add(db, 'l1', { source: 'lever' });
    add(db, 'n1', { source: 'naukri', promoted: true });
    add(db, 'm1', { source: 'manual_url', priority: 1 });
    const ids = list(db, { kind: 'unscored', limit: 20 }).map((r) => r.id);
    expect(ids[0]).toBe('m1');
    expect(ids.indexOf('n1')).toBeLessThan(ids.indexOf('g1'));
    expect(ids.indexOf('n1')).toBeLessThan(ids.indexOf('l1'));
    expect(list(db, { kind: 'unscored', limit: 20 }).find((r) => r.id === 'n1')?.promoted).toBe(true);
    expect(list(db, { kind: 'unscored', limit: 20 }).find((r) => r.id === 'g1')?.promoted).toBeUndefined();
  });
  it('without promoted jobs the order is unchanged (round-robin by source, oldest first)', () => {
    const db = openDb(':memory:');
    add(db, 'g1', { source: 'greenhouse' }); add(db, 'g2', { source: 'greenhouse' }); add(db, 'l1', { source: 'lever' });
    const ids = list(db, { kind: 'unscored', limit: 20 }).map((r) => r.id);
    expect(ids).toEqual(['g1', 'l1', 'g2']);
  });
  it('caps the promoted-first lane at 40 percent of a page of 20 so other sources are not starved', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 30; i++) add(db, `n${String(i).padStart(2, '0')}`, { source: 'naukri', promoted: true });
    for (let i = 0; i < 10; i++) add(db, `g${i}`, { source: 'greenhouse' });
    for (let i = 0; i < 10; i++) add(db, `l${i}`, { source: 'lever' });
    const page1 = list(db, { kind: 'unscored', limit: 20, offset: 0 });
    expect(page1).toHaveLength(20);
    expect(page1.slice(0, 8).every((r) => r.promoted)).toBe(true);
    // the round-robin still runs on the rest of the page: greenhouse and lever both appear
    const rest = page1.slice(8).map((r) => r.source);
    expect(rest).toContain('greenhouse');
    expect(rest).toContain('lever');
    const page2 = list(db, { kind: 'unscored', limit: 20, offset: 20 });
    expect(page2.filter((r) => r.promoted).length).toBeGreaterThan(0);
    const all = [...page1, ...page2].map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
  });
  it('kind all: promoted lane of the whole batch is 40 percent of the fresh slots', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 10; i++) add(db, `n${i}`, { source: 'naukri', promoted: true });
    for (let i = 0; i < 10; i++) add(db, `g${i}`, { source: 'greenhouse' });
    const out = list(db, { kind: 'all', limit: 10 });
    expect(out).toHaveLength(10);
    expect(out.filter((r) => r.promoted)).toHaveLength(4);
  });
  it('matched carry-over: promoted first within a 40 percent lane, then score order', () => {
    const db = openDb(':memory:');
    add(db, 'hi1', { score: 95 }); add(db, 'hi2', { score: 90 }); add(db, 'hi3', { score: 88 });
    add(db, 'p1', { score: 70, promoted: true }); add(db, 'p2', { score: 65, promoted: true }); add(db, 'p3', { score: 64, promoted: true });
    const out = list(db, { kind: 'matched', limit: 5, matchThreshold: 60 }).map((r) => r.id);
    expect(out).toEqual(['p1', 'p2', 'hi1', 'hi2', 'hi3']);
  });
  it('never bypasses the threshold, a veto or a repeat: below-threshold and excluded promoted jobs are not offered as matched', () => {
    const db = openDb(':memory:');
    add(db, 'low', { score: 50, promoted: true });
    add(db, 'vetoed', { score: 90, promoted: true });
    add(db, 'ok', { score: 70, promoted: true });
    setJobExcluded(db, 'vetoed', 'hard stop: test');
    const out = list(db, { kind: 'matched', limit: 10, matchThreshold: 60 }).map((r) => r.id);
    expect(out).toEqual(['ok']);
    // the stored score is untouched by promotion
    expect((db.prepare('SELECT score FROM jobs WHERE id = ?').get('ok') as { score: number }).score).toBe(70);
  });
  it('excluded promoted unscored jobs are not offered either', () => {
    const db = openDb(':memory:');
    add(db, 'x', { source: 'naukri', promoted: true });
    setJobExcluded(db, 'x', 'deal breaker');
    expect(list(db, { kind: 'unscored' }).map((r) => r.id)).toEqual([]);
  });
});

describe('naukri discover', () => {
  const CONFIG: NaukriDiscoveryConfig = { searches: [{ name: 's', query: 'react developer', location: 'india', limit: 20 }] };
  const PASS = async (t: string): Promise<ScreenVerdict> => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' });
  const href = (n: number) => `https://www.naukri.com/job-listings-senior-react-developer-acme-bengaluru-3-to-6-years-10102600${String(n).padStart(4, '0')}`;
  const card = (n: number, over: Record<string, unknown> = {}) => ({ title: `Senior React Developer ${n}`, company: `Acme ${n}`, snippet: '', href: href(n), ...over });
  const io = (cards: unknown[], detailed: string[]): DiscoverIo => ({
    load: async () => 'ok', cards: async () => cards, detail: async (u) => { detailed.push(u); return `description for ${u}`; },
  });
  const deps = (db: Db) => ({ db, env: { JOBBER_DRY_RUN: 'false' } as NodeJS.ProcessEnv, now: () => NOW, screen: PASS }) as any;

  it('opens promoted cards first for the detail quota', async () => {
    const db = openDb(':memory:');
    const detailed: string[] = [];
    const cards = [card(1), card(2), card(3, { badges: ['Promoted'] }), card(4)];
    const r = await runNaukriDiscover({ search: 's', detail_quota: 1 }, io(cards, detailed), deps(db), { config: CONFIG });
    expect(detailed).toEqual([href(3)]);
    expect(r).toMatchObject({ new: 4, details: 1 });
    expect(flag(db, 'naukri:101026000003')).toBe(1);
    expect(flag(db, 'naukri:101026000001')).toBe(0);
  });
  it('keeps the old detail order when nothing is promoted', async () => {
    const db = openDb(':memory:');
    const detailed: string[] = [];
    await runNaukriDiscover({ search: 's', detail_quota: 2 }, io([card(1), card(2), card(3)], detailed), deps(db), { config: CONFIG });
    expect(detailed).toEqual([href(1), href(2)]);
  });
  it('a job stored earlier and seen as promoted later becomes promoted; a later plain sighting does not clear it', async () => {
    const db = openDb(':memory:');
    await runNaukriDiscover({ search: 's', detail_quota: 0 }, io([card(1)], []), deps(db), { config: CONFIG });
    expect(flag(db, 'naukri:101026000001')).toBe(0);
    const r = await runNaukriDiscover({ search: 's', detail_quota: 0 }, io([card(1, { attrs: ['tuple featured'] })], []), deps(db), { config: CONFIG });
    expect(r).toMatchObject({ new: 0, seen: 1 });
    expect(flag(db, 'naukri:101026000001')).toBe(1);
    await runNaukriDiscover({ search: 's', detail_quota: 0 }, io([card(1)], []), deps(db), { config: CONFIG });
    expect(flag(db, 'naukri:101026000001')).toBe(1);
  });
});
