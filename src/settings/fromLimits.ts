// src/settings/fromLimits.ts
// Composes a catalog entry from a LIMITS entry (src/setup/limitsCatalog.ts stays the source for default, min, max,
// unit and the meaning). Only the settings-editor facts live here: tier, direction, restart, example marker.
import type { LimitGroup, LimitSpec } from '../setup/limitsCatalog.js';
import type { EnvSpec, RestartScope, SectionId, Weakens } from './types.js';

const GROUP_FEATURE: Record<LimitGroup, string> = {
  'daily-caps': 'daily caps',
  'weekly-caps': 'weekly caps',
  'per-company': 'per-company limits',
  'quiet-hours': 'quiet hours',
  pacing: 'pacing',
  cooldowns: 'cooldowns and cadence',
  matching: 'matching',
};

// Which way a change loosens a limit. Default is 'increase' (a bigger cap or burst is more aggressive).
const DECREASE = new Set([
  'MATCH_THRESHOLD',
  'APPLY_HOST_COOLDOWN_DAYS',
  'PACING_MIN_BURST',
  'PACING_MIN_ACTION_GAP_SEC',
  'PACING_MIN_WAIT_MIN',
  'PACING_JITTER_PCT',
  'COOLDOWN_IGNORED_DAYS',
  'COOLDOWN_NOT_NOW_DAYS',
  'COOLDOWN_EXPLICIT_STOP_DAYS',
  'CADENCE_GAPS_DAYS',
  'EMAIL_FOLLOWUP_GAPS_DAYS',
]);
const ANY = new Set(['QUIET_HOURS_START', 'QUIET_HOURS_END']);

export function limitWeakens(key: string): Weakens {
  if (ANY.has(key)) return 'any';
  return DECREASE.has(key) ? 'decrease' : 'increase';
}

export interface LimitOverride {
  section?: SectionId;
  feature?: string;
  exampleActive?: boolean;
  restart?: RestartScope;
  restartEvidence?: string;
  blankMeansDefault?: boolean;
  /** Extra sentence appended to the limit's own meaning. */
  aboutExtra?: string;
}

export function fromLimit(spec: LimitSpec, over: LimitOverride = {}): EnvSpec {
  const isList = typeof spec.default === 'string';
  const base: EnvSpec = {
    key: spec.key,
    section: over.section ?? 'limits',
    feature: over.feature ?? GROUP_FEATURE[spec.group],
    type: isList ? 'intList' : 'int',
    default: String(spec.default),
    exampleActive: over.exampleActive ?? false,
    required: 'optional',
    min: spec.min,
    max: spec.max,
    secret: false,
    // Plan tier table: every LIMITS key is guarded (money, account-ban risk and volume).
    tier: 'guarded',
    tierReason: spec.raiseNote ?? 'A volume, spacing or timing limit: loosening it raises account-ban or spam risk.',
    weakens: limitWeakens(spec.key),
    restart: over.restart ?? 'stack',
    blankMeansDefault: over.blankMeansDefault ?? false,
    about: `${spec.what} Unit: ${spec.unit}.${over.aboutExtra ? ` ${over.aboutExtra}` : ''}`,
    auditValue: !isList,
  };
  if (isList) base.itemCount = String(spec.default).split(',').length;
  if (over.restartEvidence) base.restartEvidence = over.restartEvidence;
  if (spec.raiseNote) base.note = spec.raiseNote;
  return base;
}
