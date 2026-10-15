// Drift-aware precondition for naukri_send_message (plan 8B), same semantics as the LinkedIn guard in
// src/linkedin/layoutGuard.ts. It runs after the inbound and classifier screens and before the
// ceiling is consumed or anything is typed, so a layout refusal costs nothing. The native Apply click
// is never made more permissive by layout state: it has no precondition here at all.
import type { LayoutConfig } from '../layout/config.js';
import type { Verdict } from '../layout/types.js';
import { TOOL_REQUIRES } from '../layout/vocab.js';

export type NaukriLayoutDecision =
  | { ok: true; note?: string }
  | { ok: false; status: 'refused'; code: 'layout_drift' | 'layout_unverified'; reason: string };

const UNKNOWN: Verdict = { class: 'unknown', score: 0, missing: [], variant: null };

/**
 * `off` and `warn` always allow (warn adds a note unless the page matched). `enforce` refuses on
 * `drift`, `unknown`, `unloaded` and a null verdict; `partial` passes only when every landmark the
 * tool needs is PRESENT in the current observation (`present`); `blocked` and `logged_out` are not
 * layout refusals (the halt and login codes stay in charge).
 */
export function naukriLayoutPrecondition(
  v: Verdict | null, cfg: LayoutConfig, present?: readonly string[],
): NaukriLayoutDecision {
  const verdict = v ?? UNKNOWN;
  const note = verdict.class === 'match' ? undefined : `layout=${verdict.class}`;
  const ok = (): NaukriLayoutDecision => (note ? { ok: true, note } : { ok: true });
  if (cfg.enforce !== 'enforce') return ok();
  switch (verdict.class) {
    case 'match':
    case 'blocked':
    case 'logged_out':
      return ok();
    case 'partial': {
      const need = TOOL_REQUIRES.naukri_send_message?.landmarks ?? [];
      const absent = need.filter((l) => !present?.includes(l));
      if (absent.length === 0) return ok();
      const gone = absent.some((l) => verdict.missing.includes(l));
      return {
        ok: false, status: 'refused', code: gone ? 'layout_drift' : 'layout_unverified',
        reason: `page layout lacks needed parts: ${absent.join(' ')}`,
      };
    }
    case 'drift':
      return { ok: false, status: 'refused', code: 'layout_drift', reason: 'page layout no longer matches the learned layout' };
    case 'unloaded':
      return { ok: false, status: 'refused', code: 'layout_unverified', reason: 'page was not fully loaded, retry shortly' };
    default:
      return { ok: false, status: 'refused', code: 'layout_unverified', reason: 'layout for this page is not learned yet' };
  }
}
