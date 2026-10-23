// tests/settings-env-catalog.test.ts
// Plan 8H, Task 2: the real env catalog. Coverage against .env.example and LIMITS, the D22 rules over the whole
// list, restart evidence, text rules, blank-means-default proven against the real loaders, secrecy lists.
// Hermetic: reads repository files only, never .env (installNoRealEnv throws on it).
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installNoRealEnv } from './helpers/noRealEnv.js';
import { ENV_CATALOG, INTERNAL_NAMES } from '../src/settings/envCatalog.js';
import { fromLimit, limitWeakens } from '../src/settings/fromLimits.js';
import { loadDripConfig } from '../src/scheduler/mailDrip.js';
import { isSecret, type EnvSpec } from '../src/settings/types.js';
import { validateEnvValue, weakens } from '../src/settings/valueCheck.js';
import { LIMITS, type LimitSpec } from '../src/setup/limitsCatalog.js';
import { APPLY_HOST_PLATFORM_IDS, hostCapKey, resolveHostCap, TOP_LEVEL_KEY } from '../src/webcore/hostCaps.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { validateRunnerConfig } from '../src/web/env.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());

const ROOT = join(import.meta.dirname, '..');
const by = new Map(ENV_CATALOG.map((s) => [s.key, s]));
const spec = (k: string): EnvSpec => {
  const s = by.get(k);
  if (!s) throw new Error(`catalog has no ${k}`);
  return s;
};

// ---- .env.example parse (same key regex as tests/env-example-complete.test.ts, minus prose mentions) ----
const exampleLines = readFileSync(join(ROOT, '.env.example'), 'utf8').split(/\r?\n/);
function exampleKeys(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const l of exampleLines) {
    const m = /^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(l);
    if (!m) continue;
    if (m[1] !== undefined && /[A-Za-z]\.$/.test(m[3]!)) continue; // a sentence such as "# WEB_CHAT_ENABLED=true."
    const active = m[1] === undefined;
    out.set(m[2]!, (out.get(m[2]!) ?? false) || active);
  }
  return out;
}

const RANK: Record<string, number> = { normal: 0, guarded: 1, safety: 2, never: 3 };

describe('catalog shape', () => {
  it('has unique keys', () => {
    expect(ENV_CATALOG.length).toBe(by.size);
  });
  it('every default passes its own validation', () => {
    const bad = ENV_CATALOG.filter((s) => s.default !== null && validateEnvValue(s, s.default) !== null).map((s) => s.key);
    expect(bad).toEqual([]);
  });
  it('conditional keys name a real key in the "KEY is value" form', () => {
    for (const s of ENV_CATALOG.filter((x) => x.required === 'conditional')) {
      const m = /^([A-Z][A-Z0-9_]*) is (\S+)$/.exec(s.requiredWhen ?? '');
      expect(m, s.key).not.toBeNull();
      expect(by.has(m![1]!), `${s.key} -> ${m![1]}`).toBe(true);
    }
  });
  it('weakens directions fit the key type', () => {
    for (const s of ENV_CATALOG) {
      if (s.weakens === 'true' || s.weakens === 'false') expect(s.type, s.key).toBe('bool');
      if (s.weakens === 'increase' || s.weakens === 'decrease') expect(['int', 'intList'], s.key).toContain(s.type);
    }
  });
  it('puts the contact finding keys in their own section', () => {
    for (const k of ['SERPER_API_KEY', 'HUNTER_API_KEY', 'HUNTER_ENABLED', 'HUNTER_MONTHLY_CAP', 'SERPER_DAILY_BUDGET', 'SERPER_MONTHLY_BUDGET', 'DORK_DAILY_BUDGET', 'DORK_ENABLED']) {
      expect(spec(k).section, k).toBe('contact-finding');
    }
  });
});

describe('coverage', () => {
  const ex = exampleKeys();
  it('every key in .env.example is in the catalog', () => {
    expect([...ex.keys()].filter((k) => !by.has(k))).toEqual([]);
  });
  it('every catalog key is in .env.example (the file is generated from the catalog)', () => {
    expect(ENV_CATALOG.map((s) => s.key).filter((k) => !ex.has(k)).sort()).toEqual([]);
    for (const k of ['WEB_SETTINGS_EDIT', 'WEB_SETTINGS_REMOTE_SAFETY', 'SETTINGS_BACKUP_KEEP']) {
      expect(ex.has(k), k).toBe(true);
    }
  });
  it('exampleActive matches the KEY= versus # KEY= marker', () => {
    const bad = [...ex].filter(([k, active]) => by.get(k)!.exampleActive !== active).map(([k]) => k);
    expect(bad).toEqual([]);
  });
  it('covers every LIMITS key with identical default, min and max', () => {
    for (const l of LIMITS) {
      const s = spec(l.key);
      expect(s.default, l.key).toBe(String(l.default));
      expect(s.min, l.key).toBe(l.min);
      expect(s.max, l.key).toBe(l.max);
      expect(s.about, l.key).toContain(l.what);
    }
  });
  it('covers the per-host cap family: the top level key and one explicit key per platform id', () => {
    expect(by.has(TOP_LEVEL_KEY)).toBe(true);
    for (const id of APPLY_HOST_PLATFORM_IDS) expect(by.has(hostCapKey(id)), id).toBe(true);
    for (const s of ENV_CATALOG.filter((x) => x.key.startsWith(`${TOP_LEVEL_KEY}_`))) {
      expect(APPLY_HOST_PLATFORM_IDS.some((id) => hostCapKey(id) === s.key), s.key).toBe(true);
    }
  });
  it('keeps the INTERNAL names out of the catalog', () => {
    for (const n of Object.keys(INTERNAL_NAMES)) expect(by.has(n), n).toBe(false);
    for (const [n, why] of Object.entries(INTERNAL_NAMES)) expect(why.length, n).toBeGreaterThan(5);
  });
  it('lists the 8G, 8E, 8F and webcore keys', () => {
    for (const k of [
      'JOBBER_DRY_RUN', 'APPLY_ALLOW_ACCOUNT_CREATION', 'SCOUT_ALLOW_SIGNUP',
      'APPLY_ALLOW_UNKNOWN_HOSTS', 'APPLY_LINKEDIN_EASY', 'APPLY_SUBMIT_MODE', 'APPLY_ACCEPT_LEGAL_REQUIRED',
      'APPLY_SCREENSHOT', 'APPLY_RECIPE_PROMOTE_N', 'APPLY_RECIPE_PROMOTE_RUNS', 'SITE_MAIL_VERIFY', 'SITE_MAIL_SENDERS',
      'SITE_ACCOUNTS_FILE', 'WEB_MIN_GAP_SEC', 'WEB_MAX_CALLS_PER_JOB', 'WEB_MAX_JOB_MIN', 'WEB_IDLE_MS', 'WEB_SETTLE_MS',
      'GEN_PROVIDER_MIN_JOBS', 'GEN_PROVIDER_PROMOTE_N', 'DORK_BLOCK_COOLDOWN_HOURS', 'SEARCH_CACHE_TTL_DAYS',
      'LAYOUT_ENFORCE', 'LAYOUT_DIR', 'LAYOUT_EXPLORE_BUDGET', 'WEB_SETTINGS_EDIT', 'WEB_SETTINGS_REMOTE_SAFETY',
      'SETTINGS_BACKUP_KEEP',
    ]) expect(by.has(k), k).toBe(true);
  });
});

describe('fromLimit', () => {
  const base: LimitSpec = { key: 'X_CAP', group: 'daily-caps', default: 5, min: 0, max: 9, unit: 'per day', what: 'Things per day.' };
  it('maps default, range, meaning and the raise note', () => {
    const s = fromLimit({ ...base, raiseNote: 'More is risky.' });
    expect(s).toMatchObject({ key: 'X_CAP', type: 'int', default: '5', min: 0, max: 9, tier: 'guarded', weakens: 'increase', note: 'More is risky.' });
    expect(s.about).toContain('Things per day.');
    expect(fromLimit(base).tier).toBe('guarded');
  });
  it('makes a comma list an intList with its item count', () => {
    const s = fromLimit({ ...base, key: 'X_GAPS_DAYS', default: '3,4,5', min: 1, max: 365 });
    expect(s).toMatchObject({ type: 'intList', itemCount: 3, default: '3,4,5', auditValue: false });
  });
  it('picks the weakening direction from a small override map', () => {
    for (const k of ['MATCH_THRESHOLD', 'PACING_MIN_ACTION_GAP_SEC', 'PACING_JITTER_PCT','COOLDOWN_NOT_NOW_DAYS', 'EMAIL_FOLLOWUP_GAPS_DAYS', 'CADENCE_GAPS_DAYS']) {
      expect(limitWeakens(k), k).toBe('decrease');
    }
    for (const k of ['QUIET_HOURS_START', 'QUIET_HOURS_END']) expect(limitWeakens(k), k).toBe('any');
    expect(limitWeakens('SEND_LIMIT_PER_RUN')).toBe('increase');
  });
});

describe('rules (D22) over the whole catalog', () => {
  it('JOBBER_DRY_RUN is the ONLY *_DRY_RUN key: safety, in the safety section, with a direction and a non-null default', () => {
    const dry = ENV_CATALOG.filter((s) => s.key.endsWith('_DRY_RUN'));
    expect(dry.map((s) => s.key)).toEqual(['JOBBER_DRY_RUN']);
    for (const s of dry) {
      expect(s.tier, s.key).toBe('safety');
      expect(s.section, s.key).toBe('safety');
      expect(s.weakens, s.key).not.toBeNull();
      expect(s.default, s.key).not.toBeNull();
      // dry (true, 1, any case) turned off is a weakening change; unset already means live, so it is not one
      for (const off of ['false', '0', '', 'no']) expect(weakens(s, 'true', off), off).toBe(true);
      expect(weakens(s, ' TRUE ', 'false')).toBe(true);
      expect(weakens(s, undefined, 'false')).toBe(false);
      expect(weakens(s, 'false', 'true')).toBe(false);
      expect(s.default).toBe('false');
    }
  });
  it('every path key and every *_CMD, *_PATH, *_REMOTE, *_DIR key is never', () => {
    const hit = ENV_CATALOG.filter((s) => s.type === 'path' || /(_CMD|_PATH|_REMOTE|_DIR)$/.test(s.key));
    expect(hit.length).toBeGreaterThan(8);
    for (const s of hit) expect(s.tier, s.key).toBe('never');
  });
  it('every LIMITS key is guarded or stricter, with a weakening direction', () => {
    for (const l of LIMITS) {
      expect(RANK[spec(l.key).tier]!, l.key).toBeGreaterThanOrEqual(RANK.guarded!);
      expect(spec(l.key).weakens, l.key).not.toBeNull();
    }
    expect(spec('PACING_MAX_WAIT_MIN').weakens).toBe('increase');
    expect(spec('PACING_MAX_BURST').weakens).toBe('increase');
  });
  it('no never key has a weakening direction', () => {
    for (const s of ENV_CATALOG.filter((x) => x.tier === 'never')) expect(s.weakens, s.key).toBeNull();
  });
  it('the never set is exactly the plan list plus the reviewed additions', () => {
    const PLAN = [
      'WEB_AUTH_MODE', 'WEB_AUTH_DB', 'WEB_BIND', 'WEB_PORT', 'WEB_ALLOW_REMOTE_BIND', 'WEB_ALLOWED_HOSTS', 'WEB_TRUST_PROXY',
      'WEB_REAUTH_MAX_AGE_SEC', 'WEB_CHAT_ENABLED', 'WEB_TMUX_SESSION', 'WEB_TMUX_WINDOW', 'WEB_OIDC_ISSUER', 'WEB_OIDC_CLIENT_ID',
      'WEB_OIDC_CLIENT_SECRET', 'WEB_OIDC_REDIRECT_URI', 'WEB_OIDC_REAUTH_PROMPT', 'WEB_GOOGLE_KEYS_PATH', 'WEB_GOOGLE_REDIRECT_SHAPE',
      'DASHBOARD_ALLOWED_EMAIL', 'WEB_SETTINGS_EDIT', 'WEB_SETTINGS_REMOTE_SAFETY',
      'JOBBER_KILL', 'JOBBER_NOTIFY_CMD', 'TELEGRAM_BOT_TOKEN', 'ALLOWED_USERS', 'CCGRAM_DAEMON_SESSION', 'MANAGER_TMUX_SESSION',
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CLI_PATH', 'GMAIL_OAUTH_PATH', 'GMAIL_CREDENTIALS_PATH',
      'JOBAPPLIER_USER_DATA', 'LAYOUT_DIR', 'SCHEDULER_NO_CLASSIFIER', 'AUTO_UPDATE_REMOTE', 'AUTO_UPDATE_BRANCH',
      'AUTO_UPDATE_TAG_PATTERN', 'AUTO_UPDATE_REQUIRE_SIGNED', 'AUTO_UPDATE_SIGNERS_FILE', 'AUTO_UPDATE_REVIEW_PATHS', 'BACKUP_DIR',
      'BACKUP_AGE_RECIPIENT', 'BACKUP_RCLONE_REMOTE', 'BACKUP_INCLUDE_SECRETS',
    ];
    // Reviewed additions: a path rule hit (SITE_ACCOUNTS_FILE) and tmux session names (R_SESSION, same risk as WEB_TMUX_*).
    const ADDED = ['SITE_ACCOUNTS_FILE', 'SCHEDULER_TMUX_SESSION', 'STACK_TMUX_SESSION', 'WEB_APPLY_REQUEST_ENABLED'];
    for (const k of PLAN) expect(spec(k).tier, k).toBe('never');
    const never = ENV_CATALOG.filter((s) => s.tier === 'never').map((s) => s.key).sort();
    expect(never).toEqual([...PLAN, ...ADDED].sort());
  });
  it('the safety tier holds every key the plan lists as safety', () => {
    for (const k of [
      'JOBBER_DRY_RUN', 'FOLLOWUPS_AUTONOMOUS', 'SCHEDULER_ENABLED', 'AUTO_UPDATE',
      'BACKUP_ENABLED', 'HUNTER_ENABLED', 'LINKEDIN_ACCEPT_UNKNOWN', 'LINKEDIN_ALLOWED_URLS', 'LINKEDIN_ALLOWED_EMAILS',
      'CLASSIFIER_MODEL', 'LAYOUT_ENFORCE', 'APPLY_ALLOW_ACCOUNT_CREATION', 'SCOUT_ALLOW_SIGNUP', 'APPLY_ALLOW_UNKNOWN_HOSTS',
      'APPLY_LINKEDIN_EASY', 'APPLY_SUBMIT_MODE', 'APPLY_ACCEPT_LEGAL_REQUIRED', 'SITE_MAIL_VERIFY', 'SITE_MAIL_SENDERS',
    ]) {
      expect(spec(k).tier, k).toBe('safety');
      expect(spec(k).weakens, k).not.toBeNull();
    }
  });
  it('the guarded tier holds the plan budgets and caps', () => {
    for (const k of [
      'MATCH_THRESHOLD', 'RUN_MAX_WALL_SEC', 'RUN_MAX_TOKENS_APPROX', 'FOLLOWUP_CHECK_MAX_AGE_MIN',
      'HUNTER_MONTHLY_CAP', 'SERPER_DAILY_BUDGET', 'SERPER_MONTHLY_BUDGET', 'DORK_DAILY_BUDGET', 'APPLY_MAX_ATTEMPTS_PER_DAY',
      'SITE_MAX_ACCOUNTS_PER_DAY', TOP_LEVEL_KEY,
    ]) {
      expect(RANK[spec(k).tier]!, k).toBeGreaterThanOrEqual(RANK.guarded!);
      expect(spec(k).weakens, k).not.toBeNull();
    }
  });
  it('secrets: tier is never unless it is an API key for a fixed vendor host', () => {
    const VENDOR = ['GMAIL_APP_PASSWORD', 'HUNTER_API_KEY', 'SERPER_API_KEY'];
    for (const s of ENV_CATALOG.filter(isSecret)) {
      if (!VENDOR.includes(s.key)) expect(s.tier, s.key).toBe('never');
    }
    for (const k of VENDOR) expect(spec(k).tier, k).toBe('normal');
  });
});

describe('secrets', () => {
  it('secret flag equals (type === "secret") for every key', () => {
    for (const s of ENV_CATALOG) expect(s.secret, s.key).toBe(s.type === 'secret');
  });
  it('isSecret is the one test: flag or type', () => {
    const s = spec('SERPER_API_KEY');
    expect(isSecret(s)).toBe(true);
    expect(isSecret({ ...s, secret: false })).toBe(true);
    expect(isSecret({ ...s, type: 'string' })).toBe(true);
    expect(isSecret({ secret: false, type: 'string' })).toBe(false);
  });
  it('the secret keys are exactly this list (credentialed url and command keys included)', () => {
    expect(ENV_CATALOG.filter(isSecret).map((s) => s.key).sort()).toEqual([
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'GMAIL_APP_PASSWORD', 'HUNTER_API_KEY',
      'JOBBER_NOTIFY_CMD', 'SERPER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'WEB_OIDC_CLIENT_SECRET',
    ]);
  });
  it('CLASSIFIER_MODEL is not a secret', () => {
    expect(isSecret(spec('CLASSIFIER_MODEL'))).toBe(false);
  });
  it('every key the old name regex masked is a secret or an explicit, reviewed false positive', () => {
    const OLD = /TOKEN|SECRET|PASS|KEY|COOKIE|CREDENTIAL|AUTH/i;
    const FALSE_POSITIVE = [
      'BACKUP_INCLUDE_SECRETS', 'GMAIL_CREDENTIALS_PATH', 'GMAIL_OAUTH_PATH', 'WEB_AUTH_DB', 'WEB_AUTH_MODE',
      'RUN_MAX_TOKENS_APPROX', 'WEB_GOOGLE_KEYS_PATH', 'WEB_OIDC_REAUTH_PROMPT', 'WEB_REAUTH_MAX_AGE_SEC',
    ];
    const masked = ENV_CATALOG.filter((s) => OLD.test(s.key));
    for (const s of masked) expect(isSecret(s) || FALSE_POSITIVE.includes(s.key), s.key).toBe(true);
    for (const k of FALSE_POSITIVE) {
      expect(OLD.test(k), k).toBe(true);
      expect(isSecret(spec(k)), k).toBe(false);
    }
  });
  it('a secret has no default, is not audited by value and its text carries no example value', () => {
    for (const s of ENV_CATALOG.filter(isSecret)) {
      expect(s.default, s.key).toBeNull();
      expect(s.auditValue, s.key).toBe(false);
      expect(s.about, s.key).not.toMatch(/[A-Za-z0-9+/_-]{24,}/);
      expect(s.about, s.key).not.toMatch(/FIXTURE-SECRET/);
    }
  });
});

describe('restart', () => {
  it('a scope other than stack names an existing reader file', () => {
    for (const s of ENV_CATALOG.filter((x) => x.restart !== 'stack')) {
      expect(s.restartEvidence, s.key).toBeTruthy();
      expect(existsSync(join(ROOT, s.restartEvidence!)), `${s.key}: ${s.restartEvidence}`).toBe(true);
    }
  });
  it('the narrow scopes are used where the evidence is, and the rest default to stack', () => {
    for (const s of ENV_CATALOG.filter((x) => x.section === 'dashboard')) expect(s.restart, s.key).toBe('dashboard');
    expect(ENV_CATALOG.filter((s) => s.restart === 'stack').length).toBeGreaterThan(60);
    for (const s of ENV_CATALOG.filter((x) => x.restart === 'stack')) expect(s.restartEvidence, s.key).toBeUndefined();
  });
});

describe('text', () => {
  it('every entry has about (at most 600 characters), feature and tierReason, with no em or en dashes', () => {
    for (const s of ENV_CATALOG) {
      expect(s.about.trim().length, s.key).toBeGreaterThan(0);
      expect(s.about.length, s.key).toBeLessThanOrEqual(600);
      expect(s.feature.trim(), s.key).not.toBe('');
      expect(s.tierReason.trim(), s.key).not.toBe('');
      for (const t of [s.about, s.feature, s.tierReason, s.note ?? '']) expect(t, s.key).not.toMatch(/[–—]/);
    }
  });
});

describe('classifier ids', () => {
  it('CLASSIFIER_MODEL allows exactly the profile ids in config/classifier-models.json', () => {
    const j = JSON.parse(readFileSync(join(ROOT, 'config/classifier-models.json'), 'utf8')) as Record<string, unknown>;
    const ids = Object.keys((j.profiles as Record<string, unknown> | undefined) ?? j);
    expect([...(spec('CLASSIFIER_MODEL').allowed ?? [])].sort()).toEqual(ids.sort());
  });
});

// ---- blankMeansDefault: true only where a real loader treats KEY= exactly like an absent key ----
const alt = (s: EnvSpec): string => {
  if (s.type === 'enum') return s.allowed!.find((a) => a !== s.default)!;
  if (s.type === 'path') return 'blank-test-dir';
  if (s.type === 'string') return String(Number(s.default) - 0.1);
  if (s.type === 'intList') {
    const parts = s.default!.split(',').map(Number);
    parts[0] = parts[0]! + 1;
    return parts.join(',');
  }
  return String(Number(s.default) + 1);
};

describe('blankMeansDefault (real loaders)', () => {
  type Loader = (env: Record<string, string>) => unknown;
  const outreach: Loader = (e) => loadOutreachConfig(e);
  const tuning: Loader = (e) => loadTuning(e);
  const layout: Loader = (e) => loadLayoutConfig(e);
  const hostCap = (id: string): Loader => (e) => resolveHostCap(id, e);

  const OUTREACH_KEYS = [
    'LINKEDIN_MAX_INVITES_PER_WEEK', 'LINKEDIN_MAX_MESSAGES_PER_WEEK', 'NAUKRI_MAX_APPLIES_PER_DAY', 'NAUKRI_MAX_MESSAGES_PER_DAY',
    'WELLFOUND_MAX_APPLIES_PER_DAY', 'WELLFOUND_MAX_MESSAGES_PER_DAY', 'WELLFOUND_MAX_DISCOVER_PER_DAY',
    'APPLY_MAX_ATTEMPTS_PER_DAY', 'SITE_MAX_ACCOUNTS_PER_DAY', 'LINKEDIN_MAX_DISCOVER_PER_DAY', 'COMPANY_CONTACT_LIMIT',
    'SPECULATIVE_COMPANY_LIMIT', 'QUIET_HOURS_START', 'QUIET_HOURS_END',
  ];
  const TUNING_KEYS = [
    'PACING_MIN_BURST', 'PACING_MAX_BURST', 'PACING_MIN_ACTION_GAP_SEC', 'PACING_MAX_ACTION_GAP_SEC', 'PACING_MIN_WAIT_MIN',
    'PACING_MAX_WAIT_MIN', 'PACING_JITTER_PCT', 'COOLDOWN_IGNORED_DAYS', 'COOLDOWN_NOT_NOW_DAYS', 'COOLDOWN_EXPLICIT_STOP_DAYS',
    'CADENCE_GAPS_DAYS',
  ];
  const DRIP_KEYS = ['EMAIL_MAX_PER_DAY', 'EMAIL_DRIP_MIN_BATCH', 'EMAIL_DRIP_MAX_BATCH', 'EMAIL_DRIP_MIN_GAP_MIN', 'EMAIL_DRIP_MAX_GAP_MIN', 'EMAIL_DRIP_INTRA_PAUSE_MIN_SEC', 'EMAIL_DRIP_INTRA_PAUSE_MAX_SEC'];
  const LAYOUT_KEYS = ENV_CATALOG.filter((s) => s.key.startsWith('LAYOUT_')).map((s) => s.key);
  const HOST_KEYS: Array<[string, string]> = [[TOP_LEVEL_KEY, 'greenhouse'], ...APPLY_HOST_PLATFORM_IDS.map((id): [string, string] => [hostCapKey(id), id])];

  const cases: Array<[string, Loader]> = [
    ...OUTREACH_KEYS.map((k): [string, Loader] => [k, outreach]),
    ...TUNING_KEYS.map((k): [string, Loader] => [k, tuning]),
    ...LAYOUT_KEYS.map((k): [string, Loader] => [k, layout]),
    ...HOST_KEYS.map(([k, id]): [string, Loader] => [k, hostCap(id)]),
    ...DRIP_KEYS.map((k): [string, Loader] => [k, (e) => loadDripConfig(e)]),
  ];

  it('each covered loader reads the key and treats blank like unset', () => {
    for (const [k, load] of cases) {
      const s = spec(k);
      expect(load({ [k]: '' }), `${k} blank`).toEqual(load({}));
      expect(load({ [k]: alt(s) }), `${k} is read by its loader`).not.toEqual(load({}));
    }
  });
  const RUNNER_KEYS = ['WEB_PORT', 'WEB_BIND', 'WEB_ALLOWED_HOSTS', 'WEB_TMUX_SESSION', 'WEB_TMUX_WINDOW', 'SETTINGS_BACKUP_KEEP', 'WEB_SETTINGS_EDIT'];
  it('the dashboard runner config treats blank like unset for its covered keys', () => {
    const run = (e: Record<string, string>): unknown => validateRunnerConfig(e, { accountStored: true });
    for (const k of RUNNER_KEYS) expect(run({ [k]: '' }), k).toEqual(run({}));
  });
  it('the catalog marks exactly the loader-covered keys', () => {
    const covered = new Set([...cases.map(([k]) => k), ...RUNNER_KEYS]);
    const marked = ENV_CATALOG.filter((s) => s.blankMeansDefault).map((s) => s.key).sort();
    expect(marked).toEqual([...covered].sort());
  });
  it('dry-run flags and secrets are never blank-means-default', () => {
    for (const s of ENV_CATALOG.filter((x) => x.key.endsWith('_DRY_RUN') || isSecret(x))) expect(s.blankMeansDefault, s.key).toBe(false);
  });
});
