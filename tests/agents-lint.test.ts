import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { loadProfiles } from '../src/platform/runner.js';

const WORKERS = ['due-followups', 'new-outreach', 'inbox-recruiter-replies', 'naukri-search'] as const;

const FORBIDDEN_EXACT = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task',
  'mcp__db__record_outcome', 'mcp__db__raw_query',
  'mcp__linkedin__linkedin_type', 'mcp__linkedin__linkedin_screenshot',
  'mcp__naukri__naukri_click', 'mcp__naukri__naukri_type',
];
const FORBIDDEN_PREFIX = ['mcp__playwright__', 'mcp__claude-in-chrome__', 'mcp__gmail__', 'mcp__apply__', 'mcp__connect__'];

// Snapshot of the agents' tool lines.
const SNAPSHOT: Record<string, string> = {
  discoverer: 'mcp__job-fetch__list_new_jobs, mcp__job-fetch__board_status, mcp__discover__linkedin_jobs, mcp__discover__linkedin_posts',
  'contact-finder': 'mcp__contacts__find_company_emails, mcp__linkedin__linkedin_find_profiles',
  sender: 'mcp__db__list_queued_outreach, mcp__db__list_skipped_outreach, mcp__db__update_outreach_status, mcp__db__record_email_sent, mcp__db__check_and_increment, mcp__gmail__send_email, mcp__apply__linkedin, mcp__apply__greenhouse, mcp__apply__lever, mcp__apply__workday, mcp__apply__ashby, mcp__db__approve_drafted_followups, mcp__db__list_followup_candidates, mcp__db__list_approved_followups, mcp__db__claim_followup_for_send, mcp__db__mark_followup_sent, mcp__db__mark_followup_failed, mcp__linkedin__linkedin_connect_send, mcp__linkedin__linkedin_send_message, mcp__linkedin__linkedin_check_connection_status, mcp__naukri__naukri_send_message',
  'followup-drafter': 'Skill, mcp__db__list_followup_candidates, mcp__db__save_followup_draft',
  'outreach-preparer': 'Skill, mcp__resume__get_base_resume, mcp__resume__render_resume, mcp__resume__check_text, mcp__resume__apply_review_edits, mcp__db__enqueue_outreach',
  matcher: 'Skill, mcp__resume__get_base_resume, mcp__gates__check_liveness',
  'reply-watcher': 'mcp__db__list_sent_emails, mcp__db__set_email_thread, mcp__db__triage_replies, mcp__db__record_reply_check, mcp__gmail__search_emails, mcp__gmail__read_email',
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
  for (const f of ['src/mcp/apply.ts', 'src/mcp/contacts.ts']) {
    const server = f.includes('apply') ? 'apply' : 'contacts';
    for (const m of readFileSync(f, 'utf8').matchAll(/registerTool\(\s*'([A-Za-z0-9_]+)'/g)) all.add(`mcp__${server}__${m[1]}`);
  }
  // apply.ts registers the external platforms through a loop over a literal list
  for (const p of ['greenhouse', 'lever', 'workday', 'ashby']) all.add(`mcp__apply__${p}`);
  all.add('mcp__gmail__send_email');
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
      it('every tool is registered', () => {
        for (const t of tools) {
          if (t === 'Skill') continue;
          expect(real.has(t), t).toBe(true);
        }
      });
      it('matches config/worker-tools.json exactly', () => {
        expect(tools).toEqual(config[name]);
      });
      it('body states the required rules', () => {
        for (const s of ['untrusted', 'escalate', 'quota']) expect(body).toContain(s);
      });
      it('stop rule names halted, rate_limited and killed', () => {
        for (const w of ['halted', 'rate_limited', 'killed']) expect(body).toContain(w);
      });
      it('has no type tool, and click only for the inbox reader', () => {
        for (const t of tools) {
          expect(t.endsWith('_type')).toBe(false);
          if (name !== 'inbox-recruiter-replies') expect(t.endsWith('_click')).toBe(false);
        }
      });
    });
  }
  it('worker-tools.json has exactly the four workers', () => {
    expect(Object.keys(config).sort()).toEqual([...WORKERS].sort());
  });
  it('per-worker body contracts', () => {
    expect(frontmatter('due-followups').body).toContain('kind');
    const no = frontmatter('new-outreach').body;
    expect(no.indexOf('linkedin_state')).toBeGreaterThan(-1);
    expect(no.indexOf('linkedin_state')).toBeLessThan(no.indexOf('linkedin_connect_send'));
    const ib = frontmatter('inbox-recruiter-replies').body;
    expect(ib).toContain('salary');
    expect(ib.indexOf('record_inbound')).toBeLessThan(ib.indexOf('naukri_send_message({person_id'));
    expect(ib).toContain('https://www.linkedin.com/messaging/');
    expect(frontmatter('naukri-search').body).toMatch(/never apply/);
  });
  it('inbox-recruiter-replies has no LinkedIn send tool', () => {
    expect(toolsOf('inbox-recruiter-replies')).not.toContain('mcp__linkedin__linkedin_send_message');
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
  it('sender holds the typed message tools', () => {
    const t = toolsOf('sender');
    for (const need of [
      'mcp__linkedin__linkedin_connect_send',
      'mcp__linkedin__linkedin_send_message',
      'mcp__linkedin__linkedin_check_connection_status',
      'mcp__naukri__naukri_send_message',
    ]) expect(t).toContain(need);
  });
  it('sender holds no Bash, Read, Write or WebFetch', () => {
    const t = toolsOf('sender');
    for (const bad of ['Bash', 'Read', 'Write', 'WebFetch']) expect(t).not.toContain(bad);
  });
});

describe('legacy connect MCP is not referenced by agents, skills, commands or config', () => {
  const LEGACY = /mcp__connect(__|\b)|\bconnect\.(find_linkedin_profile|check_connection_status|connect_send|send_linkedin_message|record_connection_status)\b|legacy connect/;
  const files: string[] = [];
  for (const f of readdirSync('.claude/agents')) if (f.endsWith('.md')) files.push(`.claude/agents/${f}`);
  for (const d of readdirSync('.claude/skills')) if (existsSync(`.claude/skills/${d}/SKILL.md`)) files.push(`.claude/skills/${d}/SKILL.md`);
  for (const f of readdirSync('.claude/commands')) if (f.endsWith('.md')) files.push(`.claude/commands/${f}`);
  files.push('.claude/settings.json', 'config/permission-sets.json', 'config/run-profiles.json', 'config/worker-tools.json');
  for (const f of files) {
    it(f, () => {
      expect(readFileSync(f, 'utf8')).not.toMatch(LEGACY);
    });
  }
});

describe('contact-finder and sender tools are registered and allowed for the hunt profile', () => {
  const real = realTools();
  const hunt = loadProfiles('config/run-profiles.json', 'config/permission-sets.json').hunt;
  for (const name of ['contact-finder', 'sender']) {
    for (const t of toolsOf(name)) {
      it(`${name}: ${t}`, () => {
        expect(real.has(t), `${t} is not a registered tool`).toBe(true);
        expect(hunt.allow, `${t} not allowed for profile hunt`).toContain(t);
      });
    }
  }
});

describe('Hacker News manual-review rule is retired (automated domain check)', () => {
  it('discoverer no longer asks for user review of Hacker News outreach', () => {
    const { body } = frontmatter('discoverer');
    expect(body).not.toContain('should be reviewed by the');
    expect(body).toContain('untrusted comment text');
    expect(body).toContain('`hackernews`');
  });
  it('contact-finder uses hn_check, passes job_id and skips profile searches', () => {
    const { body } = frontmatter('contact-finder');
    expect(body).toContain('hn_check');
    expect(body).toContain('job_id');
    expect(body).toContain('hn_domain_unmatched');
  });
});
