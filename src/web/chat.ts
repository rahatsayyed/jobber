// src/web/chat.ts
// Two-step confirmed chat send. A prepare call stores sha256(token) bound to the session id hash and the sha256 of
// the exact text; a confirm call consumes it once. The token and the raw text are never stored.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthDb } from '../dash/authStore.js';
import { cleanText } from '../dash/clean.js';
import { validateSendText } from '../platform/tmux.js';

export const STATUS_COMMANDS = ['limits', 'working', 'health'] as const;

const TOKEN_TTL_SEC = 60;

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function validateChatText(text: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'text must be a string' };
  try {
    validateSendText(text);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'invalid text' };
  }
  if (text.trimStart().startsWith('/')) {
    const word = text.trim().slice(1);
    if (!(STATUS_COMMANDS as readonly string[]).includes(word)) {
      return { ok: false, reason: 'only bare status commands may start with /' };
    }
  }
  return { ok: true, text };
}

export function prepareSend(
  auth: AuthDb, sessionIdHash: string, text: string, now: Date,
): { token: string; expiresInSec: 60; preview: string } {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(now.getTime() + TOKEN_TTL_SEC * 1000).toISOString();
  auth.transaction(() => {
    auth.prepare('DELETE FROM chat_pending WHERE expires_at <= ?').run(now.toISOString());
    auth.prepare(
      'INSERT INTO chat_pending (token_hash, session_hash, text_hash, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)',
    ).run(sha256Hex(token), sessionIdHash, sha256Hex(text), expires);
  })();
  return { token, expiresInSec: 60, preview: cleanText(text, 2000) };
}

export type ConfirmResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'mismatch' | 'session' };

export function confirmSend(
  auth: AuthDb, sessionIdHash: string, token: string, text: string, now: Date,
): ConfirmResult {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return { ok: false, reason: 'unknown' };
  return auth.transaction((): ConfirmResult => {
    const r = auth.prepare(
      'SELECT session_hash, text_hash, expires_at, used_at FROM chat_pending WHERE token_hash = ?',
    ).get(sha256Hex(token)) as
      { session_hash: string; text_hash: string; expires_at: string; used_at: string | null } | undefined;
    if (!r) return { ok: false, reason: 'unknown' };
    if (!safeEqual(r.session_hash, sessionIdHash)) return { ok: false, reason: 'session' };
    if (r.used_at) return { ok: false, reason: 'used' };
    if (Date.parse(r.expires_at) <= now.getTime()) return { ok: false, reason: 'expired' };
    // the row is consumed on any further attempt, a mismatch included: a token is good for one try
    auth.prepare('UPDATE chat_pending SET used_at = ? WHERE token_hash = ?').run(now.toISOString(), sha256Hex(token));
    if (!safeEqual(r.text_hash, sha256Hex(text))) return { ok: false, reason: 'mismatch' };
    return { ok: true };
  })();
}
