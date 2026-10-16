import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProfiles } from '../src/platform/runner.js';
import { TOOL_NAMES } from '../src/mcp/scout.js';

const text = readFileSync('.claude/agents/source-operator.md', 'utf8');
const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)!;
const tools = m[1]!.split(/\r?\n/).filter((l) => /^tools\s*:/.test(l))[0]!.replace(/^tools\s*:/, '').split(',').map((s) => s.trim());

describe('source-operator definition', () => {
  it('has exactly the scout tools plus db list_jobs and escalate', () => {
    expect(tools).toEqual([...TOOL_NAMES.map((t) => `mcp__scout__${t}`), 'mcp__db__list_jobs', 'mcp__outreach__escalate']);
  });
  it('has no Skill, Write, Edit, Bash, Read, web, gmail, apply, linkedin or naukri tool', () => {
    for (const t of tools) {
      expect(['Skill', 'Write', 'Edit', 'Bash', 'Read', 'WebFetch', 'WebSearch', 'Agent', 'Task']).not.toContain(t);
      expect(t).not.toMatch(/^mcp__(gmail|apply|linkedin|naukri|playwright|claude-in-chrome)__/);
    }
  });
  it('is sonnet, never types, applies or sends, and states the rules', () => {
    expect(m[1]).toMatch(/^model: sonnet$/m);
    expect(tools.some((t) => t.endsWith('_type'))).toBe(false);
    for (const s of ['untrusted', 'escalate', 'quota', 'halted', 'rate_limited', 'killed', 'never apply']) expect(m[2]).toContain(s);
  });
  it('config/worker-tools.json lists the same tools, and the wake profile allows every one of them', () => {
    const cfg = JSON.parse(readFileSync('config/worker-tools.json', 'utf8')) as Record<string, string[]>;
    expect(cfg['source-operator']).toEqual(tools);
    const wake = loadProfiles('config/run-profiles.json', 'config/permission-sets.json').outreach_wake;
    for (const t of tools) expect(wake.allow, t).toContain(t);
  });
  it('the wake profile passes the scout flags and search budgets through, but no Serper key or credentials', () => {
    const p = JSON.parse(readFileSync('config/run-profiles.json', 'utf8')).profiles.outreach_wake as { env_keys: string[]; env_prefixes: string[] };
    for (const k of ['WEB_', 'SCOUT_', 'DORK_', 'SEARCH_']) expect(p.env_prefixes).toContain(k);
    expect(p.env_keys).toContain('APPLY_DRY_RUN');
    expect(p.env_keys.concat(p.env_prefixes).some((k) => /SERPER|PASSWORD|TOKEN|SECRET/.test(k))).toBe(false);
  });
});
