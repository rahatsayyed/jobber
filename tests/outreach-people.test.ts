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
