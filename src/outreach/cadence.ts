// src/outreach/cadence.ts
export type Category = 'recruiter' | 'hiring_manager' | 'peer' | 'connection';
export type Variant = 'rapport_first' | 'direct_referral';
export type TouchKind = 'connect' | 'role_ask' | 'rapport' | 'referral_ask' | 'followup' | 'feedback';
export type CooldownReason = 'ignored' | 'not_now' | 'explicit_stop';

export const GAPS_DAYS = [3, 4, 5, 7, 10] as const;
const DAY_MS = 24 * 3600 * 1000;

export const COOLDOWN_DAYS: Record<CooldownReason, number> = {
  ignored: 75,
  not_now: 75,
  explicit_stop: 120,
};

export function sequenceFor(category: Category, variant: Variant | null): TouchKind[] {
  if (category === 'recruiter' || category === 'hiring_manager') {
    return ['role_ask', 'followup', 'followup', 'followup', 'feedback'];
  }
  if (category === 'connection') {
    return ['referral_ask', 'followup', 'followup', 'followup', 'feedback'];
  }
  return variant === 'direct_referral'
    ? ['referral_ask', 'followup', 'followup', 'followup', 'feedback']
    : ['rapport', 'followup', 'referral_ask', 'followup', 'feedback'];
}

/**
 * Snapshot of ONE cadence cycle: touches from before a cooldown are not included.
 * After a cooldown ends, callers pass a snapshot with no touches so the contact
 * restarts at the beginning of the sequence instead of resuming at "feedback sent".
 */
export interface ContactSnapshot {
  category: Category;
  variant: Variant | null;
  connected: boolean;
  connectedAt: Date | null;
  connectSentAt: Date | null;
  messages: { kind: TouchKind; sentAt: Date }[];
  replied: boolean;
  pausedReason: string | null;
  cooldownUntil: Date | null;
}

export interface PlannedTouch {
  kind: TouchKind;
  dueAt: Date;
}

export function planNextTouch(
  s: ContactSnapshot,
  now: Date,
  gaps: readonly number[] = GAPS_DAYS,
): PlannedTouch | null {
  if (s.replied || s.pausedReason) return null;
  if (s.cooldownUntil && now < s.cooldownUntil) return null;

  const seq = sequenceFor(s.category, s.variant);
  const n = s.messages.length;
  if (n >= seq.length) return null;

  const needsConnect = s.category !== 'connection';
  if (needsConnect && !s.connectSentAt) return { kind: 'connect', dueAt: now };
  if (needsConnect && !s.connected) return null;

  let anchor: Date | null;
  if (n === 0) anchor = needsConnect ? s.connectSentAt : null;
  else anchor = s.messages[n - 1].sentAt;
  if (!anchor) return { kind: seq[0], dueAt: now };

  let due = new Date(anchor.getTime() + gaps[n] * DAY_MS);
  if (n === 0 && s.connectedAt) {
    const earliest = new Date(s.connectedAt.getTime() + DAY_MS);
    if (earliest > due) due = earliest;
  }
  return { kind: seq[n], dueAt: due };
}

export function cooldownUntil(
  reason: CooldownReason,
  from: Date,
  days: Record<CooldownReason, number> = COOLDOWN_DAYS,
): Date {
  return new Date(from.getTime() + days[reason] * DAY_MS);
}
