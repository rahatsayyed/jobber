import { describe, it, expect } from 'vitest';
import { AGGREGATOR_SOURCES, BOARD_SOURCES, dropBoardDuplicatesDetailed } from '../src/sources/boards/index.js';
import { companyKey, titleIdentityKey } from '../src/reposts.js';
import type { Job } from '../src/db.js';

const job = (id: string, source: string, company = 'Acme', title = 'Frontend Engineer'): Job => ({ id, source, title, company, url: 'u', apply_url: 'u', description: 'd' });
const row = (id: string, source: string | null, company = 'Acme', title = 'Frontend Engineer') => ({ id, source, company_key: companyKey(company), title_key: titleIdentityKey(title) });

describe('source sets', () => {
  it('company vendors are board sources, aggregators are their own set, and the two never overlap', () => {
    expect([...BOARD_SOURCES].sort()).toEqual(['ashby', 'greenhouse', 'lever', 'personio', 'recruitee', 'smartrecruiters', 'workable', 'workday']);
    expect([...AGGREGATOR_SOURCES].sort()).toEqual(['hackernews', 'himalayas', 'weworkremotely']);
    for (const s of AGGREGATOR_SOURCES) expect(BOARD_SOURCES.has(s)).toBe(false);
  });
});

describe('dropBoardDuplicatesDetailed with aggregators', () => {
  it('a company-board job wins over an aggregator copy of the same company and title, whatever the batch order', () => {
    const agg = job('himalayas:aaaa', 'himalayas');
    const gh = job('gh:acme:1', 'greenhouse');
    for (const jobs of [[agg, gh], [gh, agg]]) {
      const r = dropBoardDuplicatesDetailed(jobs, []);
      expect(r.kept.map((j) => j.id)).toEqual(['gh:acme:1']);
      expect(r.dropped.map((j) => j.id)).toEqual(['himalayas:aaaa']);
    }
  });
  it('every aggregator loses to every company-board vendor, whatever the batch order', () => {
    const boards: Array<[string, string]> = [
      ['greenhouse', 'gh:acme:1'], ['lever', 'lever:acme:1'], ['ashby', 'ashby:acme:1'], ['workable', 'workable:acme:1'],
      ['recruitee', 'recruitee:acme:1'], ['personio', 'personio:acme:1'], ['workday', 'wd:acme:ext:1'], ['smartrecruiters', 'sr:acme:1'],
    ];
    for (const agg of ['hackernews', 'himalayas', 'weworkremotely']) {
      for (const [src, id] of boards) {
        const a = job(`${agg}:1`, agg);
        const b = job(id, src);
        for (const jobs of [[a, b], [b, a]]) {
          const r = dropBoardDuplicatesDetailed(jobs, []);
          expect(r.kept.map((j) => j.id)).toEqual([id]);
          expect(r.dropped.map((j) => j.id)).toEqual([`${agg}:1`]);
        }
      }
    }
  });
  it('every aggregator loses to a non-board source copy, whatever the batch order', () => {
    for (const agg of ['hackernews', 'himalayas', 'weworkremotely']) {
      for (const src of ['linkedin', 'adzuna', 'remotive']) {
        const a = job(`${agg}:1`, agg);
        const b = job(`${src}:1`, src);
        for (const jobs of [[a, b], [b, a]]) {
          const r = dropBoardDuplicatesDetailed(jobs, []);
          expect(r.kept.map((j) => j.id)).toEqual([`${src}:1`]);
          expect(r.dropped.map((j) => j.id)).toEqual([`${agg}:1`]);
        }
      }
    }
  });
  it('a non-board source (LinkedIn) still beats both, and keeps itself', () => {
    const r = dropBoardDuplicatesDetailed([job('wd:acme:ext:1', 'workday'), job('hn:1', 'hackernews'), job('linkedin:1', 'linkedin')], []);
    expect(r.kept.map((j) => j.id)).toEqual(['linkedin:1']);
    expect(r.dropped.map((j) => j.id).sort()).toEqual(['hn:1', 'wd:acme:ext:1']);
  });
  it('two aggregators with the same posting keep the first; the same aggregator keeps both (same group, like one board)', () => {
    const r = dropBoardDuplicatesDetailed([job('hn:1', 'hackernews'), job('wwr:1', 'weworkremotely'), job('hn:2', 'hackernews')], []);
    expect(r.kept.map((j) => j.id)).toEqual(['hn:1', 'hn:2']);
    expect(r.dropped.map((j) => j.id)).toEqual(['wwr:1']);
  });
  it('recent rows count: an aggregator job duplicating a stored board row is dropped; a board job duplicating a stored aggregator row is dropped too', () => {
    expect(dropBoardDuplicatesDetailed([job('hn:9', 'hackernews')], [row('gh:acme:1', 'greenhouse')]).dropped.map((j) => j.id)).toEqual(['hn:9']);
    expect(dropBoardDuplicatesDetailed([job('gh:acme:2', 'greenhouse')], [row('himalayas:z', 'himalayas')]).dropped.map((j) => j.id)).toEqual(['gh:acme:2']);
    expect(dropBoardDuplicatesDetailed([job('hn:9', 'hackernews')], [row('hn:1', 'hackernews')]).kept.map((j) => j.id)).toEqual(['hn:9']);
  });
  it('different roles or companies are untouched, and the Workday board group is vendor+tenant+site (two postings of one role on one tenant are kept)', () => {
    const r = dropBoardDuplicatesDetailed([
      job('wd:acme:ext:aaa', 'workday'), job('wd:acme:ext:bbb', 'workday'), job('wd:other:ext:ccc', 'workday', 'Acme', 'Frontend Engineer'), job('hn:1', 'hackernews', 'Globex'),
    ], []);
    expect(r.kept.map((j) => j.id)).toEqual(['wd:acme:ext:aaa', 'wd:acme:ext:bbb', 'hn:1']);
    expect(r.dropped.map((j) => j.id)).toEqual(['wd:other:ext:ccc']);
  });
});
