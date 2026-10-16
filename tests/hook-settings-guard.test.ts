// tests/hook-settings-guard.test.ts
// settings-guard.cjs (plan 8H, Task 9): denies the settings API / stores in any tool input and writes to .env files.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const hook = require('../.claude/hooks/settings-guard.cjs') as {
  decide: (e: unknown) => { allow: boolean; reason: string };
};
const ROOT = resolve(__dirname, '..');
const call = (tool_name: string, tool_input: unknown) => hook.decide({ tool_name, tool_input });
const bash = (command: string) => call('Bash', { command });

describe('table', () => {
  const cases: Array<[string, string, unknown, boolean]> = [
    ['curl the settings API', 'Bash', { command: 'curl -X POST http://127.0.0.1:8787/api/settings/env/apply' }, false],
    ['Write .env', 'Write', { file_path: '/proj/.env', content: 'A=1' }, false],
    ['Write relative .env', 'Write', { file_path: '.env', content: 'A=1' }, false],
    ['Edit .env.local', 'Edit', { file_path: 'sub/.env.local', old_string: 'a', new_string: 'b' }, false],
    ['NotebookEdit .env.production', 'NotebookEdit', { notebook_path: '.env.production' }, false],
    ['Edit .env.example', 'Edit', { file_path: '.env.example', old_string: 'a', new_string: 'b' }, true],
    ['Write .env.example', 'Write', { file_path: '/proj/.env.example', content: 'A=' }, true],
    ['Read .env.example', 'Read', { file_path: '.env.example' }, true],
    ['append to .env', 'Bash', { command: 'echo x >> .env' }, false],
    ['redirect to .env.local', 'Bash', { command: 'echo x > ./.env.local' }, false],
    ['redirect to quoted .env', 'Bash', { command: 'printf a >".env"' }, false],
    ['stderr redirect to .env', 'Bash', { command: 'cmd 2>> .env' }, false],
    ['redirect to .env.example', 'Bash', { command: 'echo x >> .env.example' }, true],
    ['tee .env', 'Bash', { command: 'echo x | tee -a .env' }, false],
    ['sed -i .env', 'Bash', { command: "sed -i '' 's/a/b/' .env" }, false],
    ['sed without -i', 'Bash', { command: "sed 's/a/b/' .env.example" }, true],
    ['cp onto .env', 'Bash', { command: 'cp /tmp/x .env' }, false],
    ['mv onto .env', 'Bash', { command: 'mv x .env.staging' }, false],
    ['cp .env.example elsewhere', 'Bash', { command: 'cp .env.example /tmp/copy' }, true],
    ['cp onto .env.example', 'Bash', { command: 'cp x .env.example' }, true],
    ['dd of=.env', 'Bash', { command: 'dd if=x of=.env' }, false],
    ['.envrc is not .env', 'Write', { file_path: '.envrc', content: 'x' }, true],
    ['backup store path', 'Read', { file_path: '.jobber/settings-backups/env/x.env' }, false],
    ['settings dir path', 'Bash', { command: 'ls .jobber/settings/' }, false],
    ['pending table', 'mcp__db__raw_query', { sql: 'select * from settings_pending' }, false],
    ['mcp input mentioning the API', 'mcp__linkedin__linkedin_open', { url: 'http://localhost:8787/API/Settings/meta' }, false],
    ['unrelated Bash', 'Bash', { command: 'npx vitest run tests/foo.test.ts' }, true],
    ['unrelated Edit', 'Edit', { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }, true],
    ['unrelated mcp call', 'mcp__db__get_funnel', {}, true],
  ];
  for (const [name, tool, input, allow] of cases) {
    it(`${allow ? 'allows' : 'denies'}: ${name}`, () => {
      expect(call(tool, input).allow).toBe(allow);
    });
  }
});

describe('fail closed', () => {
  it('denies malformed events', () => {
    expect(hook.decide(null).allow).toBe(false);
    expect(hook.decide('x').allow).toBe(false);
    expect(hook.decide({}).allow).toBe(false);
    expect(hook.decide({ tool_name: 5 }).allow).toBe(false);
  });
  it('denies input that cannot be serialized', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(call('Bash', cyc).allow).toBe(false);
  });
  it('denies a getter that throws', () => {
    const bad = { tool_name: 'Bash', get tool_input(): never { throw new Error('boom'); } };
    expect(hook.decide(bad).allow).toBe(false);
  });
});

describe('as a process', () => {
  const run = (stdin: string) =>
    spawnSync('node', [resolve(ROOT, '.claude/hooks/settings-guard.cjs')], { input: stdin, encoding: 'utf8' });
  it('denies with permissionDecision deny on a bad event and on unparseable stdin', () => {
    for (const stdin of ['not json', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'curl x/api/settings/meta' } })]) {
      const r = run(stdin);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });
  it('is silent (allow) for an unrelated call', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('settings.json wiring', () => {
  it('has exactly one matcher for settings-guard with onFailure block that covers every tool', () => {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, '.claude/settings.json'), 'utf8'));
    const entries = cfg.hooks.PreToolUse.filter((e: any) => JSON.stringify(e).includes('settings-guard.cjs'));
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].onFailure).toBe('block');
    const re = new RegExp(`^(?:${entries[0].matcher})$`);
    for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'mcp__db__raw_query', 'mcp__playwright__browser_navigate']) {
      expect(re.test(t), t).toBe(true);
    }
  });
});
