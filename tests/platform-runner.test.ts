// tests/platform-runner.test.ts
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import {
  assertSafeArgs,
  buildClaudeArgs,
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

describe('shipped profiles', () => {
  it('never contain raw_query, wildcards or dangerous built-ins', () => {
    for (const p of Object.values(profiles)) {
      expect(p.allow).not.toContain('mcp__db__raw_query');
      expect(p.allow.every((e) => /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(e))).toBe(true);
      for (const b of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']) {
        expect(p.builtin_tools).not.toContain(b);
      }
    }
  });

  it('keeps the wake MCP config and allow list in step', () => {
    const cfg = JSON.parse(readFileSync(wake.mcp_config, 'utf8')) as { mcpServers: Record<string, unknown> };
    const used = new Set(wake.allow.map((e) => e.split('__')[1]));
    expect([...used].sort()).toEqual(Object.keys(cfg.mcpServers).sort());
  });

  it('covers every tool the pipeline agents declare in the hunt profile', () => {
    const missing: string[] = [];
    // The four scheduler workers run under the wake profile; the next test covers them.
    const WORKERS = ['linkedin-operator.md', 'naukri-operator.md', 'source-operator.md'];
    for (const f of readdirSync('.claude/agents').filter((x) => x.endsWith('.md') && x !== 'hook-probe.md' && !WORKERS.includes(x))) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(`.claude/agents/${f}`, 'utf8'))?.[1] ?? '';
      const tools = (fm.split('\n').find((l) => l.startsWith('tools:')) ?? '').replace('tools:', '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const t of tools) {
        if (retired(t)) continue;
        if (t.startsWith('mcp__') && !hunt.allow.includes(t)) missing.push(`${f}: ${t}`);
        if (!t.startsWith('mcp__') && !hunt.builtin_tools.includes(t)) missing.push(`${f}: ${t}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers every tool the scheduler workers declare in the wake profile', () => {
    const missing: string[] = [];
    for (const f of ['linkedin-operator', 'naukri-operator', 'source-operator']) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(`.claude/agents/${f}.md`, 'utf8'))?.[1] ?? '';
      const tools = (fm.split('\n').find((l) => l.startsWith('tools:')) ?? '').replace('tools:', '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const t of tools) {
        if (t.startsWith('mcp__') && !wake.allow.includes(t)) missing.push(`${f}: ${t}`);
        if (!t.startsWith('mcp__') && !wake.builtin_tools.includes(t)) missing.push(`${f}: ${t}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('buildClaudeArgs', () => {
  const args = buildClaudeArgs('outreach_wake', wake, { settingsPath: 'debug/runner/outreach_wake.settings.json' });
  const next = (flag: string) => args[args.indexOf(flag) + 1];

  it('is dontAsk with no prompts and strict MCP', () => {
    expect(next('--permission-mode')).toBe('dontAsk');
    expect(next('--permission-prompts')).toBe('none');
    expect(args).toContain('--strict-mcp-config');
    expect(next('--mcp-config')).toBe('config/runner/mcp.platform.json');
    expect(next('--setting-sources')).toBe('project');
  });
  it('restricts built-ins and denies the dangerous ones explicitly', () => {
    expect(next('--tools')).toBe(wake.builtin_tools.join(','));
    expect(next('--disallowedTools')).toBe('Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch');
  });
  it('puts the prompt nowhere in argv', () => {
    expect(args).not.toContain('run the hunt');
    expect(args[0]).toBe('-p');
  });
  it('never contains a bypass flag', () => {
    expect(() => assertSafeArgs(args, {})).not.toThrow();
  });
});

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
    PACING_MAX_BURST: '3',
    QUIET_HOURS_START: '1',
    GMAIL_APP_PASSWORD: 'synthetic-gmail-pw',
    SERPER_API_KEY: 'synthetic-key-123456',
    ANTHROPIC_API_KEY: 'synthetic',
  };
  it('allowlist mode passes only listed keys and prefixes and never a secret-shaped key', () => {
    const env = buildEnv(wake, base, {});
    expect(env.PACING_MAX_BURST).toBe('3');
    expect(env.QUIET_HOURS_START).toBe('1');
    expect(env.HOME).toBe('/home/u');
    expect(env.JOBBER_RUN_PROFILE).toBe('outreach_wake');
    expect(env.GMAIL_APP_PASSWORD).toBeUndefined();
    expect(env.SERPER_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it('passes LAYOUT_* to the wake (MCP servers read LAYOUT_ENFORCE) and nothing unrelated', () => {
    const env = buildEnv(wake, { ...base, LAYOUT_ENFORCE: 'enforce', LAYOUT_DRIFT_HALT_N: '4', UNRELATED_FLAG: '1' }, {});
    expect(env.LAYOUT_ENFORCE).toBe('enforce');
    expect(env.LAYOUT_DRIFT_HALT_N).toBe('4');
    expect(env.UNRELATED_FLAG).toBeUndefined();
    expect(wake.env_prefixes).toContain('LAYOUT_');
  });
  it('every allowlist profile that launches linkedin or naukri servers passes LAYOUT_', () => {
    for (const p of Object.values(profiles)) {
      const launches = p.allow.some((e) => e.startsWith('mcp__linkedin__') || e.startsWith('mcp__naukri__'));
      if (p.env_mode === 'allowlist' && launches) expect(p.env_prefixes ?? []).toContain('LAYOUT_');
    }
  });
  it('does not let a prefix pull in a secret-shaped key', () => {
    const p: ResolvedProfile = { ...wake, env_prefixes: ['PACING_'] };
    expect(buildEnv(p, { ...base, PACING_API_KEY: 'x-secret-value' }, {}).PACING_API_KEY).toBeUndefined();
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
  it('registers both hooks with onFailure block and the rendered policy path', () => {
    const s = renderSettings('outreach_wake', wake, {
      hookPath: '$CLAUDE_PROJECT_DIR/.claude/hooks/tool-allowlist.cjs',
      policyPath: 'debug/runner/outreach_wake.policy.json',
    }) as any;
    const cmds = JSON.stringify(s.hooks.PreToolUse);
    expect(cmds).toContain('tool-allowlist.cjs');
    expect(cmds).toContain('outreach_wake');
    expect(cmds).toContain('block-outside-project.cjs');
    expect(cmds).toContain('"onFailure":"block"');
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
  });
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
  it('rejects unsafe names and paths', () => {
    expect(() => renderSettings('x; touch pwn', wake, paths)).toThrow();
    expect(() => renderPolicy('x; touch pwn', wake)).toThrow();
    expect(() => renderSettings('ok_name', wake, paths)).not.toThrow();
    expect(() => renderPolicy('ok_name', wake)).not.toThrow();
    expect(() => renderSettings('ok', wake, { hookPath: 'h', policyPath: 'a"b' })).toThrow();
  });
  it('loadProfiles rejects a bad name', () => {
    writeFileSync('debug/runner-test/name.json', JSON.stringify({ version: 1, profiles: { 'x; touch pwn': { mcp_config: 'm', builtin_tools: [], allow: ['mcp__db__get_funnel'], env_mode: 'allowlist', env_keys: ['TZ'], max_turns: 1 } } }));
    expect(() => loadProfiles('debug/runner-test/name.json', 'config/permission-sets.json')).toThrow();
  });
  it('buildEnv throws without a name', () => {
    const { name: _n, ...noName } = wake;
    void _n;
    expect(() => buildEnv(noName as ResolvedProfile, {}, {})).toThrow();
  });
});
