// tests/fixtures/settings/catalog.fixture.ts
// Small invented catalog (EnvSpec[]) for the settings editor tests. Secrets have default null and
// no secret VALUE lives here; tests use FIXTURE-SECRET-<n> strings they build themselves.
import type { EnvSpec, EnvType, SectionId } from '../../../src/settings/types.js';

function spec(p: Partial<EnvSpec> & { key: string; type: EnvType; section: SectionId }): EnvSpec {
  return {
    feature: 'fixture',
    default: null,
    exampleActive: false,
    required: 'optional',
    secret: false,
    tier: 'normal',
    tierReason: 'fixture',
    weakens: null,
    restart: 'next_run',
    blankMeansDefault: true,
    about: `Fixture key ${p.key}.`,
    auditValue: true,
    ...p,
  };
}

export const FIXTURE_CATALOG: EnvSpec[] = [
  // bool
  spec({ key: 'FX_FLAG', type: 'bool', section: 'web-core', default: 'false', exampleActive: true }),
  spec({ key: 'FX_DRY_RUN', type: 'bool', section: 'safety', default: 'true', tier: 'safety', tierReason: 'dry run guard', weakens: 'false', restart: 'stack' }),
  spec({ key: 'FX_ENABLE_SEND', type: 'bool', section: 'safety', default: 'false', tier: 'safety', tierReason: 'enables sending', weakens: 'true', restart: 'mcp' }),
  spec({ key: 'FX_ONE_ONLY', type: 'bool', section: 'safety', default: null, allowed: ['1'], tier: 'guarded', tierReason: 'flag is 1 or unset', weakens: 'true' }),
  spec({ key: 'FX_ZERO_ONE', type: 'bool', section: 'advanced', default: '0', allowed: ['0', '1'] }),
  // int
  spec({ key: 'FX_MAX_PER_DAY', type: 'int', section: 'limits', default: '20', min: 1, max: 500, tier: 'guarded', tierReason: 'send cap', weakens: 'increase', auditValue: true }),
  spec({ key: 'FX_MIN_GAP', type: 'int', section: 'limits', default: '30', min: 0, max: 1440, tier: 'guarded', tierReason: 'spacing floor', weakens: 'decrease' }),
  spec({ key: 'PACING_MIN_BURST', type: 'int', section: 'scheduler', default: '1', min: 1, max: 50, restart: 'scheduler' }),
  spec({ key: 'PACING_MAX_BURST', type: 'int', section: 'scheduler', default: '4', min: 1, max: 50, restart: 'scheduler' }),
  spec({ key: 'FX_PORT', type: 'int', section: 'dashboard', default: '8787', min: 1024, max: 65535, restart: 'dashboard', exampleActive: true }),
  // enum
  spec({ key: 'FX_MODE', type: 'enum', section: 'web-core', default: 'token', allowed: ['token', 'oidc', 'google_desktop'], restart: 'dashboard' }),
  spec({ key: 'FX_LAYOUT_ENFORCE', type: 'enum', section: 'layout', default: 'warn', allowed: ['off', 'warn', 'enforce'], tier: 'guarded', tierReason: 'enforcement', weakens: 'any' }),
  // string / path / url / email
  spec({ key: 'FX_NAME', type: 'string', section: 'search', default: null, maxLen: 40, required: 'conditional', requiredWhen: 'FX_FLAG is true' }),
  spec({ key: 'FX_DATA_DIR', type: 'path', section: 'advanced', default: '.jobber/fx' }),
  spec({ key: 'FX_REDIRECT_URL', type: 'url', section: 'dashboard', default: null, restart: 'dashboard' }),
  spec({ key: 'FX_ALLOWED_EMAIL', type: 'email', section: 'dashboard', default: null, required: 'required', tier: 'guarded', tierReason: 'who may sign in', weakens: 'any', restart: 'dashboard' }),
  // list / intList
  spec({ key: 'FX_ALLOWED_URLS', type: 'list', section: 'safety', default: null, tier: 'safety', tierReason: 'allowlist', weakens: 'any', blankMeansDefault: false }),
  spec({ key: 'FX_CADENCE_GAPS_DAYS', type: 'intList', section: 'limits', default: '3,4,5,7', itemCount: 4, min: 1, max: 60 }),
  // secrets (default null, never a value here)
  spec({ key: 'FX_API_KEY', type: 'secret', section: 'credentials-sources', default: null, secret: true, auditValue: false, tier: 'normal', restart: 'mcp' }),
  spec({ key: 'FX_BOT_TOKEN', type: 'secret', section: 'telegram', default: null, secret: true, auditValue: false, weakens: 'cleared', tier: 'guarded', tierReason: 'bridge token', restart: 'stack', maxLen: 200 }),
  spec({ key: 'FX_OAUTH_SECRET', type: 'secret', section: 'credentials-gmail', default: null, secret: true, auditValue: false, restart: 'dashboard' }),
  // never tier
  spec({ key: 'FX_KILL', type: 'bool', section: 'safety', default: 'false', tier: 'never', tierReason: 'owner only via CLI', weakens: 'any' }),
  // misc
  spec({ key: 'FX_APPLY_LIMIT', type: 'int', section: 'apply', default: '5', min: 0, max: 100, weakens: 'increase', tier: 'guarded', tierReason: 'apply cap' }),
  spec({ key: 'FX_UPDATE_FLAG', type: 'bool', section: 'update-backup', default: 'false', tier: 'guarded', tierReason: 'auto update', weakens: 'true' }),
  spec({ key: 'FX_CLASSIFIER_MODEL', type: 'string', section: 'classifier', default: null, tier: 'safety', tierReason: 'classifier selection', weakens: 'cleared', restart: 'mcp' }),
  spec({ key: 'FX_LINKEDIN_WEEKLY', type: 'int', section: 'linkedin', default: '50', min: 0, max: 200, weakens: 'increase', tier: 'guarded', tierReason: 'weekly cap' }),
  spec({ key: 'FX_NAUKRI_HEADLESS', type: 'bool', section: 'naukri', default: 'true', restart: 'mcp' }),
];

const BY_KEY = new Map(FIXTURE_CATALOG.map((s) => [s.key, s]));

export function specOf(key: string): EnvSpec {
  const s = BY_KEY.get(key);
  if (!s) throw new Error(`fixture catalog has no ${key}`);
  return s;
}

export const FIXTURE_KEYS: string[] = FIXTURE_CATALOG.map((s) => s.key);
