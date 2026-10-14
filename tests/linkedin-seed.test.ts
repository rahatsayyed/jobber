import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { seedPerson } from '../scripts/linkedin-seed-person.js';

let db: ReturnType<typeof openDb>;
const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('seedPerson', () => {
  const ok = { url: 'https://www.linkedin.com/in/Jane-Doe/?utm=1', name: 'Jane Doe', company: 'Acme Ltd', category: 'peer' };

  it('seeds one linkedin person with a normalized key and a contact_state row', () => {
    const r = seedPerson(db, ok);
    expect(r.ok).toBe(true);
    const row = db.prepare('SELECT * FROM people').get() as Record<string, unknown>;
    expect(count('people')).toBe(1);
    expect(row.platform).toBe('linkedin');
    expect(row.profile_key).toBe('linkedin.com/in/jane-doe');
    expect(row.name).toBe('Jane Doe');
    expect(row.category).toBe('peer');
    expect(count('contact_state')).toBe(1);
    if (r.ok) expect(r.person_id).toBe(row.id);
  });

  it('is idempotent', () => {
    const a = seedPerson(db, ok);
    const b = seedPerson(db, ok);
    expect(count('people')).toBe(1);
    expect(count('contact_state')).toBe(1);
    expect(a).toEqual(b);
  });

  it.each([
    ['non-profile url', { ...ok, url: 'https://www.linkedin.com/company/acme' }],
    ['non-linkedin url', { ...ok, url: 'https://example.com/in/jane' }],
    ['blocked path (not a profile)', { ...ok, url: 'https://www.linkedin.com/premium/in/x' }],
    ['empty name', { ...ok, name: '  ' }],
    ['empty company', { ...ok, company: '' }],
    ['invalid category', { ...ok, category: 'friend' }],
  ])('rejects %s with no row', (_n, args) => {
    const r = seedPerson(db, args);
    expect(r.ok).toBe(false);
    expect(count('people')).toBe(0);
    expect(count('contact_state')).toBe(0);
  });
});
