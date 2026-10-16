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

describe('fix round 1', () => {
  const nest = (depth: number, leaf: unknown) => {
    let v: unknown = leaf;
    for (let i = 0; i < depth; i++) v = { a: v };
    return v as object;
  };
  it('1: denies deeply nested and oversized input for a screened tool', () => {
    const t = 'mcp__naukri__naukri_type';
    expect(call(t, nest(13, 'secrets/x.json')).allow).toBe(false);
    expect(call(t, nest(3, 'hello')).allow).toBe(true);
    expect(call(t, { l: Array.from({ length: 5001 }, () => 'x') }).allow).toBe(false);
    expect(call('mcp__db__get_funnel', nest(13, 'x')).allow).toBe(true); // unscreened
  });
  it('2: rejects bare server entries with underscores, keeps valid ones', () => {
    const d = (allow: string[]) =>
      hook.decide({ tool_name: 'Skill' }, { allow, builtin_tools: ['Skill'] }, { root: ROOT }).allow;
    expect(d(['mcp__my_server'])).toBe(false);
    expect(d(['mcp__db__'])).toBe(false);
    expect(d(['mcp__job-fetch__board_status'])).toBe(true);
    expect(d(['mcp__claude_ai_Linear__list_issues'])).toBe(true);
  });
  it('3: unanchored secret patterns', () => {
    const t = 'mcp__naukri__naukri_type';
    for (const s of ['file:///etc/pw', 'x:/etc/pw', 'a/Users/x', '.envrc', 'a.env_prod', 'mysecrets/k', 'secrets\\k', 'x/tmp/y', 'x/var/y'])
      expect(call(t, { s }).allow, s).toBe(false);
    for (const s of ['See you at 4 pm', 'I can start 1/2 next month'])
      expect(call(t, { s }).allow, s).toBe(true);
    expect(call('mcp__db__get_funnel', { note: 'uses .env files' }).allow).toBe(true);
  });
  it('4: sensitive directory segments and sqlite sidecars', () => {
    const p = { ...profile, path_rules: { Read: { prefixes: ['config/', 'debug/'] } } };
    const r = (fp: string) => hook.decide({ tool_name: 'Read', tool_input: { file_path: fp } }, p, { root: ROOT }).allow;
    expect(r('config/secrets/a.json')).toBe(false);
    expect(r('config/user-data/a.json')).toBe(false);
    expect(r('config/node_modules/a.json')).toBe(false);
    expect(r('config/.git/HEAD')).toBe(false);
    expect(r('config/.envdir/a.json')).toBe(false);
    for (const n of ['data.sqlite-wal', 'data.sqlite-shm', 'data.sqlite-journal', 'data.sqlite3'])
      expect(r('config/' + n)).toBe(false);
    expect(r('config/target-regions.json')).toBe(true);
  });
  it('5: works when the root is reached through a symlink', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-real-'));
    const link = real + '-link';
    try {
      fs.mkdirSync(path.join(real, 'config'));
      fs.writeFileSync(path.join(real, 'config', 'a.json'), '{}');
      fs.symlinkSync(real, link);
      const r = (root: string, fp: string) =>
        hook.decide({ tool_name: 'Read', tool_input: { file_path: fp } }, profile, { root }).allow;
      expect(r(link, 'config/a.json')).toBe(true);
      expect(r(real, 'config/a.json')).toBe(true);
      expect(r(link, 'config/missing.json')).toBe(true);
      expect(r(link, '../x')).toBe(false);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
  it('7: malformed agent fields are denied', () => {
    for (const extra of [{ agent_type: '' }, { agent_id: '' }, { agent_type: 5 }, { agent_id: 'a', agent_type: '' }, { agent_id: null }]) {
      expect(call('Skill', {}, extra).allow, JSON.stringify(extra)).toBe(false);
    }
    expect(call('mcp__resume__get_base_resume', {}, { agent_id: 'a1', agent_type: 'matcher' }).allow).toBe(true);
  });
});

describe('CLI', () => {
  it('6: deny JSON is fully delivered over a pipe (large reason path) and exit is 0', () => {
    const r = spawnSync('node', ['.claude/hooks/tool-allowlist.cjs', 'outreach_wake'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(200000) } }),
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, HOOK_NO_LOG: '1' },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('6: empty stdin denies', () => {
    const r = spawnSync('node', ['.claude/hooks/tool-allowlist.cjs', 'outreach_wake'], {
      input: '',
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, HOOK_NO_LOG: '1' },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
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

describe('gmail sender allowlist rule (plan 8G task 6)', () => {
  const gp = {
    allow: ['mcp__gmail__search_emails', 'mcp__gmail__read_email', 'mcp__gmail__send_email', 'mcp__gmail__delete_email'],
    gmail_sender_allowlist: true,
  };
  const env = { SITE_MAIL_SENDERS: 'no-reply@acme.example.test, @jobs.example.test' } as NodeJS.ProcessEnv;
  const g = (tool_name: string, tool_input: object = {}, e: NodeJS.ProcessEnv = env) =>
    hook.decide({ tool_name, tool_input }, gp, { root: ROOT, env: e } as never).allow;
  it('allows a search pinned to an allowlisted sender and reading a message', () => {
    expect(g('mcp__gmail__search_emails', { query: 'from:no-reply@acme.example.test newer_than:1d' })).toBe(true);
    expect(g('mcp__gmail__search_emails', { query: 'from:"no-reply@jobs.example.test" verify' })).toBe(true);
    expect(g('mcp__gmail__read_email', { messageId: 'abc' })).toBe(true);
  });
  it('rejects a search without from:, with a foreign sender, an OR group, or an empty allowlist', () => {
    for (const q of ['verify your account', 'in:inbox', 'from:evil@example.org', 'from:no-reply@acme.example.test OR in:anywhere', '{from:no-reply@acme.example.test in:inbox}', 'from:no-reply@acme.example.test from:x@evil.example.org', '']) {
      expect(g('mcp__gmail__search_emails', { query: q })).toBe(false);
    }
    expect(g('mcp__gmail__search_emails', {})).toBe(false);
    expect(g('mcp__gmail__search_emails', { query: 'from:no-reply@acme.example.test' }, {} as NodeJS.ProcessEnv)).toBe(false);
  });
  it('denies every other gmail tool, even when listed', () => {
    for (const t of ['mcp__gmail__send_email', 'mcp__gmail__delete_email']) expect(g(t, { to: 'x@example.test' })).toBe(false);
  });
  it('profiles without the flag are unchanged', () => {
    const p = { allow: ['mcp__gmail__search_emails'] };
    expect(hook.decide({ tool_name: 'mcp__gmail__search_emails', tool_input: { query: 'anything' } }, p, { root: ROOT }).allow).toBe(true);
  });
});

describe('gmail tools and the apply-operator (plan 8G-2 task 22)', () => {
  const gp = {
    allow: ['mcp__gmail__search_emails', 'mcp__gmail__read_email', 'mcp__gmail__send_email', 'mcp__gmail__delete_email', 'mcp__gmail__modify_email', 'mcp__db__list_queued_outreach'],
    gmail_sender_allowlist: true,
  };
  const env = { SITE_MAIL_SENDERS: 'no-reply@acme.example.test' } as NodeJS.ProcessEnv;
  const main = (tool_name: string, tool_input: object = {}, e: NodeJS.ProcessEnv = env) =>
    hook.decide({ tool_name, tool_input }, gp, { root: ROOT, env: e } as never).allow;
  const operator = (tool_name: string, tool_input: object = {}) =>
    hook.decide({ tool_name, tool_input, agent_id: 'a1', agent_type: 'apply-operator' }, gp, { root: ROOT, env } as never).allow;

  it('hook rejects an unrestricted gmail search', () => {
    for (const q of ['in:inbox', 'verify your account', 'label:unread', 'newer_than:1d', 'subject:verify', 'from:someone@else.example.org', 'from:no-reply@acme.example.test OR in:anywhere']) {
      expect(main('mcp__gmail__search_emails', { query: q }), q).toBe(false);
    }
    expect(main('mcp__gmail__search_emails', {})).toBe(false);
    expect(main('mcp__gmail__search_emails', { query: 'from:no-reply@acme.example.test' }, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(main('mcp__gmail__search_emails', { query: 'from:no-reply@acme.example.test newer_than:1d' })).toBe(true);
  });
  it('hook denies every other gmail tool for operators', () => {
    for (const t of ['mcp__gmail__send_email', 'mcp__gmail__delete_email', 'mcp__gmail__modify_email', 'mcp__gmail__read_email', 'mcp__gmail__search_emails']) {
      expect(operator(t, { query: 'from:no-reply@acme.example.test', messageId: 'abc', to: 'x@example.test' }), t).toBe(false);
    }
    // the same profile still lets the operator use a tool its own definition lists
    expect(operator('mcp__db__list_queued_outreach')).toBe(true);
    // and the other gmail tools are denied for the main session of a sender-pinned profile too
    for (const t of ['mcp__gmail__send_email', 'mcp__gmail__delete_email', 'mcp__gmail__modify_email']) expect(main(t, { to: 'x@example.test' }), t).toBe(false);
  });
});

describe('applier MCP tools in the wake profile (plan 8G-2 task 20)', () => {
  it('are allowed, and screened tools refuse secret-shaped arguments', async () => {
    const { loadProfiles } = await import('../src/platform/runner.js');
    const wake = loadProfiles(resolve(ROOT, 'config/run-profiles.json'), resolve(ROOT, 'config/permission-sets.json')).outreach_wake as never;
    const d = (tool_name: string, tool_input: object = {}) => hook.decide({ tool_name, tool_input }, wake, { root: ROOT });
    expect(d('mcp__applier__apply_open', { job_id: 'job-1' }).allow).toBe(true);
    expect(d('mcp__applier__apply_escalate', { job_id: 'job-1', reason: 'other', detail: 'needs a look' }).allow).toBe(true);
    expect(d('mcp__applier__apply_escalate', { job_id: 'job-1', reason: 'other', detail: 'see secrets/webcore.lock' }).allow).toBe(false);
    expect(d('mcp__applier__not_a_tool').allow).toBe(false);
  });
});
