import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { dueTouchesFor } from '../src/outreach/dueTouches.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const day = 24 * 3600 * 1000;

function person(db: ReturnType<typeof openDb>, key: string, platform = 'linkedin') {
  const id = upsertPerson(db, { platform, profileKey: `${platform}/${key}`, company: `Co ${key}`, category: 'recruiter' });
  db.prepare("UPDATE contact_state SET stage = 'active', cycle_started_at = ? WHERE person_id = ?")
    .run(new Date(NOW.getTime() - 30 * day).toISOString(), id);
  return id;
}
function touch(db: ReturnType<typeof openDb>, id: number, kind: string, agoDays: number, status = 'sent') {
  db.prepare('INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?,?,?,?,?)')
    .run(id, kind, `${id}-${kind}-${agoDays}-${status}`, status, new Date(NOW.getTime() - agoDays * day).toISOString());
}

describe('dueTouchesFor', () => {
  it('returns the next message kind once the gap passed', () => {
    const db = openDb(':memory:');
    const a = person(db, 'a');
    touch(db, a, 'connect', 10);
    const r = dueTouchesFor(db, NOW, TUNING_DEFAULTS);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ person_id: a, kind: 'role_ask', platform: 'linkedin' });
  });
  it('uses the next step after a sent message and honours the gap', () => {
    const db = openDb(':memory:');
    const a = person(db, 'a');
    touch(db, a, 'connect', 20);
    touch(db, a, 'role_ask', 2); // next gap is 4 days
    expect(dueTouchesFor(db, NOW, TUNING_DEFAULTS)).toHaveLength(0);
    touch(db, a, 'followup', 0.1, 'queued'); // queued touches are ignored
    expect(dueTouchesFor(db, NOW, TUNING_DEFAULTS)).toHaveLength(0);
  });
  it('filters by platform and limit', () => {
    const db = openDb(':memory:');
    for (const [k, p] of [['a', 'linkedin'], ['b', 'linkedin'], ['c', 'naukri']] as const) {
      touch(db, person(db, k, p), 'connect', 10);
    }
    expect(dueTouchesFor(db, NOW, TUNING_DEFAULTS, { platform: 'naukri' })).toHaveLength(1);
    expect(dueTouchesFor(db, NOW, TUNING_DEFAULTS, { limit: 2 })).toHaveLength(2);
  });
  it('ignores touches from before the cycle start', () => {
    const db = openDb(':memory:');
    const a = person(db, 'a');
    touch(db, a, 'connect', 100); // before cycle_started_at (30 days ago)
    expect(dueTouchesFor(db, NOW, TUNING_DEFAULTS)).toHaveLength(0);
  });
});
