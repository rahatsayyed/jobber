// src/setup/skips.ts
// Single catalog of skippable setup features: what "configured" means, what is lost, and which
// doctor check ids the wrapper may turn into a skip. Pure: env and fs are passed in.
import { isAbsolute, join } from 'node:path';
import type { SetupState } from './state.js';
import { loadState } from './state.js';
import type { Check, CheckResult, DoctorContext } from '../platform/doctor.js';
import { skip } from '../platform/doctor.js';
import { parseEnv } from '../platform/envFile.js';
import { userDataDir } from '../lib/userData.js';
import { readAuthToken } from '../dash/authRead.js';
import { authDbPathFromEnv } from '../web/env.js';

export type SkippableId = 'telegram' | 'dashboard' | 'gmail' | 'apikeys';

export interface SkipFs {
  exists(p: string): boolean;
}

export interface SkipSpec {
  id: SkippableId;
  stepId: string;
  title: string;
  label: 'RECOMMENDED' | 'NEEDED FOR EMAIL OUTREACH' | 'OPTIONAL';
  lose: string[];
  checkIds: string[];
  configured(env: Record<string, string | undefined>, fs: SkipFs, root: string): boolean;
}

const set = (env: Record<string, string | undefined>, k: string): boolean =>
  (env[k] ?? '').trim() !== '';

export const SKIP_SPECS: readonly SkipSpec[] = [
  {
    id: 'telegram',
    stepId: 'telegram',
    title: 'Telegram',
    label: 'RECOMMENDED',
    lose: [
      'No phone control: you cannot start a hunt or ask for status from Telegram.',
      'No Telegram alerts, and email follow-ups cannot be approved, so none are sent.',
    ],
    checkIds: ['telegram-api', 'ccgram-env', 'daemon'],
    configured: (env) => set(env, 'TELEGRAM_BOT_TOKEN'),
  },
  {
    id: 'dashboard',
    stepId: 'dashboard',
    title: 'Dashboard',
    label: 'RECOMMENDED',
    lose: [
      'No status page in a browser.',
      '/limits, /working, /health and npm run status still work.',
    ],
    checkIds: ['web', 'dashboard-login'],
    // WEB_AUTH_MODE=token is the shipped .env.example default, so it is not a deliberate choice;
    // only oidc or google_desktop (or a client id or allowed email) counts as configured.
    // A stored access token in the auth store also counts (finding 11): it is the same state
    // `npm run dashboard -- status` reports, read by the one shared helper.
    configured: (env, fs, root) => {
      const mode = (env.WEB_AUTH_MODE ?? '').trim().toLowerCase();
      if (
        mode === 'oidc' || mode === 'google_desktop' ||
        set(env, 'WEB_OIDC_CLIENT_ID') || set(env, 'DASHBOARD_ALLOWED_EMAIL')
      ) return true;
      const rel = authDbPathFromEnv(env);
      const p = isAbsolute(rel) ? rel : join(root, rel);
      return fs.exists(p) && readAuthToken(p)?.set === true;
    },
  },
  {
    id: 'gmail',
    stepId: 'gmail',
    title: 'Gmail',
    label: 'NEEDED FOR EMAIL OUTREACH',
    lose: [
      'No cold email, no email follow-ups and no reply watching.',
      'LinkedIn and Naukri outreach still run.',
    ],
    checkIds: ['gmail-oauth'],
    configured: (env, fs, root) => {
      const v = (env.GMAIL_OAUTH_PATH ?? '').trim() || './secrets/gcp-oauth.keys.json';
      return fs.exists(isAbsolute(v) ? v : join(root, v));
    },
  },
  {
    id: 'apikeys',
    stepId: 'apikeys',
    title: 'Optional API keys',
    label: 'OPTIONAL',
    lose: [
      'Serper and Hunter: contact finding has fewer verified contacts.',
      'Hunter: last-resort email lookup stays off.',
    ],
    checkIds: ['api-keys'],
    configured: (env) =>
      set(env, 'SERPER_API_KEY') ||
      set(env, 'HUNTER_API_KEY'),
  },
];

/** Features whose step is recorded as skipped and that are still unconfigured (D5, D6). */
export function skippedFeatures(input: {
  state: SetupState;
  env: Record<string, string | undefined>;
  fs: SkipFs;
  root: string;
}): SkippableId[] {
  return SKIP_SPECS.filter(
    (s) => input.state.steps[s.stepId]?.status === 'skipped' && !s.configured(input.env, input.fs, input.root),
  ).map((s) => s.id);
}

// Doctor integration (plan 8F task 2).

const cache = new WeakMap<object, SkippableId[]>();

/**
 * Skipped, still unconfigured features for a project root: process env over .env, state from the
 * user-data setup state. Read-only; any read problem gives an empty list (nothing is skipped).
 */
export function skippedForRoot(input: {
  root: string;
  env: Record<string, string | undefined>;
  fs: { exists(p: string): boolean; read?(p: string): string };
}): SkippableId[] {
  try {
    const read = input.fs.read;
    if (!read) return [];
    const rd = { exists: (p: string) => input.fs.exists(p), read: (p: string) => read(p) };
    let fileEnv: Record<string, string> = {};
    const envPath = join(input.root, '.env');
    if (rd.exists(envPath)) fileEnv = parseEnv(rd.read(envPath));
    const env: Record<string, string | undefined> = { ...fileEnv, ...input.env };
    const state = loadState(join(userDataDir(input.env as NodeJS.ProcessEnv, input.root), '.setup-state.json'), rd);
    return skippedFeatures({ state, env, fs: rd, root: input.root });
  } catch {
    return [];
  }
}

/** Skipped, still unconfigured features, computed once per doctor context (process env over .env). */
export function skippedFromContext(ctx: DoctorContext): SkippableId[] {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const out = skippedForRoot({ root: ctx.root, env: ctx.env, fs: ctx.fs });
  cache.set(ctx, out);
  return out;
}

/** Wrap checks: a fail or warn of an allowlisted check of a skipped feature becomes a skip. */
export function withSkips(checks: Check[]): Check[] {
  return checks.map((check) => {
    const spec = SKIP_SPECS.find((s) => s.checkIds.includes(check.id));
    if (!spec) return check;
    return {
      id: check.id,
      title: check.title,
      async run(ctx: DoctorContext): Promise<CheckResult> {
        const res = await check.run(ctx);
        if (res.status !== 'fail' && res.status !== 'warn') return res;
        if (!skippedFromContext(ctx).includes(spec.id)) return res;
        return skip(
          `skipped in setup (${spec.title}, ${spec.label}). ${spec.lose[0]}`,
          `npm run setup -- --step ${spec.stepId}`,
        );
      },
    };
  });
}

/** Last line of the doctor text output, or an empty string when nothing is skipped. */
export function skipSummary(skipped: SkippableId[]): string {
  if (skipped.length === 0) return '';
  return `Skipped by choice: ${skipped.join(', ')}. Re-enable: npm run setup -- --step <id>`;
}
