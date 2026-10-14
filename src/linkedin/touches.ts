// Idempotent touch ledger over the 6A outreach tables. Only writer of `touches` for the typed tools.
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export interface PersonRow {
  id: number; profile_key: string; name: string | null; company: string;
  company_key: string; category: string; stage: string; paused_reason: string | null;
}

export function personByProfileKey(db: Db, profileKey: string): PersonRow | null {
  const row = db
    .prepare(
      `SELECT p.id, p.profile_key, p.name, p.company, p.company_key, p.category,
              COALESCE(c.stage, 'new') AS stage, c.paused_reason AS paused_reason
       FROM people p LEFT JOIN contact_state c ON c.person_id = p.id
       WHERE p.platform = 'linkedin' AND p.profile_key = ?`,
    )
    .get(profileKey) as PersonRow | undefined;
  return row ?? null;
}

export type TouchStatus = 'sending' | 'sent' | 'failed' | 'unconfirmed' | 'dry_run' | 'refused';

export function idempotencyKey(kind: string, profileKey: string, text: string): string {
  return `li:${kind}:${profileKey}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

export type Reserve =
  | { ok: true; touchId: number }
  | { ok: false; reason: 'already_sent' | 'in_progress' | 'duplicate_kind'; touchId: number };

export function reserveTouch(
  db: Db,
  a: { personId: number; kind: string; jobId?: string | null; body: string; key: string; now: Date; dryRun: boolean },
): Reserve {
  const run = db.transaction((): Reserve => {
    const at = a.now.toISOString();
    if (a.dryRun) {
      const dryKey = `${a.key}:dry`;
      const ex = db.prepare('SELECT id FROM touches WHERE idempotency_key = ?').get(dryKey) as { id: number } | undefined;
      if (ex) return { ok: true, touchId: ex.id };
      const r = db
        .prepare(
          `INSERT INTO touches (person_id, job_id, kind, body, idempotency_key, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'dry_run', ?)`,
        )
        .run(a.personId, a.jobId ?? null, a.kind, a.body, dryKey, at);
      return { ok: true, touchId: Number(r.lastInsertRowid) };
    }
    const same = db.prepare('SELECT id, status FROM touches WHERE idempotency_key = ?').get(a.key) as
      | { id: number; status: string }
      | undefined;
    if (same) {
      if (same.status === 'sent') return { ok: false, reason: 'already_sent', touchId: same.id };
      if (same.status === 'sending' || same.status === 'unconfirmed') {
        return { ok: false, reason: 'in_progress', touchId: same.id };
      }
      // failed/refused: reuse the row for a retry (key is UNIQUE)
      db.prepare(`UPDATE touches SET status = 'sending', body = ?, created_at = ?, sent_at = NULL WHERE id = ?`)
        .run(a.body, at, same.id);
      return { ok: true, touchId: same.id };
    }
    if (a.kind === 'connect') {
      const other = db
        .prepare(
          `SELECT id FROM touches WHERE person_id = ? AND kind = 'connect'
           AND status IN ('sent','sending','unconfirmed') LIMIT 1`,
        )
        .get(a.personId) as { id: number } | undefined;
      if (other) return { ok: false, reason: 'duplicate_kind', touchId: other.id };
    }
    const r = db
      .prepare(
        `INSERT INTO touches (person_id, job_id, kind, body, idempotency_key, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'sending', ?)`,
      )
      .run(a.personId, a.jobId ?? null, a.kind, a.body, a.key, at);
    return { ok: true, touchId: Number(r.lastInsertRowid) };
  });
  return run.immediate();
}

export function finishTouch(db: Db, touchId: number, status: TouchStatus, now: Date): void {
  db.prepare('UPDATE touches SET status = ?, sent_at = ? WHERE id = ?').run(
    status,
    status === 'sent' ? now.toISOString() : null,
    touchId,
  );
}

export function pauseContact(db: Db, personId: number, reason: string, now: Date): void {
  db.prepare('INSERT OR IGNORE INTO contact_state (person_id) VALUES (?)').run(personId);
  db.prepare('UPDATE contact_state SET paused_reason = ?, updated_at = ? WHERE person_id = ?').run(
    reason, now.toISOString(), personId,
  );
}
