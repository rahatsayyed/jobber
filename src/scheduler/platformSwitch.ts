// src/scheduler/platformSwitch.ts
// JOBBER_PLATFORMS: a focused-run switch. A comma list of the parts that may run (linkedin, naukri, wellfound, mail, sources, apply).
// Blank or unset means everything (today's behaviour). Any invalid name makes the WHOLE value read as unset (never silently restrict) and the doctor warns.
// It only narrows what is planned or started. It never changes a gate, a ceiling, a halt, the kill switch or the dry run.

export const SWITCH_NAMES = ['linkedin', 'naukri', 'wellfound', 'mail', 'sources', 'apply'] as const;
export type SwitchName = (typeof SWITCH_NAMES)[number];

export interface PlatformSwitch {
  /** Null means everything may run. */
  active: ReadonlySet<SwitchName> | null;
  /** Names that were not valid; when non-empty `active` is null. */
  invalid: string[];
}

export const NO_SWITCH: PlatformSwitch = { active: null, invalid: [] };

export function readPlatformSwitch(env: NodeJS.ProcessEnv): PlatformSwitch {
  const raw = (env.JOBBER_PLATFORMS ?? '').trim();
  if (!raw) return NO_SWITCH;
  const names = raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return NO_SWITCH;
  const invalid = names.filter((x) => !(SWITCH_NAMES as readonly string[]).includes(x));
  if (invalid.length > 0) return { active: null, invalid };
  return { active: new Set(names as SwitchName[]), invalid: [] };
}

/** True when the part may run (everything may when there is no switch). */
export function switchOn(sw: PlatformSwitch | ReadonlySet<SwitchName> | null | undefined, name: SwitchName): boolean {
  if (!sw) return true;
  const set = sw instanceof Set ? sw : (sw as PlatformSwitch).active;
  return set === null || set === undefined || set.has(name);
}

/** The text for logs and status: `all platforms`, `linkedin only`, `linkedin, mail`. */
export function describePlatformSwitch(sw: PlatformSwitch): string {
  if (!sw.active) return 'all platforms';
  const list = SWITCH_NAMES.filter((n) => sw.active!.has(n));
  return list.length === 1 ? `${list[0]} only` : list.join(', ');
}
