import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { loadProfiles } from '../src/platform/runner.js';

const OPERATORS = { linkedin: 'linkedin-operator', naukri: 'naukri-operator' } as const;

// The four retired workers' tool lists (due-followups, new-outreach, inbox-recruiter-replies,
// naukri-search), embedded so the operators can be proven to hold no tool the workers did not.
const OLD_WORKER_TOOLS: Record<string, string[]> = {
  'due-followups': [
    'Skill', 'mcp__outreach__list_due_touches', 'mcp__outreach__escalate',
    'mcp__linkedin__linkedin_send_message', 'mcp__naukri__naukri_send_message',
  ],
  'new-outreach': [
    'Skill', 'mcp__outreach__next_contacts', 'mcp__outreach__escalate',
    'mcp__linkedin__linkedin_open', 'mcp__linkedin__linkedin_state',
    'mcp__linkedin__linkedin_check_connection_status', 'mcp__linkedin__linkedin_connect_send',
    'mcp__linkedin__linkedin_send_message', 'mcp__naukri__naukri_send_message',
    'mcp__db__list_queued_outreach', 'mcp__db__update_outreach_status',
  ],
  'inbox-recruiter-replies': [
    'Skill', 'mcp__linkedin__linkedin_open', 'mcp__linkedin__linkedin_state', 'mcp__linkedin__linkedin_scroll',
    'mcp__linkedin__linkedin_click', 'mcp__naukri__naukri_inbox', 'mcp__naukri__naukri_read_thread',
    'mcp__naukri__naukri_send_message', 'mcp__outreach__record_inbound', 'mcp__outreach__escalate',
  ],
  'naukri-search': [
    'mcp__naukri__naukri_search', 'mcp__naukri__naukri_open', 'mcp__naukri__naukri_state',
    'mcp__db__list_jobs', 'mcp__outreach__escalate',
  ],
};
const OLD_UNION = new Set(Object.values(OLD_WORKER_TOOLS).flat());
const NEW_ALLOWED = new Set([
  'mcp__linkedin__linkedin_layout', 'mcp__naukri__naukri_layout',
  'mcp__linkedin__linkedin_search_jobs', 'mcp__linkedin__linkedin_search_posts', 'mcp__naukri__naukri_discover',
  // browserctl engine tools (ref-based; commit classes need linkedin_arm_send)
  'mcp__linkedin__linkedin_snapshot', 'mcp__linkedin__linkedin_type', 'mcp__linkedin__linkedin_press_key',
  'mcp__linkedin__linkedin_wait_for', 'mcp__linkedin__linkedin_screenshot', 'mcp__linkedin__linkedin_click_at',
  'mcp__linkedin__linkedin_arm_send',
  // the same for Naukri (naukri_arm_send arms a thread send; the apply operator holds naukri_arm_apply)
  ...['snapshot', 'click', 'type', 'press_key', 'scroll', 'wait_for', 'screenshot', 'click_at', 'arm_send', 'arm_apply'].map((n) => `mcp__naukri__naukri_${n}`),
  'mcp__outreach__list_due_touches', 'mcp__outreach__next_contacts', 'mcp__outreach__record_inbound',
  'mcp__outreach__escalate', 'mcp__db__list_jobs', 'mcp__db__list_queued_outreach', 'mcp__db__update_outreach_status',
]);
const FORBIDDEN = ['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
const NKOP = ['layout', 'open', 'snapshot', 'click', 'type', 'press_key', 'scroll', 'wait_for', 'screenshot', 'click_at', 'arm_send', 'search', 'discover', 'inbox', 'read_thread'];
const OTHER: Record<string, string> = { linkedin: 'mcp__naukri__', naukri: 'mcp__linkedin__' };

function parse(name: string): { fm: string; body: string; tools: string[] } {
  const text = readFileSync(`.claude/agents/${name}.md`, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`no frontmatter in ${name}`);
  const lines = m[1].split(/\r?\n/).filter((l) => /^tools\s*:/.test(l));
  expect(lines.length).toBe(1);
  const tools = lines[0].replace(/^tools\s*:/, '').split(',').map((s) => s.trim()).filter(Boolean);
  return { fm: m[1], body: m[2], tools };
}

const cfg: Record<string, string[]> = JSON.parse(readFileSync('config/worker-tools.json', 'utf8'));
const profiles = loadProfiles('config/run-profiles.json', 'config/permission-sets.json');
const wake = profiles.outreach_wake;

describe('platform operators', () => {
  it('worker-tools.json has the operators, mail-operator and the apply operator', () => {
    expect(Object.keys(cfg).sort()).toEqual(['apply-operator', 'linkedin-operator', 'mail-operator', 'naukri-operator', 'source-operator']);
  });
  it('the four old worker files are gone', () => {
    for (const w of Object.keys(OLD_WORKER_TOOLS)) expect(existsSync(`.claude/agents/${w}.md`)).toBe(false);
  });
  it('linkedin-operator has exactly the brief tool list', () => {
    expect(cfg['linkedin-operator']).toEqual([
      'Skill', 'mcp__outreach__list_due_touches', 'mcp__outreach__next_contacts', 'mcp__outreach__record_inbound',
      'mcp__outreach__escalate', 'mcp__linkedin__linkedin_layout', 'mcp__linkedin__linkedin_open',
      'mcp__linkedin__linkedin_snapshot', 'mcp__linkedin__linkedin_click', 'mcp__linkedin__linkedin_type',
      'mcp__linkedin__linkedin_press_key', 'mcp__linkedin__linkedin_scroll', 'mcp__linkedin__linkedin_wait_for',
      'mcp__linkedin__linkedin_screenshot', 'mcp__linkedin__linkedin_click_at', 'mcp__linkedin__linkedin_arm_send',
      'mcp__linkedin__linkedin_search_jobs',
      'mcp__linkedin__linkedin_search_posts', 'mcp__db__list_queued_outreach', 'mcp__db__update_outreach_status',
    ]);
  });
  it('naukri-operator has exactly the brief tool list', () => {
    expect(cfg['naukri-operator']).toEqual([
      'Skill', 'mcp__outreach__list_due_touches', 'mcp__outreach__next_contacts', 'mcp__outreach__record_inbound',
      'mcp__outreach__escalate', ...NKOP.map((n) => `mcp__naukri__naukri_${n}`), 'mcp__db__list_jobs',
      'mcp__db__list_queued_outreach', 'mcp__db__update_outreach_status',
    ]);
  });

  for (const [platform, name] of Object.entries(OPERATORS)) {
    describe(name, () => {
      const { fm, body, tools } = parse(name);
      it('has name, sonnet model and a single tools line equal to config', () => {
        expect(fm).toContain(`name: ${name}`);
        expect(fm).toMatch(/^model: sonnet$/m);
        expect(tools).toEqual(cfg[name]);
      });
      it('tools are a subset of the old workers plus the layout tool and the listed outreach/db tools', () => {
        for (const t of tools) {
          expect(OLD_UNION.has(t) || NEW_ALLOWED.has(t), t).toBe(true);
        }
      });
      it('lists no Agent, Bash, Read, Write, Edit or tool of the other platform', () => {
        for (const t of tools) {
          expect(FORBIDDEN).not.toContain(t);
          expect(t.startsWith(OTHER[platform]), t).toBe(false);
          expect(t.startsWith('mcp__connect')).toBe(false);
          expect(t).not.toContain('*');
        }
      });
      it('has no accept tool and, for Naukri, no apply arm tool (the apply stage owns it)', () => {
        for (const t of tools) {
          expect(t.endsWith('_accept_invite')).toBe(false);
          if (platform === 'naukri') expect(t.endsWith('_arm_apply')).toBe(false);
        }
      });
      it('includes the platform layout tool', () => {
        expect(tools).toContain(`mcp__${platform}__${platform}_layout`);
      });
      it('carries the task sections, the shared rules and the layout memory protocol', () => {
        for (const s of ['## Task: followups', '## Task: new_outreach', '## Task: inbox', '## Task: discover']) {
          expect(body).toContain(s);
        }
        expect(body).toContain('## Rules every worker follows');
        expect(body).toContain('## Layout memory');
        for (const s of [`${platform}_layout`, 'layout=', 'LAYOUT_EXPLORE_BUDGET', 'layout_drift', 'logged_out', 'untrusted', 'escalate', 'quota']) {
          expect(body).toContain(s);
        }
        for (const w of ['halted', 'rate_limited', 'killed']) expect(body).toContain(w);
        expect(body).not.toMatch(/mcp__connect/);
      });
      it('treats layout=unknown as not learned yet (reported, never a layout_drift escalation)', () => {
        const rule = body.split('\n').find((l) => l.startsWith('2. Every `' + (platform + '_snapshot') + '`')) ?? '';
        expect(rule).toContain('not_learned');
        const driftPart = rule.slice(rule.indexOf('On `drift`'), rule.indexOf('On `unknown`') > 0 ? rule.indexOf('On `unknown`') : undefined);
        expect(driftPart).not.toContain('`unknown`');
        expect(rule.slice(rule.indexOf('On `unknown`'))).not.toMatch(/escalate` with reason `layout_drift`[^.]*unknown/);
      });
      it('every operator tool is in the wake profile allow list', () => {
        for (const t of tools) {
          if (t === 'Skill') expect(wake.builtin_tools).toContain('Skill');
          else expect(wake.allow, t).toContain(t);
        }
      });
    });
  }

  it('the wake profile allows both layout tools', () => {
    expect(wake.allow).toContain('mcp__linkedin__linkedin_layout');
    expect(wake.allow).toContain('mcp__naukri__naukri_layout');
  });
  it('the layout tools are read-only members of the read_only permission set', () => {
    const sets = JSON.parse(readFileSync('config/permission-sets.json', 'utf8')) as Record<string, { allow: string[] }>;
    expect(sets.read_only.allow).toContain('mcp__linkedin__linkedin_layout');
    expect(sets.read_only.allow).toContain('mcp__naukri__naukri_layout');
  });

  describe('task contracts carried over from the old workers', () => {
    const li = parse('linkedin-operator').body;
    const nk = parse('naukri-operator').body;
    it('linkedin: status check and state read come before drafting and sending', () => {
      expect(li.indexOf('linkedin_snapshot')).toBeGreaterThan(-1);
      expect(li.indexOf('linkedin_snapshot')).toBeLessThan(li.indexOf('linkedin_arm_send({kind: "connect_note"'));
      expect(li).toContain('https://www.linkedin.com/messaging/');
      expect(li).toContain('salary');
    });
    it('linkedin: inbox records inbound before replying and never sends on LinkedIn from the inbox', () => {
      expect(li).toContain('record_inbound');
      expect(li).toMatch(/inbox[\s\S]*never answer/i);
    });
    it('naukri: records inbound before replying, never applies', () => {
      expect(nk.indexOf('record_inbound')).toBeLessThan(nk.indexOf('naukri_arm_send({person_id, thread_ref, text, kind: "followup"})'));
      expect(nk).toMatch(/never apply/);
      expect(nk).toContain('salary');
    });
  });
});
