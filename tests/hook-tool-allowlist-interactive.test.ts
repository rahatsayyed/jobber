// tests/hook-tool-allowlist-interactive.test.ts
// Plan 8E task 7: exact Bash allowlist and Read rules of interactive profiles.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadProfiles, renderPolicy } from '../src/platform/runner.js';

const require = createRequire(import.meta.url);
const hook = require('../.claude/hooks/tool-allowlist.cjs') as {
  decide: (e: any, p: any, o?: any) => { allow: boolean; reason: string };
  validBashExact: (l: unknown) => boolean;
};
const ROOT = resolve(__dirname, '..');

describe('interactive Bash exact allowlist', () => {
  const CMDS = ['npm run doctor -- --json', 'npm run setup -- --step gmail', 'npx tsx scripts/status.ts health'];
  const ip = {
    allow: [],
    builtin_tools: ['Skill', 'Read'],
    interactive: true,
    bash_exact: CMDS,
    path_rules: { Read: { prefixes: ['docs/', 'config/', 'user-data.example/', '.claude/skills/setup-guide/'] } },
  };
  const bash = (command: unknown, extra: object = {}, p: any = ip, o: any = { root: ROOT }) =>
    hook.decide({ tool_name: 'Bash', tool_input: { command, ...extra } }, p, o);

  it('allows each entry exactly, with surrounding whitespace', () => {
    for (const c of CMDS) {
      expect(bash(c).allow, c).toBe(true);
      expect(bash(`  ${c}\n`).allow, c).toBe(true);
    }
  });
  it('denies every injection and near miss', () => {
    const d = 'npm run doctor -- --json';
    const bad: unknown[] = [
      `${d}; cat .env`, `${d} && id`, `${d} | tee x`, `${d} > secrets/x`, '$(cat .env)', '`cat .env`',
      `${d}\ncat .env`, `${d} #`, 'npm run dоctor -- --json', 'npm  run doctor -- --json', `${d} --foo`,
      'cat .env', 'env', 'printenv', 'bash -c "id"', 'node -e "1"', '', '   ', 5, null, [d],
      { toString: () => d }, 'npm run doctor', `${d} x`,
    ];
    for (const c of bad) expect(bash(c).allow, JSON.stringify(c)).toBe(false);
  });
  it('denies background and sandbox override, missing or odd tool_input', () => {
    expect(bash(CMDS[0], { run_in_background: true }).allow).toBe(false);
    expect(bash(CMDS[0], { dangerouslyDisableSandbox: true }).allow).toBe(false);
    expect(hook.decide({ tool_name: 'Bash' }, ip, { root: ROOT }).allow).toBe(false);
    expect(hook.decide({ tool_name: 'Bash', tool_input: [CMDS[0]] }, ip, { root: ROOT }).allow).toBe(false);
  });
  it('denies Bash for a non-interactive profile and for hunt / outreach_wake', () => {
    expect(bash(CMDS[0], {}, { ...ip, interactive: false }).allow).toBe(false);
    const { interactive: _i, ...noFlag } = ip as any;
    expect(bash(CMDS[0], {}, noFlag).allow).toBe(false);
    expect(bash(CMDS[0], {}, ip, { root: ROOT, profileName: 'hunt' }).allow).toBe(false);
    expect(bash(CMDS[0], {}, ip, { root: ROOT, profileName: 'outreach_wake' }).allow).toBe(false);
    expect(bash(CMDS[0], {}, { builtin_tools: ['Bash'], allow: [] }).allow).toBe(false);
  });
  it('denies a tampered policy whose bash_exact has an invalid entry', () => {
    for (const extra of ['cat .env', 'npm run doctor; id', 'npm run a/../b', 'env', 5]) {
      expect(bash(CMDS[0], {}, { ...ip, bash_exact: [...CMDS, extra] }).allow, String(extra)).toBe(false);
    }
    expect(bash(CMDS[0], {}, { ...ip, bash_exact: 'npm run doctor' }).allow).toBe(false);
    expect(bash(CMDS[0], {}, { ...ip, bash_exact: [CMDS[0], CMDS[0]] }).allow).toBe(false);
  });
  it('subagents never get Bash', () => {
    const r = hook.decide(
      { tool_name: 'Bash', tool_input: { command: CMDS[0] }, agent_id: 'a1', agent_type: 'matcher' },
      ip,
      { root: ROOT },
    );
    expect(r.allow).toBe(false);
  });
  it('the kill switch decision still runs first', () => {
    expect(bash(CMDS[0], {}, ip, { root: ROOT, env: { JOBBER_KILL: '1' } }).allow).toBe(false);
  });
  it('denies Write, Edit, WebFetch, WebSearch, Agent and mcp__ tools', () => {
    for (const t of ['Write', 'Edit', 'WebFetch', 'WebSearch', 'Agent', 'mcp__db__get_funnel', 'mcp__linkedin__linkedin_open']) {
      expect(hook.decide({ tool_name: t, tool_input: {} }, ip, { root: ROOT }).allow, t).toBe(false);
    }
  });

  describe('Read rules in a temp project root', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hook8e-')));
    for (const d of ['docs', 'config', 'user-data.example', 'user-data', 'secrets', '.dashboard', '.jobber', '.claude/skills/setup-guide']) {
      mkdirSync(join(root, d), { recursive: true });
    }
    const files = [
      'docs/telegram-bot-setup.md', 'config/setup-guide.json', '.env', '.env.example', 'secrets/x',
      'user-data/resume.json', '.dashboard/auth.sqlite', '.jobber/bootstrap.json', 'data.sqlite',
      'user-data.example/resume.json', '.claude/skills/setup-guide/SKILL.md',
    ];
    for (const f of files) writeFileSync(join(root, f), 'x');
    symlinkSync(join(root, '.env'), join(root, 'docs/link-to-env.md'));
    symlinkSync(join(root, 'user-data'), join(root, 'config/ud'));
    const read = (fp: string) => hook.decide({ tool_name: 'Read', tool_input: { file_path: fp } }, ip, { root }).allow;

    it('allows the guide paths, relative and absolute', () => {
      for (const f of ['docs/telegram-bot-setup.md', 'config/setup-guide.json', 'user-data.example/resume.json', '.claude/skills/setup-guide/SKILL.md']) {
        expect(read(f), f).toBe(true);
        expect(read(join(root, f)), f).toBe(true);
      }
    });
    it('denies secrets, traversal, symlinks and outside paths', () => {
      for (const f of [
        '.env', '.env.example', './.env', 'secrets/x', 'user-data/resume.json', '.dashboard/auth.sqlite',
        '.jobber/bootstrap.json', 'data.sqlite', 'docs/../.env', 'docs/link-to-env.md', 'config/ud/resume.json',
        '/etc/passwd', '~/.ssh/id_rsa', 'docs/../secrets/x', '.git/config', '',
      ]) {
        expect(read(f), f).toBe(false);
      }
    });
  });
});

describe('hook validator matches the runner validator', () => {
  const corpus: unknown[] = [
    'npm run doctor', 'npm run doctor -- --json', 'npm run setup -- --step gmail', 'npm run a:b-c',
    'npx tsx scripts/status.ts health', 'npx tsx scripts/a/b.ts', 'npx tsx scripts/x.ts --foo',
    'npm run doctor; id', 'npm run doctor && id', 'npm run doctor | x', 'npm run doctor > x', '$(id)', '`id`',
    'npm run doctor\nid', 'npm  run doctor', 'npm run dоctor', 'npm run doctor --', 'npm run Doctor',
    'cat .env', 'env', '', 5, null, 'npm run a/../b', 'npx tsx scripts/../x.ts', 'npm run x -- --a=b',
    'npm run x -- "q"', "npm run x -- 'q'", 'npm run x -- a\\b', 'npm run x -- ~', 'npm run x -- *', 'npm run x ',
  ];
  const dir = mkdtempSync(join(tmpdir(), 'hook8e-v-'));
  const mk = (e: unknown) => ({
    allow: [], builtin_tools: ['Skill'], max_turns: 5, env_mode: 'allowlist', env_keys: ['PATH'],
    mcp_config: '.mcp.json', interactive: true, bash_exact: [e],
  });
  const runnerAccepts = (e: unknown): boolean => {
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify({ version: 1, profiles: { guide: mk(e) } }));
    try {
      loadProfiles(f, 'config/permission-sets.json');
      return true;
    } catch {
      return false;
    }
  };
  it('accepts and rejects the same entries', () => {
    expect(runnerAccepts('npm run doctor -- --json')).toBe(true); // the harness can accept
    expect(runnerAccepts('cat .env')).toBe(false);
    for (const e of corpus) expect(hook.validBashExact([e]), JSON.stringify(e)).toBe(runnerAccepts(e));
  });
  it('renderPolicy keeps interactive and bash_exact for the hook', () => {
    const p: any = renderPolicy('guide', { ...mk('npm run doctor -- --json'), bash_exact: ['npm run doctor -- --json'], name: 'guide' } as any);
    expect(p.profiles.guide.interactive).toBe(true);
    expect(p.profiles.guide.bash_exact).toEqual(['npm run doctor -- --json']);
  });
});
