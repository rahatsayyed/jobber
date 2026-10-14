import { describe, it, expect } from 'vitest';
import { companyKey, repostCount, titleIdentityKey, type PostingRow } from '../src/reposts.js';
import { backfillJobKeys, openDb, repostCountForJob, saveJob } from '../src/db.js';

const p = (id: string, first_seen: string, over: Partial<PostingRow> = {}): PostingRow =>
  ({ id, source: 'remotive', company: 'Acme Inc.', title: 'Senior Backend Engineer, Payments', url: `https://x.com/${id}`, first_seen, ...over });

describe('identity keys', () => {
  it('folds legal suffixes and case', () => {
    expect(companyKey('Acme Inc.')).toBe(companyKey('ACME'));
    expect(companyKey('Acme Technologies Pvt. Ltd.')).toBe('acme technologies');
    expect(companyKey('Café Labs GmbH')).toBe('cafe labs');
  });
  it('strips legal words only as trailing suffixes', () => {
    expect(companyKey('SA Power Networks')).toBe('sa power networks');
    expect(companyKey('The Company')).toBe('the company');
    expect(companyKey('Co-op Group Ltd')).toBe('co op group');
    expect(companyKey('Acme Co.')).toBe('acme');
    expect(companyKey('Private Eye Ltd')).toBe('private eye');
    expect(companyKey('')).toBe('');
  });
  it('title key ignores order/punctuation but not extra words', () => {
    expect(titleIdentityKey('Senior Backend Engineer, Payments')).toBe(titleIdentityKey('payments - senior backend engineer'));
    expect(titleIdentityKey('Senior Backend Engineer, Payments (Bangalore)')).not.toBe(titleIdentityKey('Senior Backend Engineer, Payments'));
  });
});

describe('repostCount', () => {
  const t = p('t', '2026-10-01 10:00:00');
  it('same-day different URLs are sibling reqs, not reposts', () => {
    expect(repostCount(t, [p('a', '2026-10-01 18:00:00')])).toBe(0);
  });
  it('a distinct URL 1-90 days apart counts; 91 does not', () => {
    expect(repostCount(t, [p('a', '2026-09-30 10:00:00'), p('b', '2026-07-03 10:00:00'), p('c', '2026-07-02 09:00:00')])).toBe(2);
  });
  it('same URL, other source, other company or invalid date never count', () => {
    expect(repostCount(t, [
      p('a', '2026-09-20 10:00:00', { url: t.url }),
      p('b', '2026-09-20 10:00:00', { source: 'adzuna' }),
      p('c', '2026-09-20 10:00:00', { company: 'Globex' }),
      p('d', '2023-02-29 10:00:00'),
    ])).toBe(0);
  });
  it('the same URL seen twice counts once', () => {
    expect(repostCount(t, [p('a', '2026-09-20 10:00:00', { url: 'https://x.com/z' }), p('b', '2026-09-10 10:00:00', { url: 'https://x.com/z' })])).toBe(1);
  });
});

describe('repostCountForJob (db)', () => {
  it('uses stored keys and created_at', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'old', source: 'remotive', title: 'React Developer', company: 'Acme Ltd', url: 'https://r.com/1', apply_url: 'u', description: 'd' });
    saveJob(db, { id: 'new', source: 'remotive', title: 'developer react', company: 'ACME', url: 'https://r.com/2', apply_url: 'u', description: 'd' });
    db.prepare("UPDATE jobs SET created_at = '2026-09-01 10:00:00' WHERE id = 'old'").run();
    db.prepare("UPDATE jobs SET created_at = '2026-10-01 10:00:00' WHERE id = 'new'").run();
    expect(repostCountForJob(db, 'new')).toBe(1);
    expect(repostCountForJob(db, 'missing')).toBe(0);
  });
  it('backfills keys for rows saved before the columns existed', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('x', 's', 'React Dev', 'Acme Inc', 'u')").run();
    expect(backfillJobKeys(db)).toBe(1);
    expect(db.prepare("SELECT title_key, company_key FROM jobs WHERE id = 'x'").get()).toEqual({ title_key: 'dev react', company_key: 'acme' });
  });
});
