// src/outreach/dueTouches.ts
// Shared "which follow-ups are due" computation. Nothing stores a next_due_at for typed LinkedIn
// touches, so due work is derived: people + contact_state + sent touches of the current cycle ->
// ContactSnapshot -> planNextTouch. Used by scheduler countDue and (later) listDueTouches.
import type BetterSqlite3 from 'better-sqlite3';
import { planNextTouch, type Category, type ContactSnapshot, type TouchKind, type Variant } from './cadence.js';
import { companyPaused, normalizeProfileKey } from './people.js';
import type { Tuning } from './tuning.js';

type Db = BetterSqlite3.Database;

export interface DueTouch {
  person_id: number;
  platform: string;
  company_key: string;
  category: Category;
  kind: TouchKind;
  due_at: string;
}

interface PersonRow {
  person_id: number;
  platform: string;
  profile_key: string;
  company_key: string;
  category: Category;
  stage: string;
  variant: Variant | null;
  cycle_started_at: string | null;
  cooldown_until: string | null;
  paused_reason: string | null;
}

// Touch statuses that are finished; anything else (queued, sending, unconfirmed, unknown) is in flight.
export const TERMINAL = ['sent', 'failed', 'refused', 'dry_run', 'skipped', 'cancelled', 'no_dialog'];

const toDate = (s: string | null): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Normalized profile keys the legacy `connections` table records as messaged or connected. */
export function loadConnectedKeys(db: Db): Set<string> {
  const keys = new Set<string>();
  try {
    const cr = db
      .prepare("SELECT profile_url FROM connections WHERE status IN ('messaged', 'connected') AND profile_url IS NOT NULL")
      .all() as { profile_url: string }[];
    for (const c of cr) keys.add(normalizeProfileKey(c.profile_url));
  } catch {
    // legacy table missing: no signal
  }
  return keys;
}

/**
 * Follow-ups due at `now`, oldest due first. Only people in stage 'active' are considered; a
 * 'connect' step is new outreach, not a follow-up, so it is never returned.
 *
 * Acceptance signal ("connected"), fail closed: a sent invite alone is NOT acceptance. A person is
 * connected only if (a) a non-connect touch (a message) was sent in the cycle, which LinkedIn only
 * permits to a 1st-degree connection, or (b) the legacy `connections` table has a row for the same
 * normalized profile URL with status 'messaged' or 'connected'. Nothing else proves acceptance.
 *
 * Fail closed on data: an unparseable cooldown_until, cycle_started_at or touch sent_at skips the
 * person. A person with any in-flight touch (status not terminal) is skipped, not due.
 */
export function dueTouchesFor(
  db: Db,
  now: Date,
  tuning: Pick<Tuning, 'cadenceGapsDays'>,
  opts: { platform?: string; limit?: number } = {},
): DueTouch[] {
  const rows = db
    .prepare(
      `SELECT p.id AS person_id, p.platform, p.profile_key, p.company_key, p.category, s.stage, s.variant,
              s.cycle_started_at, s.cooldown_until, s.paused_reason
         FROM people p JOIN contact_state s ON s.person_id = p.id
        WHERE s.stage = 'active' ${opts.platform ? 'AND p.platform = ?' : ''}
        ORDER BY p.id`,
    )
    .all(...(opts.platform ? [opts.platform] : [])) as PersonRow[];

  const touchStmt = db.prepare(
    `SELECT kind, sent_at FROM touches
      WHERE person_id = ? AND status = 'sent' AND sent_at IS NOT NULL AND (? IS NULL OR sent_at >= ?)
      ORDER BY sent_at ASC, id ASC`,
  );

  const connectedKeys = loadConnectedKeys(db);
  const pendingStmt = db.prepare(
    `SELECT 1 AS hit FROM touches WHERE person_id = ? AND status NOT IN (${TERMINAL.map(() => '?').join(',')}) LIMIT 1`,
  );

  const out: DueTouch[] = [];
  for (const r of rows) {
    if (r.paused_reason) continue;
    if (r.cooldown_until && !toDate(r.cooldown_until)) continue;
    if (r.cycle_started_at && !toDate(r.cycle_started_at)) continue;
    const cooldown = toDate(r.cooldown_until);
    if (cooldown && cooldown > now) continue;
    if (pendingStmt.get(r.person_id, ...TERMINAL)) continue;
    if (companyPaused(db, r.platform, r.company_key)) continue;

    const touches = touchStmt.all(r.person_id, r.cycle_started_at, r.cycle_started_at) as {
      kind: TouchKind;
      sent_at: string;
    }[];
    if (touches.some((t) => !toDate(t.sent_at))) continue;
    const connects = touches.filter((t) => t.kind === 'connect');
    const messages = touches
      .filter((t) => t.kind !== 'connect')
      .map((t) => ({ kind: t.kind, sentAt: new Date(t.sent_at) }));
    const connectSentAt = connects.length ? new Date(connects[connects.length - 1].sent_at) : null;
    const snapshot: ContactSnapshot = {
      category: r.category,
      variant: r.variant,
      connected: messages.length > 0 || connectedKeys.has(normalizeProfileKey(r.profile_key)),
      connectedAt: null,
      connectSentAt,
      messages,
      replied: false,
      pausedReason: null,
      cooldownUntil: null,
    };
    const next = planNextTouch(snapshot, now, tuning.cadenceGapsDays);
    if (!next || next.kind === 'connect' || next.dueAt > now) continue;
    out.push({
      person_id: r.person_id,
      platform: r.platform,
      company_key: r.company_key,
      category: r.category,
      kind: next.kind,
      due_at: next.dueAt.toISOString(),
    });
  }
  out.sort((a, b) => a.due_at.localeCompare(b.due_at) || a.person_id - b.person_id);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}
