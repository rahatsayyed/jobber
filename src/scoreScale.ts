// file: src/scoreScale.ts
// The match score scale migration (owner decision 2026-11-06). Until then `jobs.score` held the career-ops Global score x 20 (0..100);
// now it holds the Global itself on the 1..5 scale, one decimal, and MATCH_THRESHOLD is on the same scale (default 4.0).
//
// openDb runs `ensureMatchScale` once per database:
//   - the marker is `PRAGMA user_version` >= MATCH_SCALE_USER_VERSION (and a `meta` row `match_scale=5`, written together, last);
//   - when the marker is absent and the db holds scored rows, the db is first copied (VACUUM INTO, a consistent snapshot) to
//     `<db file>.pre-scale-<timestamp>` next to it, mode 0600. If the copy fails the migration is refused (throws), nothing changes;
//   - then, in ONE `BEGIN IMMEDIATE` transaction (two processes starting together serialize; the marker is re-checked inside):
//       (a) `jobs.grandfathered = 1` for jobs already matched under the old rule (a row that is not career_ops_v1 and scored at least the old
//           legacy line 60), and for every job that already has an outreach_queue row (queued or prepared). Grandfathered jobs stay eligible
//           ("matched") without a re-evaluation; a fresh match save clears the flag (src/db.ts saveMatchResultsChecked);
//       (b) every non-null `jobs.score` becomes round(score / 20, 1), for career_ops_v1, rubric_v2, legacy and unlabelled rows alike
//           (the `rubric` label in score_dims stays, dimension values are NOT rescaled, relative order is kept);
//       (c) the marker is written last.
//   - a half-migrated db (marker absent but every stored score already <= 5) only gets the marker and the grandfather pass is skipped.
// A db whose user_version is NEWER than this code knows is refused with a clear error (an old process must never write 0..100 scores into a
// 1..5 db, and an old process cannot be stopped from reading, so the owner restarts the whole stack after the update).
import { chmodSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { RUBRIC_TAG } from './matchRubric.js';

/** user_version of a db whose scores are on the 1..5 scale. Bump when a later change needs a new marker. */
export const MATCH_SCALE_USER_VERSION = 2;
/** Old rubric_v2 / legacy rows were passed at this stored (0..100) score before the migration. */
const OLD_LEGACY_LINE = 60;

export interface ScaleMigrationResult {
  /** 'migrated' = rows converted; 'marked' = only the marker was written (empty or half-migrated db); 'current' = nothing to do. */
  action: 'migrated' | 'marked' | 'current';
  converted: number;
  grandfathered: number;
  backup: string | null;
}

/** Refuse (throw) when the db was written by a newer version of the code. Called first thing in openDb. */
export function assertDbNotNewer(db: BetterSqlite3.Database): void {
  const v = db.pragma('user_version', { simple: true }) as number;
  if (v > MATCH_SCALE_USER_VERSION) {
    throw new Error(
      `database user_version ${v} is newer than this code understands (${MATCH_SCALE_USER_VERSION}). Update the code (git pull) and restart; do not open this database with an old version.`,
    );
  }
}

const isMigrated = (db: BetterSqlite3.Database): boolean => (db.pragma('user_version', { simple: true }) as number) >= MATCH_SCALE_USER_VERSION;

const sqlQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function backupPath(dbFile: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return join(dirname(dbFile), `${basename(dbFile)}.pre-scale-${stamp}`);
}

function existingBackup(dbFile: string): string | null {
  const prefix = `${basename(dbFile)}.pre-scale-`;
  try {
    const hit = readdirSync(dirname(dbFile)).find((f) => f.startsWith(prefix) && statSync(join(dirname(dbFile), f)).isFile());
    return hit ? join(dirname(dbFile), hit) : null;
  } catch { return null; }
}

/** The score migration. Idempotent, safe when two processes open the same db together. Throws (and changes nothing) if the backup fails. */
export function ensureMatchScale(
  db: BetterSqlite3.Database,
  dbFile: string,
  /** Test hook: how the file-level copy is made (default: VACUUM INTO, a consistent snapshot). */
  copy: (db: BetterSqlite3.Database, target: string) => void = (d, target) => { d.exec(`VACUUM INTO ${sqlQuote(target)}`); },
): ScaleMigrationResult {
  if (isMigrated(db)) return { action: 'current', converted: 0, grandfathered: 0, backup: null };
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const stats = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(score), 0) AS top FROM jobs WHERE score IS NOT NULL').get() as { n: number; top: number };
  // File-level copy first, only for a real file that holds scores to convert (an empty or already-small db has nothing to protect).
  let backup: string | null = null;
  let createdBackup = false;
  const needsConvert = stats.n > 0 && stats.top > 5;
  if (needsConvert && dbFile && dbFile !== ':memory:' && existsSync(dbFile)) {
    backup = existingBackup(dbFile);
    if (!backup) {
      const target = backupPath(dbFile);
      try {
        copy(db, target);
        chmodSync(target, 0o600);
      } catch (e) {
        throw new Error(`score scale migration refused: could not copy the database to ${target} first (${(e as Error).message}). Nothing was changed.`);
      }
      backup = target;
      createdBackup = true;
    }
  }
  const run = db.transaction((): ScaleMigrationResult => {
    // Re-check inside the write lock: another process may have finished while we copied.
    if (isMigrated(db)) return { action: 'current', converted: 0, grandfathered: 0, backup };
    const now = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(score), 0) AS top FROM jobs WHERE score IS NOT NULL').get() as { n: number; top: number };
    let converted = 0;
    let grandfathered = 0;
    let action: ScaleMigrationResult['action'] = 'marked';
    if (now.n > 0 && now.top > 5) {
      // (a) grandfather first: it reads the OLD 0..100 scores.
      const hasQueue = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outreach_queue'").get() !== undefined;
      grandfathered = db.prepare(
        `UPDATE jobs SET grandfathered = 1 WHERE score IS NOT NULL AND (
           (score >= ${OLD_LEGACY_LINE} AND (score_dims IS NULL OR instr(score_dims, '"rubric":"${RUBRIC_TAG}"') = 0))
           ${hasQueue ? 'OR id IN (SELECT job_id FROM outreach_queue)' : ''})`,
      ).run().changes;
      // (b) convert every stored score: round(score / 20, 1). An expired row (0) stays 0.
      converted = db.prepare('UPDATE jobs SET score = ROUND(score / 20.0, 1) WHERE score IS NOT NULL').run().changes;
      action = 'migrated';
    }
    // (c) the marker, last.
    db.prepare("INSERT INTO meta (key, value) VALUES ('match_scale', '5') ON CONFLICT(key) DO UPDATE SET value = '5'").run();
    db.pragma(`user_version = ${MATCH_SCALE_USER_VERSION}`);
    return { action, converted, grandfathered, backup };
  });
  const result = run.immediate();
  // We made a backup but another process migrated first: that copy holds the already converted data, so it is not a pre-scale copy.
  if (createdBackup && result.action === 'current' && backup) {
    try { unlinkSync(backup); } catch { /* best effort */ }
    return { ...result, backup: null };
  }
  return result;
}
