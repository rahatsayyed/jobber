// Idempotent touch ledger over the 6A outreach tables. Only writer of `touches` for the typed tools.
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export interface PersonRow {
  id: number; profile_key: string; name: string | null; company: string;
  company_key: string; category: string; stage: string; paused_reason: string | null;
  headline: string | null; employer_match: number | null;
}

export function personByProfileKey(db: Db, profileKey: string): PersonRow | null {
  const row = db
    .prepare(
      `SELECT p.id, p.profile_key, p.name, p.company, p.company_key, p.category, p.headline, p.employer_match,
              COALESCE(c.stage, 'new') AS stage, c.paused_reason AS paused_reason
       FROM people p LEFT JOIN contact_state c ON c.person_id = p.id
       WHERE p.platform = 'linkedin' AND p.profile_key = ?`,
    )
    .get(profileKey) as PersonRow | undefined;
  return row ?? null;
}

export type TouchStatus = 'sending' | 'sent' | 'failed' | 'unconfirmed' | 'dry_run' | 'refused' | 'no_dialog';

/** At most this many no_dialog releases per person inside the window, then arm refuses with retry_limit. */
export const NO_DIALOG_MAX_ATTEMPTS = 2;
export const NO_DIALOG_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** no_dialog releases of a person's connect touches inside the 7-day window. */
export function noDialogAttempts(db: Db, personId: number, now: Date): number {
  const since = new Date(now.getTime() - NO_DIALOG_WINDOW_MS).toISOString();
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(no_dialog_count), 0) AS n FROM touches
        WHERE person_id = ? AND kind = 'connect' AND status = 'no_dialog' AND released_at >= ?`,
    )
    .get(personId, since) as { n: number };
  return r.n;
}

/**
 * Engine-only release for a connect whose Send click provably never happened (Connect clicked, no invite
 * dialog). Terminal and retryable, never counted as sent or unconfirmed. Only a 'sending' connect row moves;
 * nothing else (sent, unconfirmed, dry_run) is touched. Not exposed through any tool.
 */
export function releaseNoDialog(db: Db, touchId: number, now: Date): void {
  const at = now.toISOString();
  const since = new Date(now.getTime() - NO_DIALOG_WINDOW_MS).toISOString();
  db.prepare(
    `UPDATE touches
        SET status = 'no_dialog', sent_at = NULL,
            no_dialog_count = CASE WHEN released_at IS NOT NULL AND released_at >= ? THEN no_dialog_count + 1 ELSE 1 END,
            released_at = ?
      WHERE id = ? AND status = 'sending' AND kind = 'connect'`,
  ).run(since, at, touchId);
}

export function idempotencyKey(kind: string, profileKey: string, text: string): string {
  return `li:${kind}:${profileKey}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

export type Reserve =
  | { ok: true; touchId: number }
  | { ok: false; reason: 'already_sent' | 'in_progress' | 'duplicate_kind' | 'retry_limit'; touchId: number };

/**
 * Callers must record 'unconfirmed' (not 'failed') via finishTouch for any attempt that may have
 * gone out (D9), since only failed/refused rows can be retried. Must NOT be called inside an outer
 * transaction (it opens its own IMMEDIATE one).
 */
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
    }
    if (a.kind === 'connect') {
      if (noDialogAttempts(db, a.personId, a.now) >= NO_DIALOG_MAX_ATTEMPTS) {
        return { ok: false, reason: 'retry_limit', touchId: same?.id ?? -1 };
      }
      const other = db
        .prepare(
          `SELECT id FROM touches WHERE person_id = ? AND kind = 'connect' AND id != ?
           AND status IN ('sent','sending','unconfirmed') LIMIT 1`,
        )
        .get(a.personId, same?.id ?? -1) as { id: number } | undefined;
      if (other) return { ok: false, reason: 'duplicate_kind', touchId: other.id };
    }
    if (a.kind !== 'connect') {
      // Message kinds share one family: a retry with different wording after an unresolved
      // (sending/unconfirmed) message must never double-send. A SENT message does not block.
      const open = db
        .prepare(
          `SELECT id FROM touches WHERE person_id = ? AND kind != 'connect' AND id != ?
           AND status IN ('sending','unconfirmed') LIMIT 1`,
        )
        .get(a.personId, same?.id ?? -1) as { id: number } | undefined;
      if (open) return { ok: false, reason: 'in_progress', touchId: open.id };
    }
    if (same) {
      // failed/refused: reuse the row for a retry (key is UNIQUE); created_at is kept
      db.prepare(`UPDATE touches SET status = 'sending', body = ?, sent_at = NULL WHERE id = ?`).run(a.body, same.id);
      return { ok: true, touchId: same.id };
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

/** Only transitions a row currently 'sending'; any other row is left untouched (silent no-op, so
 * 'sent' is never downgraded and dry_run rows stay dry_run). */
export function finishTouch(db: Db, touchId: number, status: TouchStatus, now: Date): void {
  db.prepare("UPDATE touches SET status = ?, sent_at = ? WHERE id = ? AND status = 'sending'").run(
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
