// src/outreach/emailReplyFlags.ts
// The two switches of the email auto reply path. Owner decision 2026-11-07: both are ON by default and off only with the exact word
// `false` (like Easy Apply, see src/apply/easyFlag.ts). They stay tier `never`: the agent and the dashboard never set them. With no
// confirmed facts in user-data/reply-facts.json nothing is ever answered, so "on" alone sends nothing.
export function emailAutoReplyOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.EMAIL_AUTO_REPLY ?? '').trim().toLowerCase() !== 'false';
}

export function emailReplyNudgeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.EMAIL_REPLY_NUDGE ?? '').trim().toLowerCase() !== 'false';
}

export const EMAIL_REPLY_NUDGE_DAYS_DEFAULT = 3;
/** EMAIL_REPLY_NUDGE_DAYS: default 3, clamped to 1..30 (blank or non-numeric gives the default). */
export function emailReplyNudgeDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EMAIL_REPLY_NUDGE_DAYS;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return EMAIL_REPLY_NUDGE_DAYS_DEFAULT;
  return Math.min(30, Math.max(1, Math.floor(n)));
}
