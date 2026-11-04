// src/scheduler/mailLimit.ts
// The daily send limit the mail lane hands to the shared `send_email` counter: EMAIL_MAX_PER_DAY when it is a positive
// integer, else NO_CAP_LIMIT (effectively no cap). Used at window start for the `mail` window's SEND_LIMIT_PER_RUN marker
// (scripts/window-env.ts) and by the doctor to spot a stale marker. Pure.
/** daily_counters limit when EMAIL_MAX_PER_DAY is 0 or unset: effectively no cap. */
export const NO_CAP_LIMIT = 100000;

export function mailDailyLimit(env: NodeJS.ProcessEnv): number {
  const raw = (env.EMAIL_MAX_PER_DAY ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n > 0 && n <= 100000 ? n : NO_CAP_LIMIT;
}
