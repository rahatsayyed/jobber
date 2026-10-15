// Drift-aware precondition for the typed LinkedIn tools (plan 8B). It sits after the halt, quiet-hour
// and recipient guards and before any ceiling is consumed, so a layout refusal costs nothing.
import type { LayoutConfig } from '../layout/config.js';
import { loadLayoutConfig } from '../layout/config.js';
import type { Verdict } from '../layout/types.js';
import { TOOL_REQUIRES } from '../layout/vocab.js';
import type { Runtime } from './runtime.js';
import type { ToolDeps } from './toolDeps.js';

export type LayoutTool = 'connect_send' | 'send_message' | 'accept_invite' | 'check_connection_status';
export type LayoutDecision =
  | { ok: true; note?: string }
  | { ok: false; status: 'refused'; code: 'layout_drift' | 'layout_unverified'; reason: string };

const UNKNOWN: Verdict = { class: 'unknown', score: 0, missing: [], variant: null };

/**
 * `off`: always ok. `warn`: always ok, with a note unless the page matched. `enforce`: the
 * irreversible tools refuse on `drift` and on `unknown` (so enforcement only bites after a learning
 * run); `partial` passes only when none of the landmarks the tool needs is listed as missing (the
 * parts that were verified are the ones it uses); `unloaded` refuses with a retry hint;
 * `blocked` and `logged_out` are not layout refusals (the existing halt and login codes win).
 * `check_connection_status` is read-only and never refuses. A null verdict counts as `unknown`.
 */
export function layoutPrecondition(tool: LayoutTool, v: Verdict | null, cfg: LayoutConfig): LayoutDecision {
  const verdict = v ?? UNKNOWN;
  const note = verdict.class === 'match' ? undefined : `layout=${verdict.class}`;
  const ok = (): LayoutDecision => (note ? { ok: true, note } : { ok: true });
  if (cfg.enforce !== 'enforce' || tool === 'check_connection_status') return ok();
  switch (verdict.class) {
    case 'match':
    case 'blocked':
    case 'logged_out':
      return ok();
    case 'partial': {
      const need = TOOL_REQUIRES[`linkedin_${tool}`]?.landmarks ?? [];
      const missing = need.filter((l) => verdict.missing.includes(l));
      if (missing.length === 0) return ok();
      return { ok: false, status: 'refused', code: 'layout_drift', reason: `page layout lacks needed parts: ${missing.join(' ')}` };
    }
    case 'drift':
      return { ok: false, status: 'refused', code: 'layout_drift', reason: 'page layout no longer matches the learned layout' };
    case 'unloaded':
      return { ok: false, status: 'refused', code: 'layout_unverified', reason: 'page was not fully loaded, retry shortly' };
    default:
      return { ok: false, status: 'refused', code: 'layout_unverified', reason: 'layout for this page is not learned yet' };
  }
}

/** The observer's verdict for the page a tool just opened, or null when it is for another kind or absent. */
export function currentVerdict(rt: Runtime, tool: LayoutTool | 'find_profiles'): Verdict | null {
  try {
    const last = rt.layout?.last();
    if (!last) return null;
    return last.kind === TOOL_REQUIRES[`linkedin_${tool}`]?.kind ? last.verdict : null;
  } catch {
    return null;
  }
}

/** Run the precondition for a typed tool against the current observation. */
export function layoutGate(tool: LayoutTool, deps: ToolDeps): LayoutDecision {
  const cfg = deps.layoutCfg ?? loadLayoutConfig(deps.env);
  return layoutPrecondition(tool, currentVerdict(deps.rt, tool), cfg);
}

/**
 * Verdict class for the read-only tools' results (never a refusal). `find_profiles` observes the
 * search page; the hook is the runtime's open(), so there is nothing to do here but report it.
 */
export function layoutClassOf(rt: Runtime, tool: LayoutTool | 'find_profiles'): { layout: string } | Record<string, never> {
  if (!rt.layout) return {};
  return { layout: currentVerdict(rt, tool)?.class ?? 'unknown' };
}
