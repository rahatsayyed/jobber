import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildEnv, loadProfiles } from '../src/platform/runner.js';

describe('outreach_wake child env', () => {
  const wakeProfile = loadProfiles('config/run-profiles.json', 'config/permission-sets.json').outreach_wake;
  it('passes the owner caps from a merged .env base and nothing off the allowlist', () => {
    const merged = { MAX_APPLIES_PER_DAY: '100', NAUKRI_MAX_APPLIES_PER_DAY: '100', TELEGRAM_BOT_TOKEN: 'secret', GMAIL_CLIENT_SECRET: 'secret', RANDOM_KEY: 'x' };
    const env = buildEnv(wakeProfile, merged, {});
    expect(env.MAX_APPLIES_PER_DAY).toBe('100');
    expect(env.NAUKRI_MAX_APPLIES_PER_DAY).toBe('100');
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.GMAIL_CLIENT_SECRET).toBeUndefined();
    expect(env.RANDOM_KEY).toBeUndefined();
  });
});

const profiles = JSON.parse(readFileSync('config/run-profiles.json', 'utf8'));
const wake = (profiles.profiles ?? profiles).outreach_wake;

const reachesWake = (key: string): boolean =>
  wake.env_keys.includes(key) || wake.env_prefixes.some((p: string) => key.startsWith(p));

describe('outreach_wake env allowlist carries the cap settings', () => {
  // These caps are enforced inside the MCP servers a wake starts, so an owner override in .env
  // only counts when the key reaches the wake's child environment.
  it.each([
    'MAX_APPLIES_PER_DAY',
    'MAX_LINKEDIN_SEARCHES_PER_DAY',
    'LINKEDIN_MAX_INVITES_PER_WEEK',
    'LINKEDIN_MAX_MESSAGES_PER_WEEK',
    'LINKEDIN_MAX_DISCOVER_PER_DAY',
    'NAUKRI_MAX_APPLIES_PER_DAY',
    'NAUKRI_MAX_MESSAGES_PER_DAY',
    'WELLFOUND_MAX_APPLIES_PER_DAY',
    'WELLFOUND_MAX_MESSAGES_PER_DAY',
    'WELLFOUND_MAX_DISCOVER_PER_DAY',
    'APPLY_MAX_ATTEMPTS_PER_DAY',
  ])('%s reaches the wake', (key) => {
    expect(reachesWake(key)).toBe(true);
  });
});
