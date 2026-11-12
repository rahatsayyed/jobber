// src/stack/summary.ts
// Pure formatter for the quiet `npm run up` output: only what needs the owner's attention.
// Everything routine stays available with `npm run up -- --verbose` and `npm run doctor`.
import type { CheckOutcome } from '../platform/doctor.js';

export interface ComponentState {
  name: string;
  /** True when the component is running (or deliberately skipped / disabled, which is not a problem). */
  ok: boolean;
  /** Short state text, used only when not ok. */
  state: string;
}

export interface UpSummary {
  components: ComponentState[];
  dashboardUrl: string | null;
  /** The MODE head line (`MODE: LIVE ...` or `MODE: DRY RUN ...`). */
  modeLine: string;
  /** True when the configured mode needs attention (DRY RUN while the owner expects live sends, or shell and .env disagree). */
  modeNeedsAttention: boolean;
  /** Extra mode lines that are real problems (shell divergence warnings). */
  modeWarnings: string[];
  /** Problems that need the owner (already filtered, plain words). */
  problems: string[];
}

/** Doctor warn ids that always need the owner (a login, a session or a service that is not working). */
const ATTENTION_IDS = new Set([
  'sessions', 'wellfound-session', 'claude-login', 'gmail-oauth', 'telegram-api', 'telegram-bridge',
  'scheduler-stop-file', 'discover_parse',
]);

/** window-foundation always warns with a long "unverified" note: only its real problems count. */
const WINDOW_PROBLEM_RE = /running with (an )?old|not running|has no window|is missing/;

/** One plain line for a doctor warning that needs the owner, or null for a routine warning. */
export function attentionLine(o: CheckOutcome): string | null {
  if (o.result.status !== 'warn') return null;
  const fix = o.result.fix ? ` Fix: ${o.result.fix}` : '';
  const detail = o.result.detail.replace(/\.$/, '');
  if (o.id === 'window-foundation') return WINDOW_PROBLEM_RE.test(detail) ? `${detail}.${fix}` : null;
  return ATTENTION_IDS.has(o.id) ? `${detail}.${fix}` : null;
}

export function attentionLines(outcomes: CheckOutcome[]): string[] {
  const out: string[] = [];
  for (const o of outcomes) {
    const l = attentionLine(o);
    if (l) out.push(l);
  }
  return out;
}

/** The quiet output. Order: status line, problems, dashboard URL, mode line (only when it needs attention). */
export function formatCompact(s: UpSummary): string[] {
  const lines: string[] = [];
  const down = s.components.filter((c) => !c.ok);
  if (down.length === 0) lines.push(`Jobber: all ${s.components.length} components running`);
  else {
    lines.push(
      `Jobber: ${s.components.length - down.length} of ${s.components.length} running, down: ${down.map((c) => `${c.name} (${c.state})`).join(', ')}`,
    );
  }
  for (const p of s.problems) lines.push(`NEEDS YOU: ${p}`);
  if (s.dashboardUrl) lines.push(`dashboard: ${s.dashboardUrl}`);
  if (s.modeNeedsAttention) lines.push(s.modeLine);
  for (const w of s.modeWarnings) lines.push(w);
  return lines;
}
