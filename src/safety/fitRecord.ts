// src/safety/fitRecord.ts: pure helpers for scripts/classifier/fit.ts
import type { ClassifierRegistry, ProfileFit } from './classifierRegistry.js';

export interface FitArgs {
  profileId: string;
  write: boolean;
  forceSmall: boolean;
  maxFpr: number;
  seed: string;
  heldFrac: number;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseFitArgs(argv: string[], env: NodeJS.ProcessEnv, reg: ClassifierRegistry): FitArgs {
  const opt = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  const pi = argv.indexOf('--profile');
  if (pi >= 0 && opt('--profile') === undefined) throw new Error('--profile requires a value');
  const profileId = (opt('--profile') ?? env.CLASSIFIER_MODEL ?? '').trim();
  const known = Object.keys(reg.profiles);
  if (argv.includes('--pin')) throw new Error(`use: npm run models -- pin ${profileId || '<id>'}`);
  if (!profileId) throw new Error(`no profile: pass --profile <id> or set CLASSIFIER_MODEL (known: ${known.join(', ')})`);
  if (!ID_RE.test(profileId) || !Object.prototype.hasOwnProperty.call(reg.profiles, profileId)) {
    throw new Error(`unknown profile "${profileId}"; known profiles: ${known.join(', ')}`);
  }
  const num = (name: string, d: string, lo: number, hi: number): number => {
    const v = Number(opt(name) ?? d);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} must be a number in [${lo}, ${hi}]`);
    return v;
  };
  return {
    profileId,
    write: argv.includes('--write'),
    forceSmall: argv.includes('--force-small'),
    maxFpr: num('--max-fpr', '0.01', 0, 1),
    seed: opt('--seed') ?? 'jobber-2026-10',
    heldFrac: num('--held-out', '0.3', 0, 1),
  };
}

export interface FitRecordInput {
  threshold: number;
  modelSha256: string;
  maxFpr: number;
  held: { tpr: number; fpr: number; n: number; byCategory: Record<string, { n: number; tpr: number }> };
  attacks: number;
  benign: number;
  seed: string;
  heldFrac: number;
  now?: Date;
}

export function buildFitRecord(i: FitRecordInput): ProfileFit {
  const by_category: Record<string, { n: number; tpr: number }> = {};
  for (const [c, v] of Object.entries(i.held.byCategory)) by_category[c] = { n: v.n, tpr: v.tpr };
  return {
    threshold: i.threshold,
    fitted_at: (i.now ?? new Date()).toISOString(),
    model_sha256: i.modelSha256,
    max_benign_fpr: i.maxFpr,
    held_out: { tpr: i.held.tpr, fpr: i.held.fpr, n: i.held.n },
    corpus: { attacks: i.attacks, benign: i.benign, seed: i.seed, held_out_fraction: i.heldFrac },
    by_category,
  };
}

/** A threshold is not written from fewer than 20 benign or 10 attack held-out items. */
export const heldOutTooSmall = (benign: number, attack: number): boolean => benign < 20 || attack < 10;
