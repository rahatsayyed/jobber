// The ONE severity model for everything the owner is shown as "needs a look": dashboard Inbox, Telegram escalation digest and
// `npm run status -- escalations`. Pure, no imports, so a test can pin every rule.
//   critical: needs the owner now (a recruiter or interview reply, a captcha or login wall, a halted platform, an expired session,
//             discovery that returns a broken parse, a usage limit, the kill switch).
//   action:   the owner can unblock work (needs_answer, needs_owner, manual apply, an unknown overlay, an apply form that stopped).
//   info:     counts, ok states and noise (daily caps, skipped profiles, screen noise, layout drift the agent repairs itself).
// The input is the stored escalation shape; only the reason code, platform, group and ask kind are read, never message text.

export type Severity = 'critical' | 'action' | 'info';
export const SEVERITY_ORDER: Severity[] = ['critical', 'action', 'info'];
export const SEVERITY_LABELS: Record<Severity, string> = { critical: 'CRITICAL', action: 'ACTION', info: 'INFO' };

export interface SeverityInput {
  group?: string | null;
  platform?: string | null;
  reason?: string | null;
  askKind?: string | null;
}
export interface SeverityResult { severity: Severity; /** One line: why it matters and what to do. */ hint: string }

const R = (s: string | null | undefined): string => String(s ?? '').toLowerCase();

const CRITICAL_REPLY_ASKS = new Set(['reply', 'recruiter_inquiry', 'salary', 'interview_slot', 'question']);

// Reason-code rules, first match wins. They run on the stored reason code (never on a message body).
const CRITICAL_RULES: { test: RegExp; hint: string }[] = [
  { test: /kill[_ -]?switch|\bstop file\b|jobber_kill/, hint: 'Why: the kill switch is on, so nothing runs. Do: clear it only when you want the agent to work again.' },
  { test: /usage[_ -]?(limit|backoff)|rate[_ -]?limited by (claude|anthropic)|claude usage/, hint: 'Why: the model usage limit is hit, so every window pauses. Do: wait for the reset or raise your plan.' },
  { test: /captcha|login[_ -]?wall|\bmfa\b|needs_human|phone_verification|login[_ -]?failed|bot[_ -]?wall/, hint: 'Why: a person must pass a captcha, code or login. Do: run the shown command or open the page yourself.' },
  { test: /session[_ -]?(expired|invalid)|logged[_ -]?out|checkpoint|re-?login|log[_ -]?in required|\bauth(entication)?\b/, hint: 'Why: the platform session expired, so that platform is blind. Do: log in again with the platform login command.' },
  { test: /halt/, hint: 'Why: a platform is halted and does no work. Do: check /health, fix the cause, then resume with the owner control command.' },
  { test: /broken[_ -]?parse|parse[_ -]?(error|fail|broken)|discover\w*[_ -]?(empty|zero|broken)|zero[_ -]?results|extract\w*[_ -]?(broken|fail)|selector[_ -]?broken/, hint: 'Why: job discovery returns broken or empty data, so no new jobs arrive. Do: check /sources and the diag files.' },
];

const ACTION_APPLY = /needs_answer|needs_owner|manual|overlay[_ -]?unknown|unknown[_ -]?overlay|question|account_needed|host_unknown|consent|cover_letter|drift|no_relevant_role|unknown_apply_host|unsafe_apply_page|email_verification|marketing_checkbox/;

/** Severity and the one-line hint of an escalation. */
export function severityOf(i: SeverityInput): SeverityResult {
  const reason = R(i.reason);
  const platform = R(i.platform);
  const group = R(i.group);
  const ask = R(i.askKind);

  // Flagged text: screen noise (the owner may glance at it, nothing is blocked on them).
  if (group === 'noise') return { severity: 'info', hint: 'Why: the injection screen held back some text. Do: nothing unless a real person wrote it, then answer on the platform.' };

  // A real person wrote (reply, recruiter, interview, salary, question): never wait on these.
  if (group === 'human' && platform !== 'apply') {
    if (CRITICAL_REPLY_ASKS.has(ask) || ask === '') return { severity: 'critical', hint: 'Why: a recruiter or interviewer is waiting for you. Do: open the conversation on the platform and answer yourself.' };
    return { severity: 'action', hint: 'Why: someone wrote something that needs a human look. Do: open the thread, then mark handled.' };
  }

  for (const rule of CRITICAL_RULES) if (rule.test.test(reason)) return { severity: 'critical', hint: rule.hint };

  if (platform === 'apply' || reason.startsWith('apply:')) {
    if (ACTION_APPLY.test(reason) || group === 'human') return { severity: 'action', hint: 'Why: an application is stuck and only you can unblock it. Do: answer it, or open the job and finish or skip it, then mark handled.' };
    return { severity: 'action', hint: 'Why: an application stopped for a reason the agent could not handle. Do: open the job page, finish or skip it, then mark handled.' };
  }

  if (/overlay|unknown[_ -]?screen|new[_ -]?dialog/.test(reason)) return { severity: 'action', hint: 'Why: the page showed a screen the agent does not know. Do: look at the diag, then add the pattern or skip.' };
  if (/needs_owner|needs_answer|manual/.test(reason)) return { severity: 'action', hint: 'Why: work waits for you. Do: open the Inbox group named in the card and finish it.' };

  // Platform and tool problems left over: daily caps, skipped profiles, layout drift the agent repairs on its own.
  return { severity: 'info', hint: 'Why: the agent skipped a step and usually repairs it by itself. Do: nothing unless it keeps coming back, then run /health.' };
}

export type SeverityCounts = Record<Severity, number>;

export function severityCounts(items: ReadonlyArray<SeverityInput & { resolved_at?: string | null }>): SeverityCounts {
  const out: SeverityCounts = { critical: 0, action: 0, info: 0 };
  for (const i of items) if (!i.resolved_at) out[severityOf(i).severity] += 1;
  return out;
}

/** `2 critical, 5 action` (info is not part of the line). */
export function severitySummary(c: SeverityCounts): string {
  return `${c.critical} critical, ${c.action} action`;
}

type Aged = { last_at?: string | null; created_at?: string | null; id?: number };
const atOf = (i: Aged): string => String(i.last_at || i.created_at || '');

/** Sort by severity, then the one waiting longest first (oldest activity), then newest id. Returns a new array. */
export function sortBySeverity<T extends SeverityInput & Aged>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    SEVERITY_ORDER.indexOf(severityOf(a).severity) - SEVERITY_ORDER.indexOf(severityOf(b).severity)
    || (atOf(a) < atOf(b) ? -1 : atOf(a) > atOf(b) ? 1 : 0)
    || (b.id ?? 0) - (a.id ?? 0));
}
