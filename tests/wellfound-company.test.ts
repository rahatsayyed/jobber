// Wellfound company extraction, saved descriptions, the no-company flag and the backfill script. Fixtures are raw
// page-script outputs (shapes UNVERIFIED live); nothing here touches a browser or the network.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { companyFromJsonLd, companyFromSlug, companyFromTitle, companyLinkOf, pickCompany } from '../src/wellfound/company.js';
import { parseDiscoverCards, runWellfoundDiscover, type DiscoverIo, type WellfoundDiscoveryConfig } from '../src/wellfound/discover.js';
import { isWellfoundPromoted } from '../src/wellfound/promoted.js';
import { applyVetoes } from '../src/vetoes.js';
import { jobFactsFromDb } from '../src/gateFacts.js';
import { openDb, saveJob } from '../src/db.js';
import { fixWellfoundJobs, BAD_EXTRACTION_STATUS } from '../scripts/fix-wellfound-jobs.js';
import type { ScreenVerdict } from '../src/safety/screen.js';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/wellfound/${n}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-10-16T10:00:00Z');
const LIVE = { JOBBER_DRY_RUN: 'false' } as NodeJS.ProcessEnv;
const PASS = async (t: string): Promise<ScreenVerdict> => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' });
const CONFIG: WellfoundDiscoveryConfig = { searches: [{ name: 's', role: 'full-stack-engineer', location: 'india', remote: true, limit: 20 }] };

describe('company extraction order', () => {
  it('anchor text, else slug name, else title pattern, else JSON-LD, else none', () => {
    expect(pickCompany({ links: [{ href: 'https://wellfound.com/company/acme-robotics', text: 'Acme Robotics' }] })).toMatchObject({ name: 'Acme Robotics', from: 'link_text', link: 'https://wellfound.com/company/acme-robotics' });
    expect(pickCompany({ links: [{ href: 'https://wellfound.com/company/northwind-labs', text: '' }] })).toMatchObject({ name: 'Northwind Labs', from: 'link_slug' });
    expect(pickCompany({ pageTitle: 'Full Stack Engineer at Acme Robotics | Wellfound' })).toMatchObject({ name: 'Acme Robotics', from: 'title' });
    expect(pickCompany({ jsonld: fx('detail-page.json').jsonld })).toMatchObject({ name: 'Acme Robotics Inc', from: 'jsonld' });
    expect(pickCompany({ links: [{ href: 'https://evil.example/company/acme', text: 'Evil' }] })).toEqual({ name: '', from: 'none' });
    expect(pickCompany(null)).toEqual({ name: '', from: 'none' });
  });
  it('rejects chrome texts and id-only slugs', () => {
    expect(pickCompany({ links: [{ href: 'https://wellfound.com/company/acme', text: 'View company' }] })).toMatchObject({ name: 'Acme', from: 'link_slug' });
    expect(companyFromSlug('12345')).toBe('');
    expect(companyLinkOf('https://wellfound.com/jobs/1234567-x')).toBeNull();
    expect(companyFromTitle('Senior Engineer at Foo at Bar Inc - Wellfound')).toBe('Bar Inc');
    expect(companyFromTitle('Jobs | Wellfound')).toBe('');
    expect(companyFromJsonLd(['not json', '{"@graph":[{"hiringOrganization":"Zed Co"}]}'])).toBe('Zed Co');
  });
});

describe('fixture cards', () => {
  it('every card with a company anchor or a /company/<slug>/jobs/ url gets a company; a bare card stays empty', () => {
    const p = parseDiscoverCards(fx('search-cards.json'), 20);
    expect(p.jobs.map((j) => j.company)).toEqual(['Acme Robotics', 'Northwind Labs', 'Globex', '']);
  });
  it('promoted: only the badge and attribute channels count, never the snippet or a near-miss word', () => {
    const p = parseDiscoverCards(fx('search-cards.json'), 20);
    // card 1: "Promoted" badge; card 3: "Featured" badge; card 2 has only Remote / Full time; the snippet of card 3 also says "unsponsored".
    expect(p.jobs.map((j) => !!j.promoted)).toEqual([true, false, true, false]);
    expect(isWellfoundPromoted({ badges: ['Remote', 'Full time'], attrs: ['unsponsored'] })).toBe(false);
    expect(isWellfoundPromoted({ badges: [], attrs: [] })).toBe(false);
  });
});

describe('discover: detail page is the description and company source', () => {
  const deps = () => ({ db: openDb(':memory:'), env: LIVE, now: () => NOW, screen: PASS }) as any;
  const mk = (cards: unknown[], detail: (u: string) => unknown) => {
    const calls: string[] = [];
    const io: DiscoverIo = { load: async () => 'ok', cards: async () => cards, detail: async (u) => { calls.push(u); return detail(u) as any; } };
    return { io, calls };
  };

  it('reads the detail page even for cards with a snippet, saves up to 8000 chars and the detail company, promoted first', async () => {
    const long = 'React TypeScript requirements. '.repeat(400);
    const cards = [
      { title: 'A', href: 'https://wellfound.com/jobs/3187101-a', links: [], snippet: 'snippet a', badges: [], attrs: [] },
      { title: 'B', href: 'https://wellfound.com/jobs/3187102-b', links: [], snippet: 'snippet b', badges: ['Promoted'], attrs: [] },
    ];
    const f = mk(cards, (u) => (u.includes('3187102') ? { ...fx('detail-page.json'), description: long } : 'Plain detail text for job a that is longer than the snippet'));
    const d = deps();
    const r = await runWellfoundDiscover({ search: 's', detail_quota: 5 }, f.io, d, { config: CONFIG });
    expect(f.calls[0]).toContain('3187102');
    expect(r).toMatchObject({ status: 'ok', new: 2, details: 2, company_missing: 1 });
    const b = d.db.prepare("SELECT company, description FROM jobs WHERE id = 'wellfound:3187102'").get();
    expect(b.company).toBe('Acme Robotics');
    expect(b.description.length).toBeGreaterThan(7000);
    expect(b.description.length).toBeLessThanOrEqual(8000);
    expect(d.db.prepare("SELECT description FROM jobs WHERE id = 'wellfound:3187101'").get().description).toMatch(/^Plain detail text/);
  });

  it('a long description is screened in chunks (nothing past the classifier window goes unscreened)', async () => {
    const seen: number[] = [];
    const d = { ...deps(), screen: async (t: string) => { seen.push(t.length); return PASS(t); } };
    const f = mk([{ title: 'A', href: 'https://wellfound.com/jobs/3187101-a', links: [], snippet: '', badges: [], attrs: [] }], () => 'x '.repeat(4000));
    await runWellfoundDiscover({ search: 's' }, f.io, d, { config: CONFIG });
    expect(Math.max(...seen)).toBeLessThanOrEqual(6000);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('no company anywhere: saved, counted in company_missing', async () => {
    const f = mk(fx('search-cards.json').slice(3), () => ({ description: 'Node role' }));
    expect(await runWellfoundDiscover({ search: 's' }, f.io, deps(), { config: CONFIG })).toMatchObject({ new: 1, company_missing: 1 });
  });

  it('quota is respected', async () => {
    const f = mk(fx('search-cards.json'), () => 'detail');
    const r = await runWellfoundDiscover({ search: 's', detail_quota: 1 }, f.io, deps(), { config: CONFIG });
    expect(r.details).toBe(1);
  });

  it('a bad_extraction row is repaired in place when a company is read, and left alone otherwise', async () => {
    const d = deps();
    saveJob(d.db, { id: 'wellfound:3187001', source: 'wellfound', title: 'Full Stack Engineer', company: '', url: 'u', apply_url: 'u', description: 'old' });
    saveJob(d.db, { id: 'wellfound:3187004', source: 'wellfound', title: 'Node Engineer', company: '', url: 'u', apply_url: 'u', description: 'old' });
    fixWellfoundJobs(d.db);
    const f = mk(fx('search-cards.json'), () => 'new detail');
    const r = await runWellfoundDiscover({ search: 's' }, f.io, d, { config: CONFIG });
    expect(r.repaired).toBe(1);
    expect(d.db.prepare("SELECT company, status, excluded_reason FROM jobs WHERE id = 'wellfound:3187001'").get()).toEqual({ company: 'Acme Robotics', status: null, excluded_reason: null });
    expect(d.db.prepare("SELECT status FROM jobs WHERE id = 'wellfound:3187004'").get()).toEqual({ status: BAD_EXTRACTION_STATUS });
  });
});

describe('veto flag for company-less wellfound jobs', () => {
  const m = { job_id: 'wellfound:1', score: 80, reasons: [], missing_keywords: [] } as any;
  const facts = (company: string) => ({ facts: { source: 'wellfound', company }, now: NOW });
  it('flags a missing company, excludes it only when the role is missing too, passes a named company', () => {
    expect(applyVetoes(m, { title: 'React Dev', description: 'x' }, [], facts('')).flags).toContain('no company identified');
    expect(applyVetoes(m, { title: '', description: 'x' }, [], facts(''))).toMatchObject({ excluded: true, reason: 'wellfound job has no identifiable company or role' });
    expect(applyVetoes(m, { title: 'React Dev', description: 'x' }, [], facts('Acme')).flags).not.toContain('no company identified');
  });
  it('facts carry the company for wellfound rows', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'wellfound:1', source: 'wellfound', title: 't', company: '', url: 'u', apply_url: 'u', description: 'd' });
    expect(jobFactsFromDb(db, 'wellfound:1').company).toBe('');
  });
});

describe('scripts/fix-wellfound-jobs', () => {
  it('marks empty-company wellfound rows once, skips queued outreach, honours --dry, leaves others', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'wellfound:1', source: 'wellfound', title: 'a', company: '', url: 'u', apply_url: 'u', description: 'd' });
    saveJob(db, { id: 'wellfound:2', source: 'wellfound', title: 'b', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
    saveJob(db, { id: 'g1', source: 'greenhouse', title: 'c', company: '', url: 'u', apply_url: 'u', description: 'd' });
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('wellfound:1', 'queued')").run();
    expect(fixWellfoundJobs(db, { dry: true })).toMatchObject({ matched: 1, marked: 0 });
    expect(db.prepare("SELECT status FROM jobs WHERE id = 'wellfound:1'").get()).toEqual({ status: null });
    expect(fixWellfoundJobs(db)).toMatchObject({ matched: 1, marked: 1, queue_skipped: 1 });
    expect(fixWellfoundJobs(db)).toMatchObject({ matched: 1, marked: 0, queue_skipped: 0 });
    const rows = db.prepare('SELECT id, status, excluded_reason FROM jobs ORDER BY id').all() as any[];
    expect(rows.find((r) => r.id === 'wellfound:1')).toMatchObject({ status: 'bad_extraction' });
    expect(rows.find((r) => r.id === 'wellfound:1').excluded_reason).toMatch(/^bad extraction/);
    expect(rows.find((r) => r.id === 'wellfound:2').status).toBeNull();
    expect(rows.find((r) => r.id === 'g1').status).toBeNull();
    expect(db.prepare("SELECT status FROM outreach_queue WHERE job_id = 'wellfound:1'").get()).toEqual({ status: 'skipped' });
  });
});
