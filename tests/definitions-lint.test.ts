import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

// Lint over every agent, skill and command definition (plan 8A task 14).

const BUILTINS = new Set(['Skill', 'Agent', 'Task', 'Read']);

function scan(file: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, 'utf8').matchAll(re)) out.push(m[1]);
  return out;
}

/** server -> set of tool names, built from the source of every MCP server. */
function registry(): Map<string, Set<string>> {
  const reg = new Map<string, Set<string>>();
  const add = (server: string, tool: string) => {
    if (!reg.has(server)) reg.set(server, new Set());
    reg.get(server)!.add(tool);
  };
  for (const f of readdirSync('src/mcp')) {
    if (!f.endsWith('.ts')) continue;
    const server = f.replace(/\.ts$/, '');
    if (server === 'email') continue; // gmail is an external server, listed below
    for (const t of scan(`src/mcp/${f}`, /registerTool\(\s*'([A-Za-z0-9_]+)'/g)) add(server, t);
  }
  const li = readFileSync('src/mcp/linkedin.ts', 'utf8');
  const arr = /TOOL_NAMES = \[([\s\S]*?)\]/.exec(li)![1];
  for (const m of arr.matchAll(/'([a-z_]+)'/g)) add('linkedin', m[1]);
  for (const t of scan('src/mcp/naukri.ts', /'(naukri_[a-z_]+)'/g)) add('naukri', t);
  // apply.ts registers the external platforms through a loop over a literal list
  for (const p of ['linkedin', 'auto', 'greenhouse', 'lever', 'workday', 'ashby']) add('apply', p);
  // applier.ts registers its tools through a loop over the literal TOOL_NAMES list
  const ap = /TOOL_NAMES = \[([\s\S]*?)\]/.exec(readFileSync('src/mcp/applier.ts', 'utf8'))![1];
  for (const m of ap.matchAll(/'([a-z_]+)'/g)) add('applier', m[1]);
  for (const t of ['send_email', 'search_emails', 'read_email']) add('gmail', t);
  return reg;
}

const REG = registry();
const REAL = new Set<string>();
for (const [s, tools] of REG) for (const t of tools) REAL.add(`mcp__${s}__${t}`);

// Backticked identifiers of the form `word.word` or `word_word` that are not tools.
const NON_TOOL_ALLOW = new Set<string>([
  'linkedin_url', 'linkedin_profiles', 'linkedin_search', 'linkedin_jobs', 'linkedin_posts',
  'linkedin_reply_needed', 'linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message', 'naukri_job_id', 'linkedin_easy', 'db.sqlite', 'data.sqlite', 'db.ts',
]);

const SERVERS = [...REG.keys()];

function split(text: string): { fm: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error('no frontmatter');
  return { fm: m[1], body: m[2] };
}

interface Def { file: string; kind: 'agent' | 'skill' | 'command'; name: string; text: string; fm: string; body: string }
const defs: Def[] = [];
for (const f of readdirSync('.claude/agents').filter((x) => x.endsWith('.md')).sort()) {
  const text = readFileSync(`.claude/agents/${f}`, 'utf8');
  defs.push({ file: `.claude/agents/${f}`, kind: 'agent', name: f.replace(/\.md$/, ''), text, ...split(text) });
}
const skillDirs = readdirSync('.claude/skills', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const d of skillDirs) {
  const p = `.claude/skills/${d}/SKILL.md`;
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  defs.push({ file: p, kind: 'skill', name: d, text, ...split(text) });
}
for (const f of readdirSync('.claude/commands').filter((x) => x.endsWith('.md')).sort()) {
  const text = readFileSync(`.claude/commands/${f}`, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  defs.push({ file: `.claude/commands/${f}`, kind: 'command', name: f.replace(/\.md$/, ''), text, fm: m ? m[1] : '', body: m ? m[2] : text });
}
const agents = defs.filter((d) => d.kind === 'agent');

function toolsOf(d: Def): string[] {
  const lines = d.fm.split(/\r?\n/).filter((l) => /^tools\s*:/.test(l));
  expect(lines.length, d.file).toBe(1);
  return lines[0].replace(/^tools\s*:/, '').split(',').map((s) => s.trim()).filter(Boolean);
}

describe('registry sanity', () => {
  it('finds known tools', () => {
    for (const t of ['mcp__linkedin__linkedin_send_message', 'mcp__naukri__naukri_send_message', 'mcp__outreach__escalate',
      'mcp__db__save_followup_draft', 'mcp__apply__auto', 'mcp__gmail__send_email', 'mcp__resume__check_text']) {
      expect(REAL.has(t), t).toBe(true);
    }
  });
});

describe('agent tools lines', () => {
  for (const d of agents) {
    it(d.file, () => {
      const tools = toolsOf(d);
      if (d.name === 'hook-probe') {
        expect(tools).toEqual(['Read']);
        expect(d.text).toMatch(/never in the pipeline/i);
        return;
      }
      for (const t of tools) expect(BUILTINS.has(t) || REAL.has(t), `${d.name}: ${t}`).toBe(true);
    });
  }
});

describe('mcp__ tokens in prose are registered', () => {
  for (const d of defs) {
    it(d.file, () => {
      for (const m of d.text.matchAll(/mcp__[A-Za-z0-9-]+__[A-Za-z0-9_]+/g)) {
        expect(REAL.has(m[0]), `${d.file}: ${m[0]}`).toBe(true);
      }
    });
  }
});

describe('backticked server.tool and typed-tool references resolve', () => {
  for (const d of defs) {
    it(d.file, () => {
      for (const m of d.text.matchAll(/`([A-Za-z0-9_.-]+)(?:\(|`)/g)) {
        const id = m[1];
        if (NON_TOOL_ALLOW.has(id)) continue;
        const dot = /^([a-z][a-z-]*)\.([a-z_]+)$/.exec(id);
        if (dot && SERVERS.includes(dot[1])) {
          expect(REG.get(dot[1])!.has(dot[2]), `${d.file}: ${id}`).toBe(true);
          continue;
        }
        const bare = /^((?:linkedin|naukri)_[a-z_]+)$/.exec(id);
        if (bare) {
          const server = id.startsWith('linkedin') ? 'linkedin' : 'naukri';
          expect(REG.get(server)!.has(id), `${d.file}: ${id}`).toBe(true);
        }
      }
    });
  }
});

describe('scheduled operators match config/worker-tools.json', () => {
  const cfg: Record<string, string[]> = JSON.parse(readFileSync('config/worker-tools.json', 'utf8'));
  for (const w of ['linkedin-operator', 'naukri-operator']) {
    it(w, () => {
      const d = agents.find((a) => a.name === w)!;
      expect(toolsOf(d)).toEqual(cfg[w]);
    });
  }
});

describe('retired and legacy text is gone', () => {
  const RETIRED = /mcp__connect\b|\bconnect\.(find_linkedin_profile|check_connection_status|connect_send|send_linkedin_message|record_connection_status)\b|legacy connect|MAX_CONNECTS_PER_DAY|LEGACY_CONNECT_DISABLED|reviewed by the user/i;
  const files = [
    ...defs.map((d) => d.file),
    'config/permission-sets.json', 'config/run-profiles.json', 'config/worker-tools.json',
  ];
  for (const f of files) {
    it(f, () => {
      expect(readFileSync(f, 'utf8')).not.toMatch(RETIRED);
    });
  }
});

describe('sending agents state dry run, halted and the kill switch', () => {
  const isSend = (t: string) => t === 'mcp__gmail__send_email' || /_connect_send$/.test(t) || /_send_message$/.test(t) || t.startsWith('mcp__apply__');
  for (const d of agents) {
    if (!toolsOf(d).some(isSend)) continue;
    it(d.file, () => {
      expect(d.body).toMatch(/dry run/i);
      expect(d.body).toMatch(/halted/i);
      expect(d.body).toMatch(/kill switch/i);
    });
  }
});

describe('untrusted input and screened results', () => {
  const READER_SKILLS = ['match-jobs', 'tailor-resume', 'review-application', 'draft-outreach', 'draft-connect-note', 'draft-linkedin-message', 'manager'];
  const READER_COMMANDS = ['easy-apply-answer-fallback', 'easy-apply-control-fallback', 'ats-bootstrap-fieldmap', 'setup-resume'];
  const readers = defs.filter((d) =>
    (d.kind === 'agent' && d.name !== 'hook-probe') ||
    (d.kind === 'skill' && READER_SKILLS.includes(d.name)) ||
    (d.kind === 'command' && READER_COMMANDS.includes(d.name)));
  for (const d of readers) {
    it(`${d.file} says untrusted`, () => {
      expect(d.body).toMatch(/untrusted/i);
    });
  }
  const screened = agents.filter((d) => toolsOf(d).some((t) => t.startsWith('mcp__linkedin__') || t.startsWith('mcp__naukri__')));
  it('there are screened readers', () => {
    expect(screened.length).toBeGreaterThan(3);
  });
  for (const d of screened) {
    it(`${d.file} handles screened results`, () => {
      for (const w of ['injection_suspected', 'classifier_unavailable', 'classifier=unscreened']) expect(d.body, w).toContain(w);
    });
  }
});

describe('status commands', () => {
  for (const n of ['limits', 'working', 'health']) {
    it(n, () => {
      const d = defs.find((x) => x.kind === 'command' && x.name === n)!;
      expect(d.text).toContain(`npm run status -- ${n}`);
      expect(d.text).toMatch(/halted/i);
      expect(d.text).toMatch(/kill switch/i);
    });
  }
});

describe('skills', () => {
  it('every skill folder has SKILL.md with matching name and a one-line description', () => {
    for (const d of skillDirs) {
      const p = `.claude/skills/${d}/SKILL.md`;
      expect(existsSync(p), p).toBe(true);
      const { fm } = split(readFileSync(p, 'utf8'));
      expect(/^name:\s*(.+?)\s*$/m.exec(fm)?.[1], p).toBe(d);
      const desc = /^description:[ \t]*(\S.*)$/m.exec(fm);
      expect(desc, `${p} description`).not.toBeNull();
    }
  });
});
