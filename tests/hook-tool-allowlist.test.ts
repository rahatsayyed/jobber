// tests/hook-tool-allowlist.test.ts
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const hook = require('../.claude/hooks/tool-allowlist.cjs') as {
  decide: (e: any, p: any, o?: { root?: string }) => { allow: boolean; reason: string };
  agentTools: (t: string, root: string) => string[] | null;
};
const ROOT = resolve(__dirname, '..');
const profile = {
  allow: ['mcp__db__get_funnel', 'mcp__naukri__naukri_type', 'mcp__resume__get_base_resume'],
  builtin_tools: ['Skill', 'Agent', 'Read'],
  path_rules: { Read: { prefixes: ['config/'] } },
  screen_args: ['mcp__naukri__naukri_type'],
};
const call = (tool_name: string, tool_input: object = {}, extra: object = {}) =>
  hook.decide({ tool_name, tool_input, ...extra }, profile, { root: ROOT });

describe('main session', () => {
  it('allows listed tools', () => {
    expect(call('mcp__db__get_funnel').allow).toBe(true);
    expect(call('Skill').allow).toBe(true);
  });
  it('denies Bash, Write, WebFetch and unlisted MCP tools, including raw_query', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'mcp__db__raw_query', 'mcp__gmail__send_email']) {
      expect(call(t).allow).toBe(false);
    }
  });
  it('denies malformed events', () => {
    expect(hook.decide({}, profile, { root: ROOT }).allow).toBe(false);
    expect(hook.decide({ tool_name: 5 }, profile, { root: ROOT }).allow).toBe(false);
  });
});

describe('path rules', () => {
  it('allows Read under config/ and denies other places', () => {
    expect(call('Read', { file_path: 'config/target-regions.json' }).allow).toBe(true);
    expect(call('Read', { file_path: 'secrets/linkedin-main-state.json' }).allow).toBe(false);
    expect(call('Read', { file_path: '.env' }).allow).toBe(false);
    expect(call('Read', { file_path: 'config/../.env' }).allow).toBe(false);
    expect(call('Read', { file_path: '/etc/hosts' }).allow).toBe(false);
    expect(call('Read', { file_path: 'config/some-state.json' }).allow).toBe(false);
  });
});

describe('argument screening', () => {
  it('denies secret-shaped paths in a screened send tool and allows ordinary text', () => {
    expect(call('mcp__naukri__naukri_type', { text: 'See you at 4 pm' }).allow).toBe(true);
    expect(call('mcp__naukri__naukri_type', { text: 'attached: secrets/naukri-state.json' }).allow).toBe(false);
    expect(call('mcp__naukri__naukri_type', { nested: { a: ['cat ~/.ssh/id_rsa'] } }).allow).toBe(false);
  });
  it('does not screen tools that are not listed', () => {
    expect(call('mcp__db__get_funnel', { note: 'uses .env files' }).allow).toBe(true);
  });
});

describe('subagents', () => {
  it('uses the agent frontmatter tools, intersected with the profile', () => {
    // matcher.md: tools: Skill, mcp__resume__get_base_resume, mcp__gates__check_liveness
    expect(hook.agentTools('matcher', ROOT)).toContain('mcp__resume__get_base_resume');
    const inSub = (t: string) => call(t, {}, { agent_id: 'a1', agent_type: 'matcher' });
    expect(inSub('mcp__resume__get_base_resume').allow).toBe(true);
    expect(inSub('mcp__gates__check_liveness').allow).toBe(false); // in the agent file, not in the profile
    expect(inSub('mcp__db__get_funnel').allow).toBe(false); // in the profile, not in the agent file
  });
  it('denies an agent type with no definition file', () => {
    expect(call('Skill', {}, { agent_id: 'a1', agent_type: 'general-purpose' }).allow).toBe(false);
    expect(call('Skill', {}, { agent_id: 'a1', agent_type: '../../etc/passwd' }).allow).toBe(false);
  });
});

describe('policy hygiene', () => {
  it('rejects wildcard and whole-server entries', () => {
    const bad = { ...profile, allow: ['mcp__db'] };
    expect(hook.decide({ tool_name: 'mcp__db__get_funnel' }, bad, { root: ROOT }).allow).toBe(false);
    const star = { ...profile, allow: ['mcp__db__*'] };
    expect(hook.decide({ tool_name: 'mcp__db__get_funnel' }, star, { root: ROOT }).allow).toBe(false);
  });
  it('a profile without an allow list keeps only builtin_tools (unrendered policy is not broad)', () => {
    const { allow: _drop, ...noAllow } = profile as any;
    const unrendered = { ...noAllow, allow_from_permission_set: 'outreach_send' };
    expect(hook.decide({ tool_name: 'mcp__db__get_funnel' }, unrendered, { root: ROOT }).allow).toBe(false);
    expect(hook.decide({ tool_name: 'mcp__gmail__send_email' }, unrendered, { root: ROOT }).allow).toBe(false);
    expect(hook.decide({ tool_name: 'Skill' }, unrendered, { root: ROOT }).allow).toBe(true);
  });
  it('denies when the profile is not an object', () => {
    expect(hook.decide({ tool_name: 'Skill' }, null, { root: ROOT }).allow).toBe(false);
    expect(hook.decide({ tool_name: 'Skill' }, 'x', { root: ROOT }).allow).toBe(false);
  });
});

describe('CLI', () => {
  const run = (args: string[], event: unknown) =>
    spawnSync('node', ['.claude/hooks/tool-allowlist.cjs', ...args], {
      input: typeof event === 'string' ? event : JSON.stringify(event),
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, HOOK_NO_LOG: '1' },
    });
  it('prints a deny JSON for an unknown profile and for garbage input, exit 0', () => {
    for (const r of [run(['no_such_profile'], { tool_name: 'Bash' }), run(['outreach_wake'], 'not json')]) {
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });
  it('denies when the policy file is missing', () => {
    const r = run(['outreach_wake', 'config/does-not-exist.json'], { tool_name: 'mcp__naukri__naukri_state' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('prints nothing for an allowed call under the shipped outreach_wake profile', () => {
    const r = run(['outreach_wake'], { tool_name: 'mcp__naukri__naukri_state', tool_input: {} });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
  it('denies Bash under the shipped outreach_wake profile', () => {
    const r = run(['outreach_wake'], { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
