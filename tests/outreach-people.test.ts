// tests/outreach-people.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import {
  activeByCategory,
  activeContactCount,
  companyPaused,
  normalizeCompany,
  normalizeProfileKey,
  selectContacts,
  upsertPerson,
  type Candidate,
} from '../src/outreach/people.js';

describe('normalizers', () => {
  it('treats spelling variants of one company as the same key', () => {
    const keys = ['Lemon.io', 'Lemon.io Inc.', 'lemon io', 'LEMON.IO, Inc'].map(normalizeCompany);
    expect(new Set(keys).size).toBe(1);
  });
  it('drops legal suffixes', () => {
    expect(normalizeCompany('Acme Pvt. Ltd.')).toBe('acme');
  });
  it('normalizes profile urls', () => {
    expect(normalizeProfileKey('https://www.LinkedIn.com/in/Some-Person/?utm=1')).toBe('linkedin.com/in/some-person');
  });
});

describe('upsertPerson and counts', () => {
  const add = (db: ReturnType<typeof openDb>, n: number, company: string, category: 'peer' | 'recruiter') =>
    upsertPerson(db, {
      platform: 'linkedin',
      profileKey: `linkedin.com/in/p${n}`,
      name: `P${n}`,
      company,
      category,
    });

  it('normalizes scheme-less, subdomain, encoded and garbage urls without throwing', () => {
    const want = 'linkedin.com/in/some-person';
    for (const u of [
      'linkedin.com/in/Some-Person',
      'https://uk.linkedin.com/in/some-person/',
      'https://m.linkedin.com/in/Some-Person?x=1#f',
      'https://in.linkedin.com/in/some%2Dperson',
    ])
      expect(normalizeProfileKey(u)).toBe(want);
    expect(() => normalizeProfileKey('http://[bad')).not.toThrow();
    expect(() => normalizeProfileKey('')).not.toThrow();
  });

  it('is idempotent per profile and creates contact_state', () => {
    const db = openDb(':memory:');
    const a = add(db, 1, 'Acme', 'peer');
    const b = add(db, 1, 'Acme Inc', 'peer');
    expect(a).toBe(b);
    const row = db.prepare('SELECT stage FROM contact_state WHERE person_id = ?').get(a) as { stage: string };
    expect(row.stage).toBe('new');
  });

  it('counts only contacted, unclosed people for one company key', () => {
    const db = openDb(':memory:');
    const ids = [add(db, 1, 'Acme', 'peer'), add(db, 2, 'Acme Inc.', 'recruiter'), add(db, 3, 'Acme', 'peer')];
    const set = db.prepare('UPDATE contact_state SET stage = ? WHERE person_id = ?');
    set.run('active', ids[0]);
    set.run('active', ids[1]);
    set.run('closed', ids[2]);
    const key = normalizeCompany('Acme');
    expect(activeContactCount(db, 'linkedin', key, false)).toBe(2);
    expect(activeByCategory(db, 'linkedin', key)).toMatchObject({ peer: 1, recruiter: 1, hiring_manager: 0, connection: 0 });
  });

  it('pauses a company after a positive reply', () => {
    const db = openDb(':memory:');
    const id = add(db, 1, 'Acme', 'peer');
    const key = normalizeCompany('Acme');
    expect(companyPaused(db, 'linkedin', key)).toBe(false);
    db.prepare("UPDATE contact_state SET stage = 'replied_positive' WHERE person_id = ?").run(id);
    expect(companyPaused(db, 'linkedin', key)).toBe(true);
  });
});

describe('selectContacts', () => {
  const c = (id: number, category: Candidate['category'], connected = false): Candidate => ({
    personId: id,
    category,
    connected,
  });
  const none = { recruiter: 0, hiring_manager: 0, peer: 0, connection: 0 };

  it('keeps the mix at the limit with many connected peers, connected first', () => {
    const pool = [c(1, 'peer', true), c(2, 'peer', true), c(3, 'peer', true), c(4, 'peer', true), c(5, 'recruiter'), c(6, 'hiring_manager')];
    const out = selectContacts(pool, none, 5, 0);
    const cats = out.map((x) => x.category);
    expect(out).toHaveLength(5);
    expect(cats).toContain('recruiter');
    expect(cats).toContain('hiring_manager');
    expect(cats.filter((x) => x === 'peer').length).toBeGreaterThanOrEqual(2);
    const flags = out.map((x) => x.connected);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
  });

  it('returns nothing when the company is full', () => {
    expect(selectContacts([c(1, 'peer')], none, 5, 5)).toEqual([]);
  });

  it('puts already-connected people first', () => {
    const out = selectContacts([c(1, 'peer'), c(2, 'peer', true), c(3, 'recruiter')], none, 2, 0);
    expect(out[0].personId).toBe(2);
  });

  it('builds the first five as a mix, not all recruiters', () => {
    const pool = [
      c(1, 'recruiter'),
      c(2, 'recruiter'),
      c(3, 'recruiter'),
      c(4, 'hiring_manager'),
      c(5, 'peer'),
      c(6, 'peer'),
      c(7, 'peer'),
    ];
    const cats = selectContacts(pool, none, 5, 0).map((x) => x.category);
    expect(cats.filter((x) => x === 'recruiter').length).toBeGreaterThanOrEqual(1);
    expect(cats.filter((x) => x === 'hiring_manager').length).toBe(1);
    expect(cats.filter((x) => x === 'peer').length).toBeGreaterThanOrEqual(2);
    expect(cats).toHaveLength(5);
  });

  it('counts people already active toward the mix and the limit', () => {
    const out = selectContacts(
      [c(1, 'recruiter'), c(2, 'peer'), c(3, 'peer')],
      { recruiter: 1, hiring_manager: 0, peer: 0, connection: 0 },
      3,
      2,
    );
    expect(out).toHaveLength(1);
  });
});

describe('upsertPerson conflict handling', () => {
  const base = { platform: 'linkedin', profileKey: 'linkedin.com/in/x', company: 'Acme', category: 'peer' as const };
  const row = (db: ReturnType<typeof openDb>, id: number) =>
    db.prepare('SELECT name, headline, category FROM people WHERE id = ?').get(id) as {
      name: string | null;
      headline: string | null;
      category: string;
    };

  it('keeps an existing name and headline when the new input has none', () => {
    const db = openDb(':memory:');
    const id = upsertPerson(db, { ...base, name: 'Ada', headline: 'Eng' });
    upsertPerson(db, base);
    expect(row(db, id)).toMatchObject({ name: 'Ada', headline: 'Eng' });
    upsertPerson(db, { ...base, name: 'Ada L', headline: 'Staff' });
    expect(row(db, id)).toMatchObject({ name: 'Ada L', headline: 'Staff' });
  });

  it('takes the new category while stage is new', () => {
    const db = openDb(':memory:');
    const id = upsertPerson(db, base);
    upsertPerson(db, { ...base, category: 'recruiter' });
    expect(row(db, id).category).toBe('recruiter');
  });

  it('keeps the category once the stage is past new', () => {
    const db = openDb(':memory:');
    const id = upsertPerson(db, base);
    db.prepare("UPDATE contact_state SET stage = 'active' WHERE person_id = ?").run(id);
    upsertPerson(db, { ...base, category: 'recruiter' });
    expect(row(db, id).category).toBe('peer');
  });
});
