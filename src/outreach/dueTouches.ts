// src/outreach/dueTouches.ts
// Shared "which follow-ups are due" computation. Nothing stores a next_due_at for typed LinkedIn
// touches, so due work is derived: people + contact_state + sent touches of the current cycle ->
// ContactSnapshot -> planNextTouch. Used by scheduler countDue and (later) listDueTouches.
import type BetterSqlite3 from 'better-sqlite3';
import { planNextTouch, type Category, type ContactSnapshot, type TouchKind, type Variant } from './cadence.js';
import { companyPaused } from './people.js';
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
  company_key: string;
  category: Category;
  stage: string;
  variant: Variant | null;
  cycle_started_at: string | null;
  cooldown_until: string | null;
  paused_reason: string | null;
}

const toDate = (s: string | null): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Follow-ups due at `now`, oldest due first. Only people in stage 'active' are considered; a
 * 'connect' step is new outreach, not a follow-up, so it is never returned. "Connected" is
 * inferred (no connection column exists): a sent connect touch in the cycle, or any sent
 * non-connect touch in the cycle.
 */
export function dueTouchesFor(
  db: Db,
  now: Date,
  tuning: Pick<Tuning, 'cadenceGapsDays'>,
  opts: { platform?: string; limit?: number } = {},
): DueTouch[] {
  const rows = db
    .prepare(
      `SELECT p.id AS person_id, p.platform, p.company_key, p.category, s.stage, s.variant,
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

  const out: DueTouch[] = [];
  for (const r of rows) {
    if (r.paused_reason) continue;
    const cooldown = toDate(r.cooldown_until);
    if (cooldown && cooldown > now) continue;
    if (companyPaused(db, r.platform, r.company_key)) continue;

    const touches = touchStmt.all(r.person_id, r.cycle_started_at, r.cycle_started_at) as {
      kind: TouchKind;
      sent_at: string;
    }[];
    const connects = touches.filter((t) => t.kind === 'connect');
    const messages = touches
      .filter((t) => t.kind !== 'connect')
      .map((t) => ({ kind: t.kind, sentAt: new Date(t.sent_at) }));
    const connectSentAt = connects.length ? new Date(connects[connects.length - 1].sent_at) : null;
    const snapshot: ContactSnapshot = {
      category: r.category,
      variant: r.variant,
      connected: connectSentAt !== null || messages.length > 0,
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
