import { isDryRun } from '../safety/dryRun.js';

// LinkedIn typed-tool config. Dry run follows the single master flag JOBBER_DRY_RUN (see isDryRun).
export interface LinkedinConfig {
  dryRun: boolean;
  acceptUnknown: boolean;
  maxAcceptsPerDay: number;
  maxSearchesPerDay: number;
  /** Priority order of the people-discovery layers (LINKEDIN_PEOPLE_SEARCH_SOURCES). */
  peopleSearchSources: PeopleSource[];
  allowedUrls: string[];
  allowedEmails: string[];
  idleMs: number;
  settleMs: number;
}

export type PeopleSource = 'engine' | 'google_pse' | 'tavily' | 'serper' | 'linkedin';
export const DEFAULT_PEOPLE_SOURCES: readonly PeopleSource[] = ['engine', 'google_pse', 'tavily', 'serper'];

// Comma list, order = priority; unknown entries and repeats are ignored; nothing valid gives the default.
export function parsePeopleSources(raw: string | undefined): PeopleSource[] {
  const out: PeopleSource[] = [];
  for (const p of (raw ?? '').split(',')) {
    const v = p.trim().toLowerCase();
    if ((v === 'engine' || v === 'google_pse' || v === 'tavily' || v === 'serper' || v === 'linkedin') && !out.includes(v)) out.push(v);
  }
  return out.length ? out : [...DEFAULT_PEOPLE_SOURCES];
}

const csv =(v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadLinkedinConfig(env: NodeJS.ProcessEnv = process.env): LinkedinConfig {
  const acc = env.LINKEDIN_MAX_ACCEPTS_PER_DAY;
  const accN = acc !== undefined && /^\d+$/.test(acc.trim()) ? Number(acc.trim()) : NaN;
  const sr = env.MAX_LINKEDIN_SEARCHES_PER_DAY;
  const srN = sr !== undefined && /^\d+$/.test(sr.trim()) ? Number(sr.trim()) : NaN;
  const idleRaw = env.LINKEDIN_IDLE_MS;
  const idleN = idleRaw !== undefined && /^\d+$/.test(idleRaw.trim()) ? Number(idleRaw.trim()) : 600000;
  return {
    dryRun: isDryRun(env),
    maxSearchesPerDay: Number.isInteger(srN) && srN >= 0 && srN <= 100000 ? srN : 10,
    peopleSearchSources: parsePeopleSources(env.LINKEDIN_PEOPLE_SEARCH_SOURCES),
    acceptUnknown: env.LINKEDIN_ACCEPT_UNKNOWN === 'true',
    maxAcceptsPerDay: Number.isInteger(accN) && accN >= 0 && accN <= 1000 ? accN : 30,
    allowedUrls: csv(env.LINKEDIN_ALLOWED_URLS),
    allowedEmails: csv(env.LINKEDIN_ALLOWED_EMAILS),
    idleMs: Math.min(3600000, Math.max(60000, idleN)),
    settleMs: 2500,
  };
}

/** A per-call flag can only force dry run ON. */
export function effectiveDryRun(cfg: LinkedinConfig, callFlag?: boolean): boolean {
  return cfg.dryRun || callFlag === true;
}
