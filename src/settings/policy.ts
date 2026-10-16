// src/settings/policy.ts
// Friction policy for the dashboard settings editor (plan 8H, Task 6): what an env change set costs by tier x
// direction, the confirmation phrase, the remote-exposure rule and the preflight warnings. Pure: no I/O, no env
// reads, no session state (the server decides what to do with `reauth`). Direction comes from weakens().
import { timingSafeEqual } from 'node:crypto';
import type { FrictionInput, ResolvedChange } from './envEdit.js';
import type { Friction, PolicyCtx } from './types.js';
import { weakens } from './valueCheck.js';

export type Mode = 'DRY RUN' | 'LIVE';
export type { ResolvedChange };

const isWeakening = (c: ResolvedChange): boolean => weakens(c.spec, c.before, c.after);

/** Phrase the user must type: GO LIVE on a file-mode flip, else CHANGE <KEY> or CHANGE <N> SAFETY SETTINGS. */
export function phraseFor(changes: ResolvedChange[], modeBefore: Mode, modeAfter: Mode): string | null {
  if (modeBefore === 'DRY RUN' && modeAfter === 'LIVE') return 'GO LIVE';
  const safety = changes.filter((c) => c.spec.tier === 'safety' && isWeakening(c));
  if (safety.length === 0) return null;
  if (safety.length === 1) return `CHANGE ${safety[0].spec.key}`;
  return `CHANGE ${safety.length} SAFETY SETTINGS`;
}

/** Constant-time, case-sensitive comparison of the typed phrase (trimmed) with the expected one. */
export function phraseMatches(typed: unknown, expected: string | null): boolean {
  if (typeof typed !== 'string' || expected === null) return false;
  const a = Buffer.from(typed.trim());
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Strictest result across the whole set; a refusal anywhere refuses everything. */
export function requiredFriction(
  changes: ResolvedChange[],
  ctx: PolicyCtx,
  modes: { modeBefore: Mode; modeAfter: Mode } = { modeBefore: 'DRY RUN', modeAfter: 'DRY RUN' },
): Friction {
  if (!ctx.editEnabled) return { refuse: 'settings_disabled', reauth: false, phrase: null };
  if (changes.some((c) => c.spec.tier === 'never')) return { refuse: 'tier_never', reauth: false, phrase: null };
  const safetyWeak = changes.some((c) => c.spec.tier === 'safety' && isWeakening(c));
  if (safetyWeak && ctx.remoteExposure && !ctx.remoteSafetyAllowed) {
    return { refuse: 'remote_exposure', reauth: false, phrase: null };
  }
  const guardedWeak = changes.some((c) => c.spec.tier === 'guarded' && isWeakening(c));
  const reauth = safetyWeak || guardedWeak;
  const phrase = safetyWeak ? phraseFor(changes, modes.modeBefore, modes.modeAfter) : null;
  return { reauth, phrase };
}

/** FrictionFn for planEnvChange / planRollback. */
export function frictionFor(input: FrictionInput, ctx: PolicyCtx): Friction {
  return requiredFriction(input.changes, ctx, { modeBefore: input.modeBefore, modeAfter: input.modeAfter });
}

export interface PreflightDeps {
  classifierReady: () => boolean;
  stopPresent: () => boolean;
  permissionSet: () => string;
  chatEnabled: boolean;
  sendLimitPerRun: string | undefined;
}

/** Warnings only; never blocks. The live-flip warnings apply to a DRY RUN to LIVE flip only. */
export function preflight(modeAfter: Mode, deps: PreflightDeps, modeBefore: Mode = 'DRY RUN'): string[] {
  const w: string[] = [];
  const flip = modeBefore === 'DRY RUN' && modeAfter === 'LIVE';
  if (flip && !deps.classifierReady()) w.push('The injection classifier is not ready: live LinkedIn and Naukri reads and sends will be blocked.');
  if (deps.stopPresent()) w.push('The kill switch is engaged, nothing will run.');
  const set = deps.permissionSet();
  if (deps.chatEnabled && set !== 'read_only') w.push(`The dashboard chat box is enabled while the permission set is ${set}, not read_only.`);
  if (flip && (deps.sendLimitPerRun ?? '').trim() === '0') w.push('SEND_LIMIT_PER_RUN is 0: going live will not send any email.');
  return w;
}
