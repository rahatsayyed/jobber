import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOL_NAMES } from '../src/mcp/applier.js';

// Lint over the apply-operator definition (plan 8G-2 task 21). The agent file is text, never run.

const EXPECTED = [
  'mcp__db__list_queued_outreach',
  'mcp__db__update_outreach_status',
  ...['open', 'state', 'autofill', 'fill', 'choose', 'upload', 'next', 'submit', 'escalate', 'recipe', 'propose_recipe', 'limits', 'close']
    .map((t) => `mcp__applier__apply_${t}`),
  'mcp__applier__site_login',
  'mcp__applier__site_signup',
  'mcp__applier__site_open_link',
  ...['open', 'state', 'click', 'type', 'layout'].map((t) => `mcp__naukri__naukri_${t}`),
];

const text = readFileSync('.claude/agents/apply-operator.md', 'utf8');
const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
if (!m) throw new Error('no frontmatter in apply-operator');
const fm = m[1];
const body = m[2];
const toolLines = fm.split(/\r?\n/).filter((l) => /^tools\s*:/.test(l));
const tools = toolLines[0]?.replace(/^tools\s*:/, '').split(',').map((s) => s.trim()).filter(Boolean) ?? [];

describe('apply-operator', () => {
  it('has name, sonnet model and a single tools line', () => {
    expect(fm).toContain('name: apply-operator');
    expect(fm).toMatch(/^model: sonnet$/m);
    expect(toolLines.length).toBe(1);
  });
  it('tool list is exactly the committed list', () => {
    expect(tools).toEqual(EXPECTED);
    const cfg: Record<string, string[]> = JSON.parse(readFileSync('config/worker-tools.json', 'utf8'));
    expect(cfg['apply-operator']).toEqual(EXPECTED);
  });
  it('every applier tool is a registered applier tool', () => {
    for (const t of tools.filter((x) => x.startsWith('mcp__applier__'))) {
      expect((TOOL_NAMES as readonly string[]).includes(t.replace('mcp__applier__', '')), t).toBe(true);
    }
  });
  it('no Write, Edit, Bash or Skill', () => {
    for (const bad of ['Write', 'Edit', 'Bash', 'Skill', 'Read', 'Agent', 'Task']) expect(tools).not.toContain(bad);
    for (const t of tools) expect(t.startsWith('mcp__') && !t.includes('*')).toBe(true);
  });
  it('gmail tools absent from the default definition', () => {
    expect(tools.some((t) => t.startsWith('mcp__gmail__'))).toBe(false);
    expect(fm + body).not.toMatch(/mcp__gmail__/);
    expect(body).toContain('SITE_MAIL_VERIFY');
  });
  it('no old apply MCP, linkedin MCP or screenshot tool', () => {
    for (const t of tools) {
      expect(t.startsWith('mcp__apply__')).toBe(false);
      expect(t.startsWith('mcp__linkedin__')).toBe(false);
      expect(t).not.toBe('mcp__applier__apply_screenshot');
    }
  });
  it('states the stop rules and the checkbox rule', () => {
    for (const w of ['needs_owner', 'halted', 'rate_limited', 'kill switch', 'CAPTCHA', 'MFA', 'phone', 'dry run']) {
      expect(body, w).toContain(w);
    }
    expect(body).toMatch(/never (solve|solved)/i);
    expect(body).toMatch(/marketing/i);
    expect(body).toMatch(/never check/i);
    expect(body).toMatch(/unchecked/i);
    expect(body).toMatch(/one application at a time/i);
    expect(body).toContain('APPLY_LINKEDIN_EASY=true');
    expect(body).toContain('untrusted');
    expect(body).toContain('quota');
    expect(body).toContain('injection_suspected');
    expect(body).toContain('classifier_unavailable');
    expect(body).toContain('classifier=unscreened');
  });
  it('states refs-only and no URL navigation', () => {
    expect(body).toMatch(/refs only/i);
    expect(body).toMatch(/never type a value/i);
    expect(body).toMatch(/never navigate by URL/i);
    expect(body).toContain('exact question');
    expect(body).toContain('custom');
  });
  it('result JSON shape is documented', () => {
    for (const k of ['"operator"', '"applied"', 'submitted', 'held', 'manual_review', 'needs_owner', 'failed', 'rate_limited', 'queued', '"recipe"', 'matches', 'misses', 'job_id', 'reason', 'question']) {
      expect(body, k).toContain(k);
    }
    expect(body).toContain('apply-operator');
  });
  it('Verification section covers owner_assist default and the gated gmail mode', () => {
    const v = body.slice(body.search(/^## Verification$/m));
    for (const w of ['owner_assist', 'email_verification', 'SITE_MAIL_VERIFY=gmail', 'SITE_MAIL_SENDERS', 'site_open_link', 'when the wake profile adds the Gmail read tools','untrusted']) expect(v, w).toContain(w);
    expect(v).not.toContain('Filled in by plan');
  });
  it('routes by apply_platform and keeps a Verification placeholder section', () => {
    for (const p of ['linkedin_easy', 'naukri', 'browser', 'naukri_apply']) expect(body, p).toContain(p);
    expect(body).toMatch(/^## Verification$/m);
  });
});
