import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const WORKERS = ['due-followups', 'new-outreach', 'inbox-recruiter-replies', 'naukri-search'] as const;
const SEND_WORKERS = ['due-followups', 'new-outreach', 'inbox-recruiter-replies'];

// Tools Tasks 12 and 13 will register; remove from here as they land.
const PLANNED_TOOLS = [
  'mcp__naukri__naukri_search',
  'mcp__naukri__naukri_inbox',
  'mcp__naukri__naukri_read_thread',
  'mcp__naukri__naukri_send_message',
];

const FORBIDDEN_EXACT = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task',
  'mcp__db__record_outcome', 'mcp__db__raw_query',
  'mcp__linkedin__linkedin_type', 'mcp__linkedin__linkedin_screenshot',
  'mcp__naukri__naukri_click', 'mcp__naukri__naukri_type',
];
const FORBIDDEN_PREFIX = ['mcp__playwright__', 'mcp__claude-in-chrome__', 'mcp__gmail__', 'mcp__apply__', 'mcp__connect__'];

// Snapshot of the existing agents' tool lines. sender is updated deliberately by Task 14.
const SNAPSHOT: Record<string, string> = {
  discoverer: 'mcp__job-fetch__list_new_jobs, mcp__job-fetch__board_status, mcp__discover__linkedin_jobs, mcp__discover__linkedin_posts',
  'contact-finder': 'mcp__contacts__find_company_emails, mcp__connect__find_linkedin_profile',
  'followup-drafter': 'Skill, mcp__db__list_followup_candidates, mcp__db__save_followup_draft',
  'outreach-preparer': 'Skill, mcp__resume__get_base_resume, mcp__resume__render_resume, mcp__resume__check_text, mcp__resume__apply_review_edits, mcp__db__enqueue_outreach',
  matcher: 'Skill, mcp__resume__get_base_resume, mcp__gates__check_liveness',
  'reply-watcher': 'mcp__db__list_sent_emails, mcp__db__set_email_thread, mcp__db__triage_replies, mcp__gmail__search_emails, mcp__gmail__read_email',
};

function frontmatter(name: string): { fm: string; body: string } {
  const text = readFileSync(`.claude/agents/${name}.md`, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`no frontmatter in ${name}`);
  return { fm: m[1], body: m[2] };
}
function toolLines(fm: string): string[] {
  return fm.split(/\r?\n/).filter((l) => /^tools\s*:/.test(l));
}
function toolsOf(name: string): string[] {
  const lines = toolLines(frontmatter(name).fm);
  expect(lines.length).toBe(1);
  return lines[0].replace(/^tools\s*:/, '').split(',').map((s) => s.trim()).filter(Boolean);
}

function registered(file: string): Set<string> {
  const src = readFileSync(file, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/registerTool\(\s*'([A-Za-z0-9_]+)'/g)) out.add(m[1]);
  return out;
}
function realTools(): Set<string> {
  const all = new Set<string>();
  const li = readFileSync('src/mcp/linkedin.ts', 'utf8');
  const arr = /TOOL_NAMES = \[([\s\S]*?)\]/.exec(li)![1];
  for (const m of arr.matchAll(/'([a-z_]+)'/g)) all.add(`mcp__linkedin__${m[1]}`);
  for (const t of registered('src/mcp/outreach.ts')) all.add(`mcp__outreach__${t}`);
  for (const t of registered('src/mcp/db.ts')) all.add(`mcp__db__${t}`);
  const nk = readFileSync('src/mcp/naukri.ts', 'utf8');
  for (const m of nk.matchAll(/'(naukri_[a-z_]+)'/g)) all.add(`mcp__naukri__${m[1]}`);
  return all;
}

const config: Record<string, string[]> = JSON.parse(readFileSync('config/worker-tools.json', 'utf8'));

describe('worker agents', () => {
  const real = realTools();
  it('sanity: the registry scan found known tools', () => {
    expect(real.has('mcp__linkedin__linkedin_send_message')).toBe(true);
    expect(real.has('mcp__outreach__escalate')).toBe(true);
    expect(real.has('mcp__db__update_outreach_status')).toBe(true);
    expect(real.has('mcp__db__list_jobs')).toBe(true);
  });
  for (const name of WORKERS) {
    describe(name, () => {
      const { fm, body } = frontmatter(name);
      const tools = toolsOf(name);
      it('has sonnet model, name and a single tools line', () => {
        expect(fm).toContain(`name: ${name}`);
        expect(fm).toMatch(/^model: sonnet$/m);
        expect(toolLines(fm).length).toBe(1);
      });
      it('tool names are well formed, no wildcard', () => {
        for (const t of tools) {
          expect(t === 'Skill' || /^mcp__[a-z0-9-]+__[A-Za-z0-9_]+$/.test(t)).toBe(true);
          expect(t).not.toContain('*');
        }
      });
      it('no forbidden tool', () => {
        for (const t of tools) {
          expect(FORBIDDEN_EXACT).not.toContain(t);
          for (const p of FORBIDDEN_PREFIX) expect(t.startsWith(p)).toBe(false);
        }
      });
      it('every tool is real or explicitly planned', () => {
        for (const t of tools) {
          if (t === 'Skill') continue;
          expect(real.has(t) || PLANNED_TOOLS.includes(t), t).toBe(true);
        }
      });
      it('matches config/worker-tools.json exactly', () => {
        expect(tools).toEqual(config[name]);
      });
      it('body states the required rules', () => {
        for (const s of ['untrusted', 'escalate', 'quota']) expect(body).toContain(s);
      });
      if (SEND_WORKERS.includes(name)) {
        it('has no type tool, and click only for the inbox reader', () => {
          for (const t of tools) {
            expect(/_type$/.test(t)).toBe(false);
            if (name !== 'inbox-recruiter-replies') expect(/_click$/.test(t)).toBe(false);
          }
        });
      }
    });
  }
  it('worker-tools.json has exactly the four workers', () => {
    expect(Object.keys(config).sort()).toEqual([...WORKERS].sort());
  });
  it('inbox-recruiter-replies cannot record outcomes', () => {
    expect(toolsOf('inbox-recruiter-replies')).not.toContain('mcp__db__record_outcome');
  });
});

describe('existing agents are unchanged', () => {
  for (const [name, line] of Object.entries(SNAPSHOT)) {
    it(name, () => {
      expect(toolsOf(name).join(', ')).toBe(line);
    });
  }
  it('sender holds no Bash, Read, Write or WebFetch', () => {
    const t = toolsOf('sender');
    for (const bad of ['Bash', 'Read', 'Write', 'WebFetch']) expect(t).not.toContain(bad);
  });
});
