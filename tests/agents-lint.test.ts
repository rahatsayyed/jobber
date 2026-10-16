import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { loadProfiles } from '../src/platform/runner.js';

const WORKERS = ['linkedin-operator', 'naukri-operator', 'source-operator'] as const;

const FORBIDDEN_EXACT = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task',
  'mcp__db__record_outcome', 'mcp__db__raw_query',
  'mcp__linkedin__linkedin_type', 'mcp__linkedin__linkedin_screenshot',
  'mcp__naukri__naukri_click', 'mcp__naukri__naukri_type',
];
const FORBIDDEN_PREFIX = ['mcp__playwright__', 'mcp__claude-in-chrome__', 'mcp__gmail__', 'mcp__apply__', 'mcp__connect__'];

// Snapshot of the agents' tool lines.
const SNAPSHOT: Record<string, string> = {
  'contact-finder': 'mcp__contacts__find_company_emails, mcp__linkedin__linkedin_find_profiles',
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
  const sc = readFileSync('src/mcp/scout.ts', 'utf8');
  for (const m of /TOOL_NAMES = \[([\s\S]*?)\]/.exec(sc)![1].matchAll(/'([a-z_]+)'/g)) all.add(`mcp__scout__${m[1]}`);
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
      it('has no type tool, and click only for the LinkedIn inbox reader', () => {
        for (const t of tools) {
          expect(t.endsWith('_type')).toBe(false);
          // scout_click refuses submit-like controls in code (tests/scout-tools.test.ts)
          if (name !== 'linkedin-operator' && t !== 'mcp__scout__scout_click') expect(t.endsWith('_click')).toBe(false);
        }
      });
      it('has no mcp__connect reference', () => {
        expect(fm + body).not.toMatch(/mcp__connect/);
      });
    });
  }
  it('worker-tools.json has the three operators plus mail-operator', () => {
    expect(Object.keys(config).sort()).toEqual([...WORKERS, 'mail-operator'].sort());
  });
  it('per-operator body contracts', () => {
    const li = frontmatter('linkedin-operator').body;
    expect(li).toContain('kind');
    expect(li.indexOf('linkedin_state')).toBeGreaterThan(-1);
    expect(li.indexOf('linkedin_state')).toBeLessThan(li.indexOf('linkedin_connect_send'));
    expect(li).toContain('salary');
    expect(li.indexOf('record_inbound')).toBeGreaterThan(-1);
    expect(li).toContain('https://www.linkedin.com/messaging/');
    const nk = frontmatter('naukri-operator').body;
    expect(nk).toContain('salary');
    expect(nk.indexOf('record_inbound')).toBeLessThan(nk.indexOf('naukri_send_message({person_id, thread_ref, text, kind: "followup"})'));
    expect(nk).toMatch(/never apply/);
  });
  it('linkedin-operator has no inbox LinkedIn send path and cannot record outcomes', () => {
    expect(frontmatter('linkedin-operator').body).toMatch(/never answer/);
    expect(toolsOf('linkedin-operator')).not.toContain('mcp__db__record_outcome');
    expect(toolsOf('naukri-operator')).not.toContain('mcp__db__record_outcome');
  });
});

describe('existing agents are unchanged', () => {
  for (const [name, line] of Object.entries(SNAPSHOT)) {
    it(name, () => {
      expect(toolsOf(name).join(', ')).toBe(line);
    });
  }
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

describe('contact-finder tools are registered and allowed for a send-capable profile', () => {
  const real = realTools();
  const hunt = loadProfiles('tests/fixtures/runner-send-profile.json', 'config/permission-sets.json').hunt;
  for (const name of ['contact-finder']) {
    for (const t of toolsOf(name)) {
      it(`${name}: ${t}`, () => {
        expect(real.has(t), `${t} is not a registered tool`).toBe(true);
        expect(hunt.allow, `${t} not allowed for profile hunt`).toContain(t);
      });
    }
  }
});

describe('Hacker News manual-review rule is retired (automated domain check)', () => {
  it('contact-finder uses hn_check, passes job_id and skips profile searches', () => {
    const { body } = frontmatter('contact-finder');
    expect(body).toContain('hn_check');
    expect(body).toContain('job_id');
    expect(body).toContain('hn_domain_unmatched');
    expect(body).toContain('hn_job_unknown');
    expect(body).toContain('unknown_job');
    expect(body).toContain('NO `hn_check`');
    expect(body).not.toContain('accept both');
  });
});
