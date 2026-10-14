import BetterSqlite3 from 'better-sqlite3';

/**
 * Atomically check if a daily rate limit has been reached and increment the counter.
 * Returns true if the increment succeeded, false if the limit was already reached.
 *
 * @param db Database connection
 * @param key The rate limit key (e.g., 'easy_apply', 'connect')
 * @param limit The maximum number of actions allowed per day
 * @returns true if counter was incremented, false if limit reached
 */
export function checkAndIncrement(
  db: BetterSqlite3.Database,
  key: string,
  limit: number
): boolean {
  const today = db.prepare("SELECT date('now') as today").get() as any;
  const day = today.today;

  // Ensure row exists for today (INSERT OR IGNORE so it doesn't error if already exists)
  db.prepare('INSERT OR IGNORE INTO daily_counters (day, key, count) VALUES (?, ?, ?)').run(
    day,
    key,
    0
  );

  // Atomically update and increment if count < limit
  const result = db.prepare(
    'UPDATE daily_counters SET count = count + 1 WHERE day = ? AND key = ? AND count < ?'
  ).run(day, key, limit);

  // changes property indicates how many rows were affected
  return result.changes > 0;
}
