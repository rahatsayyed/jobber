// src/dash/authStore.ts
// Dashboard auth store: allowed account, pending OIDC logins, sessions, audit log.
// Separate sqlite file from the main database. Never stores secrets in clear.
import BetterSqlite3 from 'better-sqlite3';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export type AuthDb = BetterSqlite3.Database;

export interface AllowedAccount { email: string; sub: string | null; setAt: string; pinnedAt: string | null }
export interface PendingLogin {
  stateHash: string; nonce: string; verifier: string; reauth: boolean;
  sessionHash: string | null; createdAt: string; expiresAt: string;
}
export type AuditKind =
  | 'login_ok' | 'login_denied' | 'login_error' | 'sub_pinned' | 'allow_changed' | 'lockout'
  | 'logout' | 'session_expired' | 'reauth_ok' | 'chat_prepare' | 'chat_send' | 'chat_reject';

const NOTE_MAX = 200;
const ID_HINT_MAX = 12;

export function openAuthStore(path: string): AuthDb {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT NOT NULL, sub TEXT, set_at TEXT NOT NULL, pinned_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pending_login (
      state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL,
      reauth INTEGER NOT NULL, session_hash TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      auth_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ip TEXT, ok INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
      ip TEXT, note TEXT, text_hash TEXT, id_hint TEXT
    );
    CREATE TABLE IF NOT EXISTS chat_pending (
      token_hash TEXT PRIMARY KEY, session_hash TEXT, text_hash TEXT, expires_at TEXT, used_at TEXT
    );
  `);
  return db;
}

export function getAllowedAccount(db: AuthDb): AllowedAccount | null {
  const r = db.prepare('SELECT email, sub, set_at, pinned_at FROM allowed_account WHERE id = 1').get() as
    { email: string; sub: string | null; set_at: string; pinned_at: string | null } | undefined;
  return r ? { email: r.email, sub: r.sub, setAt: r.set_at, pinnedAt: r.pinned_at } : null;
}

export function setAllowedEmail(db: AuthDb, email: string, now: Date): void {
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO allowed_account (id, email, sub, set_at, pinned_at) VALUES (1, ?, NULL, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, sub = NULL, set_at = excluded.set_at, pinned_at = NULL`,
    ).run(email, at);
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(at);
  })();
}

export function pinSub(db: AuthDb, sub: string, now: Date): boolean {
  const r = db.prepare('UPDATE allowed_account SET sub = ?, pinned_at = ? WHERE id = 1 AND sub IS NULL')
    .run(sub, now.toISOString());
  return r.changes === 1;
}

const PENDING_CAP = 100;

export function savePendingLogin(db: AuthDb, p: PendingLogin): void {
  db.transaction(() => {
    // prune expired rows (relative to this row's creation time), then keep at most PENDING_CAP live rows
    db.prepare('DELETE FROM pending_login WHERE expires_at <= ?').run(p.createdAt);
    db.prepare(
      `DELETE FROM pending_login WHERE state_hash IN (
         SELECT state_hash FROM pending_login ORDER BY created_at ASC, rowid ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM pending_login) - ?))`,
    ).run(PENDING_CAP - 1);
    db.prepare(
      `INSERT OR REPLACE INTO pending_login (state_hash, nonce, verifier, reauth, session_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.stateHash, p.nonce, p.verifier, p.reauth ? 1 : 0, p.sessionHash, p.createdAt, p.expiresAt);
  })();
}

export function takePendingLogin(db: AuthDb, stateHash: string, now: Date): PendingLogin | null {
  return db.transaction((): PendingLogin | null => {
    const r = db.prepare(
      `SELECT state_hash, nonce, verifier, reauth, session_hash, created_at, expires_at
       FROM pending_login WHERE state_hash = ?`,
    ).get(stateHash) as {
      state_hash: string; nonce: string; verifier: string; reauth: number;
      session_hash: string | null; created_at: string; expires_at: string;
    } | undefined;
    if (!r) return null;
    db.prepare('DELETE FROM pending_login WHERE state_hash = ?').run(stateHash);
    if (Date.parse(r.expires_at) <= now.getTime()) return null;
    return {
      stateHash: r.state_hash, nonce: r.nonce, verifier: r.verifier, reauth: r.reauth === 1,
      sessionHash: r.session_hash, createdAt: r.created_at, expiresAt: r.expires_at,
    };
  })();
}

export function audit(
  db: AuthDb,
  kind: AuditKind,
  detail: { ip?: string; note?: string; textHash?: string; idHint?: string },
  now: Date,
): void {
  db.prepare('INSERT INTO audit_log (at, kind, ip, note, text_hash, id_hint) VALUES (?, ?, ?, ?, ?, ?)').run(
    now.toISOString(), kind, detail.ip ?? null,
    detail.note === undefined ? null : detail.note.slice(0, NOTE_MAX),
    detail.textHash ?? null,
    detail.idHint === undefined ? null : detail.idHint.slice(0, ID_HINT_MAX),
  );
}

export function listAudit(
  db: AuthDb, limit: number, beforeId?: number,
): { id: number; at: string; kind: string; ip: string | null; note: string | null }[] {
  const n = Math.min(200, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1)));
  const sql = beforeId === undefined
    ? 'SELECT id, at, kind, ip, note FROM audit_log ORDER BY id DESC LIMIT ?'
    : 'SELECT id, at, kind, ip, note FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?';
  const stmt = db.prepare(sql);
  return (beforeId === undefined ? stmt.all(n) : stmt.all(beforeId, n)) as
    { id: number; at: string; kind: string; ip: string | null; note: string | null }[];
}
