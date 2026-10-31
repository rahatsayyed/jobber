import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { dueTouchesFor } from '../src/outreach/dueTouches.js';
import { finishTouch, finishTouchSentNoNote } from '../src/linkedin/touches.js';
import { markConnectionAccepted } from '../src/linkedin/acceptCheck.js';

const T0 = new Date('2026-10-27T10:00:00.000Z');
const LATER = new Date('2026-10-31T10:00:00.000Z');
const URL_ = 'https://www.linkedin.com/in/sam-recruiter-123/';

function setup() {
  const db = openDb(':memory:');
  migrateOutreachTables(db);
  const pid = Number(
    db.prepare(
      "INSERT INTO people (platform, profile_key, name, company, company_key, category) VALUES ('linkedin', 'linkedin.com/in/sam-recruiter-123', 'Sam', 'Globex', 'globex', 'recruiter')",
    ).run().lastInsertRowid,
  );
  db.prepare('INSERT INTO contact_state (person_id) VALUES (?)').run(pid);
  let n = 0;
  const touch = (kind: string) =>
    Number(
      db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status) VALUES (?, ?, ?, 'sending')").run(pid, kind, `k-${kind}-${n++}`).lastInsertRowid,
    );
  const stage = () => (db.prepare('SELECT stage FROM contact_state WHERE person_id = ?').get(pid) as { stage: string }).stage;
  return { db, pid, touch, stage };
}

describe('LinkedIn contact activation', () => {
  it('a sent invite moves the person from new to active; a failed one does not', () => {
    const s = setup();
    finishTouch(s.db, s.touch('connect'), 'failed', T0);
    expect(s.stage()).toBe('new');
    finishTouch(s.db, s.touch('connect'), 'sent', T0);
    expect(s.stage()).toBe('active');
  });

  it('a note-less direct send also activates', () => {
    const s = setup();
    finishTouchSentNoNote(s.db, s.touch('connect'), T0);
    expect(s.stage()).toBe('active');
  });

  it('an accepted invite makes the first DM due (role_ask for a recruiter)', () => {
    const s = setup();
    finishTouch(s.db, s.touch('connect'), 'sent', T0);
    s.db.prepare("INSERT INTO connections (job_id, company, profile_url, note, status, sent_at) VALUES ('j1', 'Globex', ?, '', 'sent', ?)").run(URL_, T0.toISOString());
    expect(dueTouchesFor(s.db, LATER, { cadenceGapsDays: [3, 4, 5, 7, 10] }, { platform: 'linkedin' })).toEqual([]);
    markConnectionAccepted(s.db, URL_, LATER);
    const due = dueTouchesFor(s.db, LATER, { cadenceGapsDays: [3, 4, 5, 7, 10] }, { platform: 'linkedin' });
    expect(due.map((d) => d.kind)).toEqual(['role_ask']);
  });
});
