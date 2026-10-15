// tests/platform-runner-interactive.test.ts
// Task 6 (8E): interactive restricted profiles, the exact Bash allowlist, and the golden check that
// hunt and outreach_wake are unchanged.
import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildClaudeArgs,
  buildInteractiveArgs,
  loadProfiles,
  renderPolicy,
  renderSettings,
  type ResolvedProfile,
} from '../src/platform/runner.js';
import { checkInteractiveUse, formatPrintArgs, spawnInteractive } from '../src/platform/interactive.js';

const profiles = loadProfiles('config/run-profiles.json', 'config/permission-sets.json');
const hunt = profiles.hunt;

describe('golden: hunt and outreach_wake are unchanged by the interactive work', () => {
  const golden = JSON.parse(readFileSync('tests/fixtures/runner-golden.json', 'utf8')) as Record<string, any>;
  for (const n of ['hunt', 'outreach_wake']) {
    it(`${n} argv, settings and policy match the pre-change capture`, () => {
      const p = profiles[n];
      expect(buildClaudeArgs(n, p, { settingsPath: `debug/runner/${n}.settings.json` })).toEqual(golden[n].args);
      const paths = {
        hookPath: '$CLAUDE_PROJECT_DIR/.claude/hooks/tool-allowlist.cjs',
        policyPath: `$CLAUDE_PROJECT_DIR/debug/runner/${n}.policy.json`,
      };
      expect(JSON.stringify(renderSettings(n, p, paths))).toBe(JSON.stringify(golden[n].settings));
      expect(JSON.stringify(renderPolicy(n, p))).toBe(JSON.stringify(golden[n].policy));
    });
  }
});

describe('interactive profiles: validation', () => {
  const dir = 'debug/runner-test';
  mkdirSync(dir, { recursive: true });
  const SETS = 'config/permission-sets.json';
  const guide = {
    interactive: true,
    classifier: 'not_required',
    mcp_config: 'config/runner/mcp.none.json',
    builtin_tools: ['Skill', 'Read'],
    allow: [],
    bash_exact: ['npm run doctor -- --json', 'npm run doctor'],
    env_mode: 'allowlist',
    env_keys: ['TERM'],
    max_turns: 200,
  };
  const load = (profile: object, name = 'setup_guide') => {
    const f = `${dir}/interactive-${name}.json`;
    writeFileSync(f, JSON.stringify({ version: 1, profiles: { [name]: profile } }));
    return loadProfiles(f, SETS)[name];
  };

  it('accepts the guide shape', () => {
    const g = load(guide);
    expect(g.bash_exact).toEqual(guide.bash_exact);
    expect(g.allow).toEqual([]);
  });
  it('accepts allowed bash_exact shapes', () => {
    const ok = ['npm run a:b-c', 'npm run x -- --list', 'npx tsx scripts/status.ts limits', 'npx tsx scripts/a/b.ts'];
    expect(load({ ...guide, bash_exact: ok }).bash_exact).toEqual(ok);
  });
  it('rejects bad bash_exact entries', () => {
    const bad = [
      'ls', 'npm run doctor; id', 'npm run a && npm run b', 'npm run a | cat', 'npm run a > f', 'npm run `id`',
      'npm run a $HOME', 'npm run a (x)', 'npm run a \\ b', "npm run a 'x'", 'npm run "a"', 'npm run a*', 'npm run a?',
      'npm run a ~', 'npm run a\nnpm run b', 'npx tsx scripts/' + '..' + '/x.ts', 'npm run a -- ' + '..' + '/x', 'npm run A',
      'npm install', 'npm run a -- --yes;',
    ];
    for (const b of bad) expect(() => load({ ...guide, bash_exact: [b] }), JSON.stringify(b)).toThrow();
  });
  it('rejects duplicates and more than 40 entries', () => {
    expect(() => load({ ...guide, bash_exact: ['npm run a', 'npm run a'] })).toThrow();
    const many = Array.from({ length: 41 }, (_, i) => `npm run s${i}`);
    expect(() => load({ ...guide, bash_exact: many })).toThrow();
    expect(load({ ...guide, bash_exact: many.slice(0, 40) }).bash_exact).toHaveLength(40);
  });
  it('allows bash_exact only for an interactive profile that is not hunt or outreach_wake', () => {
    expect(() => load({ ...guide, interactive: false })).toThrow();
    const { interactive: _i, ...noInteractive } = guide;
    void _i;
    expect(() => load(noInteractive)).toThrow();
    expect(() => load(guide, 'hunt')).toThrow();
    expect(() => load(guide, 'outreach_wake')).toThrow();
  });
  it('still refuses Bash in builtin_tools', () => {
    expect(() => load({ ...guide, builtin_tools: ['Skill', 'Bash'] })).toThrow();
  });
  it('classifier not_required needs empty allow, no set or extra, and the none config', () => {
    expect(() => load({ ...guide, allow: ['mcp__db__get_funnel'] })).toThrow();
    expect(() => load({ ...guide, allow_from_permission_set: 'read_only' })).toThrow();
    expect(() => load({ ...guide, allow_extra: ['mcp__db__get_funnel'] })).toThrow();
    expect(() => load({ ...guide, mcp_config: '.mcp.json' })).toThrow();
    expect(() => load({ ...guide, classifier: 'maybe' })).toThrow();
    for (const b of ['Agent', 'Task', 'Grep']) {
      expect(() => load({ ...guide, builtin_tools: ['Skill', 'Read', b] }), b).toThrow();
    }
    expect(load({ ...guide, builtin_tools: ['Read'] }).builtin_tools).toEqual(['Read']);
    expect(load({ ...guide, builtin_tools: [] }).builtin_tools).toEqual([]);
  });
  it('interactive needs env_mode allowlist', () => {
    expect(() => load({ ...guide, env_mode: 'dotenv_all', env_files: ['.env'] })).toThrow();
  });
});

describe('buildInteractiveArgs and interactive settings', () => {
  const base: ResolvedProfile = {
    name: 'setup_guide',
    interactive: true,
    classifier: 'not_required',
    mcp_config: 'config/runner/mcp.none.json',
    builtin_tools: ['Skill', 'Read'],
    allow: [],
    bash_exact: ['npm run doctor -- --json', 'npm run doctor'],
    env_mode: 'allowlist',
    env_keys: ['TERM'],
    max_turns: 200,
  };
  const paths = { settingsPath: 'debug/runner/setup_guide.settings.json' };
  const next = (a: string[], f: string) => a[a.indexOf(f) + 1];

  it('with Bash: exact entries only, no -p, no max-turns, dontAsk', () => {
    const a = buildInteractiveArgs('setup_guide', base, paths, 'Start by running the doctor.');
    expect(a).not.toContain('-p');
    expect(a).not.toContain('--max-turns');
    expect(a).not.toContain('--output-format');
    expect(next(a, '--permission-mode')).toBe('dontAsk');
    expect(next(a, '--setting-sources')).toBe('project');
    expect(a).toContain('--strict-mcp-config');
    expect(next(a, '--mcp-config')).toBe('config/runner/mcp.none.json');
    expect(next(a, '--tools')).toBe('Skill,Read,Bash');
    expect(next(a, '--disallowedTools')).toBe('Write,Edit,NotebookEdit,WebFetch,WebSearch');
    expect(a[0]).toBe('Start by running the doctor.');
    expect(a.slice(1).filter((x) => x === 'Start by running the doctor.')).toEqual([]);
    expect(a.indexOf('--allowedTools')).toBeGreaterThan(0);
    expect(a.indexOf('--disallowedTools')).toBeGreaterThan(0);
    const allowed = next(a, '--allowedTools');
    expect(allowed).toBe('Skill,Read,Bash(npm run doctor -- --json),Bash(npm run doctor)');
    const bashEntries = allowed.split(',').filter((e) => e.startsWith('Bash('));
    expect(bashEntries.map((e) => e.slice(5, -1))).toEqual(base.bash_exact);
    expect(a.join(' ').toLowerCase()).not.toContain('bypass');
    expect(allowed).not.toContain('*');
  });
  it('without Bash: Bash stays in the disallow list and out of tools', () => {
    const { bash_exact: _b, ...noBash } = base;
    void _b;
    const a = buildInteractiveArgs('setup_guide', noBash, paths, '');
    expect(next(a, '--tools')).toBe('Skill,Read');
    expect(next(a, '--disallowedTools')).toBe('Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch');
    expect(next(a, '--allowedTools')).toBe('Skill,Read');
    expect(a).not.toContain('');
  });
  it('refuses a non-interactive profile and a dash-leading prompt', () => {
    expect(() => buildInteractiveArgs('hunt', hunt, paths, 'x')).toThrow();
    expect(() => buildInteractiveArgs('setup_guide', base, paths, '--dangerous')).toThrow();
  });
  it('settings: exact Bash allow, deny without Bash, prompt guard hook; policy carries bash_exact', () => {
    const s = renderSettings('setup_guide', base, { hookPath: 'h.cjs', policyPath: 'p.json' }) as any;
    expect(s.permissions.allow).toEqual(['Skill', 'Read', 'Bash(npm run doctor -- --json)', 'Bash(npm run doctor)']);
    expect(s.permissions.deny).not.toContain('Bash');
    expect(JSON.stringify(s.hooks.UserPromptSubmit)).toContain('prompt-secret-guard.cjs');
    expect(JSON.stringify(s.hooks.UserPromptSubmit)).toContain('"onFailure":"block"');
    expect(JSON.stringify(s.hooks.PreToolUse)).toContain('block-outside-project.cjs');
    const pol = renderPolicy('setup_guide', base) as any;
    expect(pol.profiles.setup_guide.bash_exact).toEqual(base.bash_exact);
    expect(pol.profiles.setup_guide.interactive).toBe(true);
  });
  it('a non-interactive profile gets no UserPromptSubmit hook and Bash stays denied', () => {
    const s = renderSettings('hunt', hunt, { hookPath: 'h.cjs', policyPath: 'p.json' }) as any;
    expect(s.hooks.UserPromptSubmit).toBeUndefined();
    expect(s.permissions.deny).toContain('Bash');
  });
});

describe('launcher helpers (src/platform/interactive.ts)', () => {
  const mk = (interactive: boolean): ResolvedProfile => ({
    name: 'x', mcp_config: 'm', builtin_tools: [], allow: [], env_mode: 'allowlist', env_keys: [], max_turns: 1, interactive,
  });
  it('requires --interactive for an interactive profile and refuses it otherwise', () => {
    expect(checkInteractiveUse(mk(true), false, true)).toMatch(/pass --interactive/);
    expect(checkInteractiveUse(mk(false), true, true)).toMatch(/not allowed/);
  });
  it('refuses a non-TTY interactive run', () => {
    expect(checkInteractiveUse(mk(true), true, false)).toMatch(/needs a terminal/);
    expect(checkInteractiveUse(mk(true), true, true)).toBeNull();
    expect(checkInteractiveUse(mk(false), false, false)).toBeNull();
  });
  it('print-args output has env key names only, never values', () => {
    const out = formatPrintArgs(['--a'], { TERM: 'secret-looking-value', HOME: 'h' });
    expect(out).toContain('env keys: HOME,TERM');
    expect(out).not.toContain('secret-looking-value');
  });
  it('spawns with stdio inherit through the injected spawner', () => {
    const fake = vi.fn().mockReturnValue({});
    spawnInteractive(fake as never, ['--a'], { TERM: 'x' }, '/root');
    expect(fake).toHaveBeenCalledWith('claude', ['--a'], { env: { TERM: 'x' }, stdio: 'inherit', cwd: '/root' });
  });
});
