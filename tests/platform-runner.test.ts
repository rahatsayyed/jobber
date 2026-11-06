// tests/platform-runner.test.ts
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import {
  assertSafeArgs,
  buildEnv,
  loadProfiles,
  renderPolicy,
  renderSettings,
  type ResolvedProfile,
} from '../src/platform/runner.js';

const profiles = loadProfiles('config/run-profiles.json', 'config/permission-sets.json');
const wake = profiles.outreach_wake;
// A send-capable non-interactive profile for the generic runner code; the real `hunt` profile was removed (plan 8G Task 14).
const hunt = loadProfiles('tests/fixtures/runner-send-profile.json', 'config/permission-sets.json').hunt;

// Ruling R4 (8G-2 task 23): sender.md still names the retired apply server until the 8G-1 branch removes the agent (task 14).
const RETIRED_SERVERS = ['apply'];
const retired = (t: string): boolean => RETIRED_SERVERS.includes(/^mcp__([a-z0-9-]+)__/.exec(t)?.[1] ?? '');

describe('assertSafeArgs', () => {
  it('rejects bypass and skip flags and env', () => {
    expect(() => assertSafeArgs(['--permission-mode', 'bypassPermissions'], {})).toThrow();
    expect(() => assertSafeArgs(['--dangerously-skip-permissions'], {})).toThrow();
    expect(() => assertSafeArgs(['--allow-dangerously-skip-permissions'], {})).toThrow();
    expect(() => assertSafeArgs([], { IS_SANDBOX: '1' })).toThrow();
  });
  it('handles the = form', () => {
    expect(() => assertSafeArgs(['--permission-mode=bypassPermissions'], {})).toThrow();
    expect(() => assertSafeArgs(['--permission-mode=acceptEdits'], {})).toThrow();
    expect(() => assertSafeArgs(['--permission-mode=dontAsk'], {})).not.toThrow();
  });
});

describe('buildEnv', () => {
  const base = {
    HOME: '/home/u',
    PATH: '/usr/bin',
    TZ: 'UTC',
    COOLDOWN_IGNORED_DAYS: '3',
    QUIET_HOURS_START: '1',
    GMAIL_APP_PASSWORD: 'synthetic-gmail-pw',
    SERPER_API_KEY: 'synthetic-key-123456',
    ANTHROPIC_API_KEY: 'synthetic',
  };
  it('every allowlist profile that launches linkedin or naukri servers passes LAYOUT_', () => {
    for (const p of Object.values(profiles)) {
      const launches = p.allow.some((e) => e.startsWith('mcp__linkedin__') || e.startsWith('mcp__naukri__'));
      if (p.env_mode === 'allowlist' && launches) expect(p.env_prefixes ?? []).toContain('LAYOUT_');
    }
  });
  it('dotenv_all mode includes parsed .env keys but still drops ANTHROPIC_API_KEY', () => {
    const env = buildEnv(hunt, base, { GMAIL_APP_PASSWORD: 'p', ANTHROPIC_API_KEY: 'k', IS_SANDBOX: '1', CLAUDE_CODE_SKIP_PERMISSIONS: '1' });
    expect(env.GMAIL_APP_PASSWORD).toBe('p');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.IS_SANDBOX).toBeUndefined();
    expect(env.CLAUDE_CODE_SKIP_PERMISSIONS).toBeUndefined();
    expect(() => assertSafeArgs([], env)).not.toThrow();
  });
});

describe('renderSettings and renderPolicy', () => {
  it('expands the permission set into allow in the rendered policy', () => {
    const pol = renderPolicy('hunt', hunt) as any;
    expect(pol.profiles.hunt.allow).toContain('mcp__gmail__send_email');
    expect(pol.profiles.hunt.allow).toContain('mcp__linkedin__linkedin_find_profiles');
    expect(pol.profiles.hunt.allow.some((e: string) => e.startsWith('mcp__connect'))).toBe(false);
    expect(pol.profiles.hunt.allow_from_permission_set).toBeUndefined();
    expect(pol.profiles.hunt.allow.some((e: string) => e.startsWith('Bash'))).toBe(false);
  });
});

describe('loadProfiles validation', () => {
  const dir = 'debug/runner-test';
  mkdirSync(dir, { recursive: true });
  const write = (name: string, profile: object) => {
    const f = `${dir}/${name}.json`;
    writeFileSync(f, JSON.stringify({ version: 1, profiles: { hunt: profile } }));
    return f;
  };
  const base = { mcp_config: '.mcp.json', builtin_tools: ['Skill'], env_mode: 'dotenv_all', env_files: ['.env'], max_turns: 5 };

  it('rejects a profile that resolves to the full set', () => {
    const f = write('full', { ...base, allow_from_permission_set: 'full' });
    expect(() => loadProfiles(f, 'config/permission-sets.json')).toThrow();
  });
  it('drops Bash entries from a resolved set', () => {
    const f = write('ro', { ...base, allow_from_permission_set: 'outreach_send' });
    expect(loadProfiles(f, 'config/permission-sets.json').hunt.allow.some((e) => e.startsWith('Bash'))).toBe(false);
  });
  it('refuses unrestricted_builtins on any profile but outreach_wake, and guarded built-ins without it', () => {
    const base = { mcp_config: 'config/runner/mcp.none.json', allow: ['mcp__db__get_funnel'], env_mode: 'allowlist', env_keys: ['TERM'], max_turns: 5 };
    expect(() => loadProfiles(write('u1', { ...base, builtin_tools: ['Bash'], unrestricted_builtins: true }), 'config/permission-sets.json')).toThrow(/only valid for outreach_wake/);
    expect(() => loadProfiles(write('u2', { ...base, builtin_tools: ['Grep'] }), 'config/permission-sets.json')).toThrow(/not allowed/);
    expect(() => loadProfiles(write('u3', { ...base, builtin_tools: ['Write'] }), 'config/permission-sets.json')).toThrow(/not allowed/);
  });
  it('rejects wildcard, Bash and bare-server explicit allow entries and bad max_turns', () => {
    for (const bad of ['mcp__db__*', 'Bash(ls)', 'mcp__db', 'mcp__db__raw_query']) {
      expect(() => loadProfiles(write('bad', { ...base, allow: [bad] }), 'config/permission-sets.json')).toThrow();
    }
    expect(() => loadProfiles(write('turns', { ...base, allow: ['mcp__db__get_funnel'], max_turns: 0 }), 'config/permission-sets.json')).toThrow();
    expect(() => loadProfiles(write('none', { ...base }), 'config/permission-sets.json')).toThrow();
    expect(() => loadProfiles(write('bi', { ...base, allow: ['mcp__db__get_funnel'], builtin_tools: ['Bash'] }), 'config/permission-sets.json')).toThrow();
  });
  it('validates allow_extra the same way and appends it', () => {
    const ok = loadProfiles(write('x', { ...base, allow_from_permission_set: 'outreach_send', allow_extra: ['mcp__db__get_funnel', 'mcp__x__y'] }), 'config/permission-sets.json');
    expect(ok.hunt.allow).toContain('mcp__x__y');
    expect(() => loadProfiles(write('xb', { ...base, allow_from_permission_set: 'outreach_send', allow_extra: ['mcp__*'] }), 'config/permission-sets.json')).toThrow();
  });
});

describe('name validation', () => {
  const paths = { hookPath: 'h.cjs', policyPath: 'p.json' };
  it('loadProfiles rejects a bad name', () => {
    writeFileSync('debug/runner-test/name.json', JSON.stringify({ version: 1, profiles: { 'x; touch pwn': { mcp_config: 'm', builtin_tools: [], allow: ['mcp__db__get_funnel'], env_mode: 'allowlist', env_keys: ['TZ'], max_turns: 1 } } }));
    expect(() => loadProfiles('debug/runner-test/name.json', 'config/permission-sets.json')).toThrow();
  });
});
