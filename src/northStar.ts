// file: src/northStar.ts
// The owner's North Star: the target role archetypes and the criteria the match rubric scores against. career-ops reads these from the
// user's profile file (modes/_profile.md "Your Target Roles", config/profile.yml culture_screen and dealbreakers); ours is the optional
// `north_star` section of user-data/profile.json. ONE source of truth: the deterministic ROLE GATE (src/roleGate.ts) builds its allowed
// families from these archetypes when the section is present, and from config/role-families.json otherwise. The model sees the same
// list through the `North Star:` line (northStarLine). This module is pure (no node imports: src/setup/profile.ts validates with it);
// the file loader is src/northStarLoad.ts. Nothing here invents a value: a missing section, a missing comp or an empty
// list is "unknown" and the matcher is told so.
import type { FamilyRule, RoleGateConfig } from './roleGate.js';

export const ARCHETYPE_FITS = ['primary', 'secondary', 'adjacent'] as const;
export type ArchetypeFit = (typeof ARCHETYPE_FITS)[number];

export interface Archetype {
  /** Short name the matcher reports as the detected archetype. */
  name: string;
  /** career-ops: primary = dream role, secondary = good fit, adjacent = stretch. */
  fit: ArchetypeFit;
  /** Case-insensitive regular expressions on the job TITLE (the code role gate). */
  title_patterns: string[];
  /** A title that also matches one of these is NOT this archetype (e.g. "react native" is not "react"). */
  title_not?: string[];
  /** Role gate: a title in this archetype passes to the matcher only when the title or the posting shows a javascript, react or full-stack signal (config/role-families.json signal_patterns). */
  requires_signal?: boolean;
  /** Words in a posting that signal this archetype (read by the model, not by the gate). */
  signals?: string[];
  /** The level the owner targets for this archetype, free text (read by the model). Leave empty when unknown. */
  level?: string;
}
export interface NorthStar {
  archetypes: Archetype[];
  /** career-ops culture_screen.require: what the owner looks for in a team. Empty = no culture screen. */
  require: string[];
  /** career-ops culture_screen.deprioritize_if_absent: no evidence for any `require` item caps Cultural signals at 2. */
  deprioritize_if_absent: boolean;
  /** Hard "never" rules, quoted to the matcher. A scored preference does not belong here. */
  dealbreakers: string[];
  /** Compensation expectations. Empty strings mean unknown: the matcher must not invent them. */
  comp: { currency: string; target_range: string; minimum: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

/** Field paths (never values) that break the shape; [] when valid. `undefined` is valid (the section is optional). */
export function validateNorthStar(v: unknown): string[] {
  if (v === undefined) return [];
  if (!isObj(v)) return ['north_star'];
  const bad: string[] = [];
  if (!Array.isArray(v.archetypes) || v.archetypes.length === 0) {
    bad.push('north_star.archetypes');
  } else {
    v.archetypes.forEach((a, i) => {
      const at = `north_star.archetypes[${i}]`;
      if (!isObj(a)) { bad.push(at); return; }
      if (typeof a.name !== 'string' || !a.name.trim()) bad.push(`${at}.name`);
      if (!(ARCHETYPE_FITS as readonly unknown[]).includes(a.fit)) bad.push(`${at}.fit`);
      if (!strList(a.title_patterns) || a.title_patterns.length === 0) bad.push(`${at}.title_patterns`);
      else if (!a.title_patterns.every(regexOk)) bad.push(`${at}.title_patterns (regular expression)`);
      if (a.title_not !== undefined && (!strList(a.title_not) || !a.title_not.every(regexOk))) bad.push(`${at}.title_not`);
      if (a.signals !== undefined && !strList(a.signals)) bad.push(`${at}.signals`);
      if (a.requires_signal !== undefined && typeof a.requires_signal !== 'boolean') bad.push(`${at}.requires_signal`);
      if (a.level !== undefined && typeof a.level !== 'string') bad.push(`${at}.level`);
    });
  }
  if (v.require !== undefined && !strList(v.require)) bad.push('north_star.require');
  if (v.deprioritize_if_absent !== undefined && typeof v.deprioritize_if_absent !== 'boolean') bad.push('north_star.deprioritize_if_absent');
  if (v.dealbreakers !== undefined && !strList(v.dealbreakers)) bad.push('north_star.dealbreakers');
  if (v.comp !== undefined) {
    if (!isObj(v.comp)) bad.push('north_star.comp');
    else for (const k of ['currency', 'target_range', 'minimum']) if (v.comp[k] !== undefined && typeof v.comp[k] !== 'string') bad.push(`north_star.comp.${k}`);
  }
  return bad;
}

function regexOk(p: string): boolean {
  try { new RegExp(p, 'i'); return true; } catch { return false; }
}

/** Normalise a VALID north_star object (defaults for the optional fields). Call validateNorthStar first. */
export function parseNorthStar(v: unknown): NorthStar {
  const o = v as Record<string, any>;
  const c = isObj(o.comp) ? o.comp : {};
  return {
    archetypes: (o.archetypes as any[]).map((a) => ({
      name: String(a.name).trim(), fit: a.fit as ArchetypeFit, title_patterns: (a.title_patterns as string[]).map((x) => x.trim()),
      ...(a.title_not ? { title_not: (a.title_not as string[]).map((x) => x.trim()) } : {}),
      ...(a.requires_signal === true ? { requires_signal: true } : {}),
      ...(a.signals ? { signals: (a.signals as string[]).map((x) => x.trim()) } : {}),
      ...(typeof a.level === 'string' && a.level.trim() ? { level: a.level.trim() } : {}),
    })),
    require: Array.isArray(o.require) ? (o.require as string[]).map((x) => x.trim()) : [],
    deprioritize_if_absent: o.deprioritize_if_absent === true,
    dealbreakers: Array.isArray(o.dealbreakers) ? (o.dealbreakers as string[]).map((x) => x.trim()) : [],
    comp: { currency: String(c.currency ?? '').trim(), target_range: String(c.target_range ?? '').trim(), minimum: String(c.minimum ?? '').trim() },
  };
}

/**
 * The role gate's allowed families, built from the archetypes: primary and secondary pass; adjacent is borderline (the matcher scores
 * it strictly). The deny list, pay-model phrases and the backend signal stay in config/role-families.json: those are gate rules, not targets.
 */
export function applyArchetypes(base: RoleGateConfig, ns: NorthStar | null): RoleGateConfig {
  if (!ns) return base;
  const rule = (a: Archetype): FamilyRule => ({ family: a.name, patterns: a.title_patterns, ...(a.title_not ? { needs_not: a.title_not } : {}), ...(a.requires_signal ? { requires_signal: true } : {}) });
  const allow = ns.archetypes.filter((a) => a.fit !== 'adjacent').map(rule);
  const adjacent = ns.archetypes.filter((a) => a.fit === 'adjacent').map((a) => ({ ...rule(a), note: `${a.name} is an adjacent archetype (a stretch)` }));
  return {
    ...base,
    // A profile with only adjacent archetypes would leave `allow` empty, which the gate refuses: keep the shipped families then.
    allow: allow.length ? allow : base.allow,
    borderline: [...adjacent, ...base.borderline.filter((b) => !adjacent.some((x) => x.family === b.family))],
  };
}

const clean = (s: string) => s.replace(/[\r\n;]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
const list = (xs: string[], max = 12) => (xs.length ? xs.slice(0, max).map(clean).join(' | ') : 'none');

/**
 * The `North Star:` line a matcher prompt carries (the way `Target regions:` does). With the owner's section it lists archetypes with
 * their fit, the culture requirements, the dealbreakers and the comp (empty = "unknown", never a guess). Without it, the families of the
 * role gate stand in as the archetypes, so the model and the gate always read the same list.
 */
export function northStarLine(ns: NorthStar | null, gate: RoleGateConfig): string {
  if (!ns) {
    const names = gate.allow.map((f) => f.family);
    return `North Star: archetypes=${list(names)} (from config/role-families.json, all primary); require=none; deprioritize_if_absent=false; dealbreakers=none; comp=unknown`;
  }
  const arch = ns.archetypes.map((a) => `${clean(a.name)} (${a.fit}${a.level ? `, level ${clean(a.level)}` : ''}${a.signals?.length ? `, signals ${a.signals.slice(0, 8).map(clean).join('/')}` : ''})`);
  const c = ns.comp;
  const comp = c.target_range || c.minimum ? `${clean(c.currency)} target ${clean(c.target_range) || 'unknown'}, minimum ${clean(c.minimum) || 'unknown'}` : 'unknown';
  return `North Star: archetypes=${list(arch)}; require=${list(ns.require)}; deprioritize_if_absent=${ns.deprioritize_if_absent}; dealbreakers=${list(ns.dealbreakers)}; comp=${comp}`;
}
