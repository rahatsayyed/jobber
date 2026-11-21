// src/heal/signature.ts
// Maps a failure to a stable signature `area:code` and decides, from ONE table each, whether it may ever be healed.
// NEVER is checked first and is a closed list of things that are owner-only by design (see CLAUDE.md Safety rules): human walls,
// questions, infrastructure outages, halts, and every safety-gate refusal. QUALIFYING lists the code-defect-like areas; add a row to
// extend it. A signature in neither table is not healed. Pure: no I/O.

export type Area = 'run' | 'apply' | 'discover' | 'jd' | 'diag' | 'lane';

export interface Failure {
  area: Area;
  /** Raw machine code (stop reason, apply_note code, diag reason ...). Free text is slugged. */
  code: string;
  platform?: string;
  /** Worker window the failure came from, when known. */
  window?: string;
}

export interface Verdict {
  signature: string;
  heal: boolean;
  /** Why it qualifies, or why it is never healed (always set). */
  reason: string;
  /** After a landing, rows parked with this signature may go back to queued (max 3, never submitted ones). */
  requeueSafe: boolean;
  /** Can the real action be tried before landing? See Testability. `not_testable` for anything that is not heal. */
  testability: Testability;
  /** The live check to run (only for the two live_* values), else null. */
  liveCheck: string | null;
  /** The platform the live check runs on, when it can be told from the signature. */
  platform: string | null;
}

/**
 * live_readonly: the real action runs from the fixer's worktree code with no commit and no send (a search, a JD read).
 * live_until_commit: it runs up to, never including, the irreversible click (Easy Apply to the review step, an invite to the dialog).
 * not_testable: an email send, the real Submit or Send, anything that needs a human, or no live check exists yet.
 */
export type Testability = 'live_readonly' | 'live_until_commit' | 'not_testable';

export interface NeverRule { pattern: RegExp; reason: string }
export interface QualifyRule { pattern: RegExp; reason: string; requeueSafe?: boolean; testability: Testability; check?: string }

/**
 * Live checks that exist in src/heal/live.ts, as `platform:check`. A rule that wants a live try on a platform not listed here is
 * `not_testable` (tests plus the watch window only). Add the entry together with the check.
 */
export const LIVE_IMPLEMENTED: ReadonlySet<string> = new Set(['linkedin:discover_search', 'linkedin:jd_read', 'linkedin:easy_apply_review']);

/** The platform a signature belongs to, or null. */
export function platformOfSignature(sig: string): string | null {
  const s = sig.toLowerCase();
  if (/linkedin|easy_apply/.test(s)) return 'linkedin';
  if (/naukri/.test(s)) return 'naukri';
  if (/wellfound/.test(s)) return 'wellfound';
  if (/(^|[:_])(scout|sources?)([:_]|$)/.test(s)) return 'scout';
  return null;
}

/** Owner-only or non-code. Matched against the whole signature (already lower case). */
export const NEVER: readonly NeverRule[] = [
  { pattern: /captcha|login|(^|[_:.#-])(mfa|2fa|otp)($|[_:.#-])|bot[_-]?wall|needs_human|human_verification|assist:/, reason: 'human wall (captcha, login, MFA, bot wall): owner only' },
  { pattern: /needs_answer|agent_handle|unanswerable|required_question/, reason: 'form question the machine must not guess: owner only' },
  { pattern: /usage_limit|usage_backoff|rate[_-]?limit|api_error|overloaded|(^|[_:.#-])5\d\d($|[_:.#-])|max_tokens|refusal/, reason: 'model or API availability: infrastructure, has its own backoff' },
  { pattern: /network|offline|econn|enotfound|etimedout|dns|socket|tls|certificate|proxy/, reason: 'network outage: infrastructure, not code' },
  { pattern: /orphaned|stalled|no_transcript|window_unavailable|window_busy|window_missing|not_claude|send_failed|wall_clock|timeout:/, reason: 'window or session upkeep, not a code defect' },
  { pattern: /halt|(^|[_:.#-])kill(ed)?($|[_:.#-])|kill_switch|shutdown/, reason: 'halt or kill switch: owner decision' },
  { pattern: /veto|hard[_ -]?stop|fact[_-]?gate|output[_-]?gate|input[_-]?gate|classifier|injection|style[_-]?gate|legitimacy/, reason: 'safety gate refusal: working as designed' },
  { pattern: /ceiling|limit[_-]?reached|cap[_-]?reached|(^|[_:.#-])cap($|[_:.#-])|quota|daily_limit|note_quota|custom_note_limit/, reason: 'ceiling or quota reached: working as designed' },
  { pattern: /send[_-]?window|quiet[_-]?hours|outside_window|active_hours|not_due|nothing_due|bad_config/, reason: 'schedule or configuration gate: working as designed' },
  { pattern: /unknown_apply_host|host_unknown|host_changed|unsafe_apply_page|no_relevant_role|payment|government|bank_details/, reason: 'apply host or page safety rule: owner only' },
  { pattern: /^apply:(submitted|held|queued|closed|expired|already_applied|duplicate)/, reason: 'success or closed posting, nothing to fix' },
  { pattern: /^run:(ok|skipped|planned|running)/, reason: 'not a failure' },
];

/** Code-defect-like areas. First match wins. */
export const QUALIFYING: readonly QualifyRule[] = [
  { pattern: /^apply:easy_apply:(resume_upload_failed|upload_failed|resume_not_attached)/, reason: 'Easy Apply upload step broke (selector or flow drift)', requeueSafe: true, testability: 'live_until_commit', check: 'easy_apply_review' },
  { pattern: /^apply:.*(no_popup|open_failed|submit_failed|next_failed|form_not_found|overlay_unknown|controls_missing|modal_refs_missing|selector|parse)/, reason: 'apply flow could not drive the page (drift or bug)', requeueSafe: true, testability: 'live_until_commit', check: 'apply_review' },
  { pattern: /^apply:/, reason: 'apply row parked with a code the machine could not finish', testability: 'not_testable' },
  { pattern: /^discover:/, reason: 'discovery returned nothing or broke (parser or layout drift)', testability: 'live_readonly', check: 'discover_search' },
  { pattern: /^jd:(incomplete|pending_stuck|parse|truncated)/, reason: 'job description fetch keeps coming back incomplete', testability: 'live_readonly', check: 'jd_read' },
  { pattern: /^diag:/, reason: 'a structural diag file appeared (page controls not found)', testability: 'not_testable' },
  { pattern: /^run:crashed/, reason: 'a run crashed', testability: 'not_testable' },
  { pattern: /^run:failed/, reason: 'a run failed', testability: 'not_testable' },
  { pattern: /^run:incomplete:/, reason: 'a run ended with an unproven step', testability: 'not_testable' },
  { pattern: /^lane:[a-z]+:dispatch_error/, reason: 'the dispatcher raised an error', testability: 'not_testable' },
];

const MAX_CODE = 80;

/** One short, stable code: lower case, ids and long numbers folded to `#`, anything unsafe to `_`. */
export function normalizeCode(raw: string): string {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/https?:[^\s]+/g, 'url')
    .replace(/[0-9a-f]{8,}/g, '#')
    .replace(/\d{4,}/g, '#')
    .replace(/[^a-z0-9_:.#-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_:.-]+|[_:.-]+$/g, '');
  return (s || 'unknown').slice(0, MAX_CODE);
}

/** `area:code`, or `area:platform:code` when a platform is known and the code does not already start with it. */
export function signatureOf(f: Failure): string {
  const code = normalizeCode(f.code);
  const p = f.platform ? normalizeCode(f.platform) : '';
  // A code that already has structure (`easy_apply:resume_upload_failed`) is kept as is; a bare code gets its platform.
  const withPlatform = p !== '' && !code.includes(':') && !code.startsWith(`${p}_`) && f.area !== 'run' && f.area !== 'lane' && f.area !== 'apply';
  return withPlatform ? `${f.area}:${p}:${code}` : `${f.area}:${code}`;
}

/** Classify a signature (or a failure). NEVER first, then QUALIFYING, anything else is not healed. */
export function classify(input: string | Failure): Verdict {
  const signature = (typeof input === 'string' ? input : signatureOf(input)).toLowerCase();
  const n = NEVER.find((r) => r.pattern.test(signature));
  const none = { requeueSafe: false, testability: 'not_testable' as Testability, liveCheck: null, platform: null };
  if (n) return { signature, heal: false, reason: n.reason, ...none };
  const q = QUALIFYING.find((r) => r.pattern.test(signature));
  if (q) {
    const platform = platformOfSignature(signature);
    const live = q.testability !== 'not_testable' && q.check !== undefined && platform !== null && LIVE_IMPLEMENTED.has(`${platform}:${q.check}`);
    return {
      signature, heal: true, reason: q.reason, requeueSafe: q.requeueSafe === true, platform,
      testability: live ? q.testability : 'not_testable', liveCheck: live ? (q.check as string) : null,
    };
  }
  return { signature, heal: false, reason: 'not in the qualifying table', ...none };
}

/** A branch-safe slug of a signature. */
export const signatureSlug = (sig: string): string => sig.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'sig';

/** Marker words in a run summary that point at a discovery or layout failure, read when a run ended ok but reported trouble. */
export const SUMMARY_SIGNALS: ReadonlyArray<{ pattern: RegExp; code: string }> = [
  { pattern: /nav_timeout/i, code: 'nav_timeout' },
  { pattern: /no[_ ]cards|0 cards|zero cards/i, code: 'no_cards_parse_drift' },
  { pattern: /dialog_controls_missing/i, code: 'dialog_controls_missing' },
  { pattern: /modal_refs_missing/i, code: 'modal_refs_missing' },
  { pattern: /unresolvable_point/i, code: 'unresolvable_point' },
  { pattern: /bad_extraction/i, code: 'bad_extraction' },
];
