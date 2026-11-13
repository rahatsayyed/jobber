import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { applyCounterUsed, atsApplyUsed, consumeApplyCounter, seedApplyCounter } from '../src/lib/applyCounters.js';
import { checkAndIncrement } from '../src/lib/rateLimit.js';
import { recordEvent } from '../src/outreach/limits.js';

const dbs: ReturnType<typeof openDb>[] = [];
const fresh = () => { const d = openDb(':memory:'); dbs.push(d); return d; };
afterEach(() => { while (dbs.length) dbs.pop()!.close(); });

const row = (db: ReturnType<typeof openDb>, key: string) =>
  db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?").get(key) as { count: number } | undefined;

describe('per-platform apply counters', () => {
  it('Naukri and Wellfound applies do not consume LinkedIn room, and the reverse', () => {
    const db = fresh();
    seedApplyCounter(db, 'naukri');
    for (let i = 0; i < 4; i++) expect(consumeApplyCounter(db, 'naukri', 30)).toBe(true);
    seedApplyCounter(db, 'wellfound');
    expect(consumeApplyCounter(db, 'wellfound', 20)).toBe(true);
    expect(applyCounterUsed(db, 'linkedin')).toBe(0);
    // LinkedIn has its full room of 5 although Naukri used 4.
    seedApplyCounter(db, 'linkedin');
    for (let i = 0; i < 5; i++) expect(consumeApplyCounter(db, 'linkedin', 5)).toBe(true);
    expect(consumeApplyCounter(db, 'linkedin', 5)).toBe(false);
    expect(applyCounterUsed(db, 'naukri')).toBe(4);
    expect(applyCounterUsed(db, 'wellfound')).toBe(1);
    expect(atsApplyUsed(db)).toBe(0);
  });

  it('each platform cap is enforced on its own counter and a refusal does not increment', () => {
    const db = fresh();
    for (const p of ['linkedin', 'naukri', 'wellfound'] as const) {
      seedApplyCounter(db, p);
      expect(consumeApplyCounter(db, p, 2)).toBe(true);
      expect(consumeApplyCounter(db, p, 2)).toBe(true);
      expect(consumeApplyCounter(db, p, 2)).toBe(false);
      expect(applyCounterUsed(db, p)).toBe(2);
    }
  });

  it('the legacy easy_apply row is the ATS counter only and never charges a platform', () => {
    const db = fresh();
    expect(checkAndIncrement(db, 'easy_apply', 5)).toBe(true);
    expect(checkAndIncrement(db, 'easy_apply', 5)).toBe(true);
    expect(checkAndIncrement(db, 'easy_apply', 5)).toBe(true); // legacy row = 3, as on the deploy day
    expect(atsApplyUsed(db)).toBe(3);
    for (const p of ['linkedin', 'naukri', 'wellfound'] as const) expect(applyCounterUsed(db, p)).toBe(0);
    seedApplyCounter(db, 'linkedin');
    expect(row(db, 'easy_apply_linkedin')).toEqual({ count: 0 });
    expect(row(db, 'easy_apply')).toEqual({ count: 3 });
  });

  it('first day after deploy: a missing row is seeded from today\'s ceiling events, so no cap can be exceeded', () => {
    const db = fresh();
    const at = new Date();
    for (let i = 0; i < 2; i++) recordEvent(db, 'naukri_apply', at);
    recordEvent(db, 'linkedin_easy_apply', at);
    // An event from an earlier day is not counted.
    recordEvent(db, 'naukri_apply', new Date(Date.now() - 3 * 24 * 3600 * 1000));
    expect(applyCounterUsed(db, 'naukri')).toBe(2); // read-only: still no row
    expect(row(db, 'easy_apply_naukri')).toBeUndefined();
    seedApplyCounter(db, 'naukri');
    expect(row(db, 'easy_apply_naukri')).toEqual({ count: 2 });
    seedApplyCounter(db, 'naukri'); // idempotent, never touches an existing row
    expect(row(db, 'easy_apply_naukri')).toEqual({ count: 2 });
    expect(consumeApplyCounter(db, 'naukri', 2)).toBe(false);
    expect(applyCounterUsed(db, 'linkedin')).toBe(1);
    expect(applyCounterUsed(db, 'wellfound')).toBe(0);
  });
});
