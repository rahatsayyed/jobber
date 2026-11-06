// src/outreach/emailReplyFlags.ts
// The two owner-only switches of the email auto reply path (decision 2026-11-06). Both ship false and are tier `never`: the agent and the
// dashboard never set them, the owner edits .env by hand. Exactly the string `true` turns one on.
export function emailAutoReplyOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMAIL_AUTO_REPLY === 'true';
}

export function emailReplyNudgeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMAIL_REPLY_NUDGE === 'true';
}

export const EMAIL_REPLY_NUDGE_DAYS_DEFAULT = 3;
/** EMAIL_REPLY_NUDGE_DAYS: default 3, clamped to 1..30 (blank or non-numeric gives the default). */
export function emailReplyNudgeDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EMAIL_REPLY_NUDGE_DAYS;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return EMAIL_REPLY_NUDGE_DAYS_DEFAULT;
  return Math.min(30, Math.max(1, Math.floor(n)));
}
