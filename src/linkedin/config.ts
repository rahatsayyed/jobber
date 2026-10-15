import { isDryRun } from '../safety/dryRun.js';

// LinkedIn typed-tool config. Dry run is ON unless LINKEDIN_DRY_RUN and SCHEDULER_DRY_RUN are
// exactly 'false' and JOBBER_DRY_RUN is not '1' (see isDryRun).
export interface LinkedinConfig {
  dryRun: boolean;
  acceptUnknown: boolean;
  maxAcceptsPerDay: number;
  maxSearchesPerDay: number;
  allowedUrls: string[];
  allowedEmails: string[];
  idleMs: number;
  settleMs: number;
}

const csv = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadLinkedinConfig(env: NodeJS.ProcessEnv = process.env): LinkedinConfig {
  const acc = env.LINKEDIN_MAX_ACCEPTS_PER_DAY;
  const accN = acc !== undefined && /^\d+$/.test(acc.trim()) ? Number(acc.trim()) : NaN;
  const sr = env.MAX_LINKEDIN_SEARCHES_PER_DAY;
  const srN = sr !== undefined && /^\d+$/.test(sr.trim()) ? Number(sr.trim()) : NaN;
  const idleRaw = env.LINKEDIN_IDLE_MS;
  const idleN = idleRaw !== undefined && /^\d+$/.test(idleRaw.trim()) ? Number(idleRaw.trim()) : 600000;
  return {
    dryRun: isDryRun(env, { linkedin: true }),
    maxSearchesPerDay: Number.isInteger(srN) && srN >= 0 && srN <= 1000 ? srN : 20,
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
