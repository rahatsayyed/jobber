import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { checkAndIncrement } from '../src/lib/rateLimit.js';
import type Database from 'better-sqlite3';

describe('rateLimit', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('should allow two increments up to limit, then block the third', () => {
    const limit = 2;

    // First call: should return true and increment
    const first = checkAndIncrement(db, 'easy_apply', limit);
    expect(first).toBe(true);

    // Second call: should return true and increment
    const second = checkAndIncrement(db, 'easy_apply', limit);
    expect(second).toBe(true);

    // Third call: should return false and NOT increment (count stays at 2)
    const third = checkAndIncrement(db, 'easy_apply', limit);
    expect(third).toBe(false);

    // Verify the count is still 2 in the database
    const row = db.prepare(
      "SELECT count FROM daily_counters WHERE day = date('now') AND key = ?"
    ).get('easy_apply') as any;
    expect(row?.count).toBe(2);
  });

  it('should reset counter for different keys', () => {
    const limit = 2;

    // Increment easy_apply twice
    checkAndIncrement(db, 'easy_apply', limit);
    checkAndIncrement(db, 'easy_apply', limit);

    // Third for easy_apply should fail
    expect(checkAndIncrement(db, 'easy_apply', limit)).toBe(false);

    // But easy_apply_2 should start fresh
    expect(checkAndIncrement(db, 'connect', limit)).toBe(true);
  });

  it('should handle different days independently', () => {
    const limit = 1;

    // Simulate today
    const today = db.prepare("SELECT date('now') as today").get() as any;
    const todayDate = today.today;

    // Use up today's quota
    expect(checkAndIncrement(db, 'easy_apply', limit)).toBe(true);
    expect(checkAndIncrement(db, 'easy_apply', limit)).toBe(false);

    // Manually insert a counter for yesterday (simulating a past day)
    const yesterday = db.prepare(
      "SELECT date('now', '-1 day') as yesterday"
    ).get() as any;
    const yesterdayDate = yesterday.yesterday;

    db.prepare(
      'INSERT INTO daily_counters (day, key, count) VALUES (?, ?, ?)'
    ).run(yesterdayDate, 'easy_apply', 0);

    // Getting yesterday's counter should work independently
    const row = db.prepare(
      'SELECT count FROM daily_counters WHERE day = ? AND key = ?'
    ).get(yesterdayDate, 'easy_apply') as any;
    expect(row?.count).toBe(0);
  });
});
