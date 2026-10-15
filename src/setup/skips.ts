// src/setup/skips.ts
// Single catalog of skippable setup features: what "configured" means, what is lost, and which
// doctor check ids the wrapper may turn into a skip. Pure: env and fs are passed in.
import { isAbsolute, join } from 'node:path';
import type { SetupState } from './state.js';

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
      'No phone control (/runhunt, /status, /checkreplies), no Telegram alerts or cap-overrun prompts.',
      'Legacy-mode follow-ups cannot be approved, so none are sent.',
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
    configured: (env) =>
      set(env, 'WEB_AUTH_MODE') || set(env, 'WEB_OIDC_CLIENT_ID') || set(env, 'DASHBOARD_ALLOWED_EMAIL'),
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
      'Adzuna: one job source off. Serper: fewer verified contacts.',
      'Hunter: last-resort email lookup stays off.',
    ],
    checkIds: ['api-keys'],
    configured: (env) =>
      (set(env, 'ADZUNA_APP_ID') && set(env, 'ADZUNA_APP_KEY')) ||
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
