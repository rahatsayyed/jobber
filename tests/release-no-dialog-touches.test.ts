import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { releaseNoDialogTouches } from '../scripts/release-no-dialog-touches.js';

const NOW = new Date('2026-10-25T08:00:00.000Z');
const AT = '2026-10-24T08:00:00.000Z';

function setup() {
  const db = openDb(':memory:');
  const mk = (k: string) => upsertPerson(db, { platform: 'linkedin', profileKey: `linkedin.com/in/${k}`, company: 'Acme', category: 'recruiter' });
  const touch = (id: number, at = AT) =>
    db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, created_at) VALUES (?, 'connect', ?, 'unconfirmed', ?)").run(id, `k${id}`, at);
  return { db, mk, touch };
}
const statusOf = (db: ReturnType<typeof openDb>, id: number) =>
  (db.prepare('SELECT status FROM touches WHERE person_id = ?').get(id) as { status: string }).status;

describe('release-no-dialog-touches', () => {
  it('converts only unconfirmed connects with no connection row and no ceiling usage; idempotent; dry writes nothing', () => {
    const { db, mk, touch } = setup();
    const a = mk('a'); const b = mk('b'); const c = mk('c');
    touch(a, '2026-10-23T08:00:00.000Z'); touch(b, '2026-10-23T08:00:00.000Z'); touch(c);
    db.prepare("INSERT INTO connections (profile_url, status) VALUES ('https://www.linkedin.com/in/b/', 'sent')").run();
    db.prepare("INSERT INTO rate_events (key, at) VALUES ('linkedin_invite', ?)").run('2026-10-24T08:00:30.000Z');
    expect(releaseNoDialogTouches(db, { dry: true, now: NOW })).toEqual({ candidates: 1, released: 0, kept: 2 });
    expect(statusOf(db, a)).toBe('unconfirmed');
    expect(releaseNoDialogTouches(db, { now: NOW })).toEqual({ candidates: 1, released: 1, kept: 2 });
    expect(statusOf(db, a)).toBe('no_dialog');
    expect(statusOf(db, b)).toBe('unconfirmed');
    expect(statusOf(db, c)).toBe('unconfirmed');
    expect(releaseNoDialogTouches(db, { now: NOW })).toEqual({ candidates: 0, released: 0, kept: 2 });
  });
});
