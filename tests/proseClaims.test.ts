import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { proseFindings } from '../src/proseClaims.js';
import { parseLoose } from '../scripts/eval/lib.js';

const base: any = {
  name: 'Test User', jobTitle: null, email: 't@example.com', phone: '+91 90000 00000',
  summary: 'Software Engineer with 3+ years of experience in frontend architecture, contract-driven API design and AI-integrated systems; architected a state management refactor that improved loading by 11 seconds.',
  experience: [
    { title: 'Software Engineer', company: 'Acme Labs', location: null, start: 'Jul 2025', end: 'Present', description: [
      'Led the architecture of a policy-driven governance layer centralizing MCP access control and model I/O auditing, reducing policy misconfiguration issues by ~50%.',
      'Designed contract-driven TypeScript APIs, reducing integration-related regressions by 70% as AI interfaces evolved.',
      'Directed a system-wide refactor of React state management, eliminating 9+ redundant API calls and reducing initial load time by 11 seconds.',
      'Built a violations ingestion pipeline across LLM, MCP and RAG flows, reducing incident investigation time by approximately 40% through centralized event tracing.',
      'Developed D3-based risk analytics dashboards to distinguish LLM vs. tool exposure patterns across 12+ policies.',
      'Coordinated cross-functional efforts between frontend, backend, and AI teams, integrating 3+ evolving model capabilities with governance constraints.',
    ] },
    { title: 'Web Developer', company: 'Beta Chain', location: null, start: 'Feb 2023', end: 'Jun 2025', description: [
      'Built secure Next.js frontend integrations using Lucid.js and Mesh.js, connecting 8+ smart contracts to a Haskell based backend.',
    ] },
  ],
  projects: [], education: [{ degree: 'BE', school: 'XYZ Univ', location: 'Pune', year: '2021' }],
  skills: [{ category: 'Frontend', items: ['React', 'Next.js', 'TypeScript'] }, { category: 'Backend', items: ['Node.js', 'Express.js', 'REST APIs'] }],
  certificates: [],
};
const clone = () => JSON.parse(JSON.stringify(base));
const kinds = (t: any, o: any = {}) => proseFindings(base, t, o).map((f) => `${f.severity}:${f.kind}:${f.value}`);

describe('proseFindings: synthetic judge violation classes', () => {
  it('base against itself has no findings', () => { expect(kinds(clone())).toEqual([]); });
  it('possessive "own" is not an ownership claim (P11)', () => {
    let t = clone(); t.experience[0].description[4] = 'Developed D3-based risk analytics dashboards with their own filter state across 12+ policies.';
    expect(kinds(t)).toEqual([]);
    t = clone(); t.summary += ' Comfortable working on my own initiative and shipping its own deployment checks.';
    expect(kinds(t)).toEqual([]);
    t = clone(); t.summary += ' Comfortable owning my own features.';
    expect(kinds(t)).toEqual(['block:scope:ownership: "owning"']);
  });
  it('ownership and end-to-end', () => {
    const t = clone(); t.summary += ' Comfortable owning features end to end.';
    expect(kinds(t)).toEqual(['block:scope:ownership: "owning"', 'block:scope:end-to-end: "end to end"']);
  });
  it('from scratch', () => {
    const t = clone(); t.summary = 'Software Engineer building applications from scratch.';
    expect(kinds(t)).toEqual(['block:scope:from-scratch: "from scratch"']);
  });
  it('technical direction', () => {
    const t = clone(); t.summary += ' Used to setting technical direction across frontend, backend and AI teams.';
    expect(kinds(t)).toEqual(['block:scope:tech-direction: "setting technical direction"']);
  });
  it('people leadership', () => {
    const t = clone(); t.experience[0].description[5] = 'Mentored 2 junior engineers on React patterns.';
    expect(kinds(t)).toEqual(['block:scope:people-lead: "Mentored"']);
  });
  it('size adjective', () => {
    const t = clone(); t.experience[0].description[2] = 'Directed a refactor of React state management across a large React codebase.';
    expect(kinds(t)).toEqual(['block:scope:scale: "large React codebase"']);
  });
  it('user-facing', () => {
    const t = clone(); t.summary += ' Integrated LLM features into user-facing products.';
    expect(kinds(t)).toEqual(['block:scope:user-facing: "user-facing"']);
  });
  it('lead verb over merged or different work', () => {
    let t = clone(); t.summary = 'Led LLM, MCP and RAG governance and observability work.';
    expect(kinds(t)[0]).toMatch(/^warn:lead:/);
    t = clone(); t.experience[0].description[0] = 'Led a payments platform migration for checkout.';
    expect(kinds(t)[0]).toMatch(/^block:lead:/);
  });
  it('"Led" for work the base says was "Directed" is accepted', () => {
    const t = clone(); t.experience[0].description[2] = 'Led a system-wide React state management refactor that cut initial load by 11 seconds.';
    expect(kinds(t)).toEqual([]);
  });
  it('stack-specific commercial years', () => {
    let t = clone(); t.summary = 'Software Engineer with 3+ years of commercial React and TypeScript experience.';
    expect(kinds(t)).toEqual(['block:years-scope:"3+ years of commercial React and TypeScript experience" adds to the base\'s 3+ years: commercial']);
    t = clone(); t.summary = 'Software Engineer with 3+ years of experience in frontend architecture and AI-integrated systems.';
    expect(kinds(t)).toEqual([]);
  });
  it('microservices', () => {
    const t = clone(); t.experience[0].description[1] = 'Designed contract-driven TypeScript APIs with microservice-style boundaries.';
    expect(kinds(t)).toEqual(['block:scope:microservices: "microservice"']);
  });
  it('skills-list-only tool: block in a bullet, warn in the summary', () => {
    let t = clone(); t.experience[0].description[1] = 'Built backend services in Node.js, reducing integration-related regressions by 70%.';
    expect(kinds(t)).toEqual(['block:tool-context:node.js is only in the skills list; no base bullet shows work with it']);
    t = clone(); t.summary += ' Backend-leaning focus on Node.js services.';
    expect(kinds(t)).toEqual(['warn:tool-context:node.js is only in the skills list; no base bullet shows work with it']);
  });
  it('technology the base never mentions', () => {
    const t = clone(); t.experience[0].description[1] = 'Deployed contract-driven TypeScript APIs on Kubernetes.';
    expect(kinds(t)).toEqual(['block:tool:kubernetes']);
  });
  it('a disclosed gap is not a claim', () => {
    const t = clone(); t.summary += ' Ruby on Rails is not in my daily toolkit yet.';
    expect(kinds(t)).toEqual([]);
  });
  it("an n't gap line is not a claim either (P4)", () => {
    let t = clone(); t.summary += " I haven't worked with Kubernetes yet.";
    expect(kinds(t)).toEqual([]);
    t = clone(); t.summary += " I haven't used Redux in production.";
    expect(kinds(t)).not.toContain('block:tool:redux');
  });
  it('a negation only excuses a tech term within 4 words of it (P12)', () => {
    let t = clone(); t.experience[0].description[1] = 'Deployed contract-driven TypeScript APIs on Kubernetes with no downtime.';
    expect(kinds(t)).toEqual(['block:tool:kubernetes']);
    t = clone(); t.experience[0].description[1] = 'Never short on ideas, deployed contract-driven TypeScript APIs on Kubernetes.';
    expect(kinds(t)).toEqual(['block:tool:kubernetes']);
    t = clone(); t.experience[0].description[1] = 'Designed contract-driven TypeScript APIs without Kubernetes.';
    expect(kinds(t)).toEqual([]);
  });
  it('headline: specialty words and posting-title copies warn, plain role words pass', () => {
    let t = clone(); t.jobTitle = 'Software Engineer, AI Agent Systems';
    expect(kinds(t)).toEqual(['warn:headline:"Software Engineer, AI Agent Systems" adds words not in any base title: ai, agent, systems']);
    t = clone(); t.jobTitle = 'Frontend Engineer';
    expect(kinds(t)).toEqual([]);
    t = clone(); t.jobTitle = 'Frontend Web Application Developer';
    expect(kinds(t, { jobTitle: 'Frontend Web Application Developer' })).toEqual(['warn:headline:"Frontend Web Application Developer" copies the posting title']);
  });
  it('posting echo', () => {
    const t = clone(); t.summary += ' Strong product and UI judgment.';
    expect(kinds(t, { jobDescription: 'Strong product and UI judgment with attention to interaction details.' })).toEqual(['warn:posting-echo:strong product', 'warn:posting-echo:ui judgment']);
  });
  it('a faithful reword passes clean', () => {
    const t = clone(); t.experience[0].description[2] = 'Directed a refactor of React state management that removed 9+ redundant API calls and cut initial load time by 11 seconds.';
    expect(kinds(t)).toEqual([]);
  });
});

// The baselines and base-resume fixture are local and git-ignored; skip cleanly when a user has not generated them.
const evalDir = 'scripts/eval/fixtures/baseline';
const evalBase = 'scripts/eval/fixtures/base-resume.json';
const haveEvalData = existsSync(evalDir) && existsSync(evalBase);
describe.skipIf(!haveEvalData)('proseFindings: frozen eval corpus regression', () => {
  const dir = evalDir;
  const realBase = haveEvalData ? JSON.parse(readFileSync(evalBase, 'utf8')) : null;
  const jobs = haveEvalData ? JSON.parse(readFileSync('scripts/eval/fixtures/jobs.json', 'utf8')) : [];
  // Every expected block below matches a span a blind judge flagged as a violation (2026-10-07 verdicts).
  const expected: Record<string, string[]> = {
    'B-remoteok_1134395.json': ['scope:ownership'],
    'B-remotive_2091062.json': ['scope:end-to-end', 'scope:ownership'],
    'B-remotive_2091133.json': ['scope:ownership'],
    'B-remotive_2091141.json': ['scope:scale', 'scope:user-facing'],
    'C-remoteok_1134395.json': ['scope:end-to-end', 'scope:ownership'],
    'C-remoteok_1136447.json': ['scope:tech-direction'],
    'C-remoteok_1137410.json': ['scope:ownership'],
    'C-remotive_2069746.json': ['scope:microservices'],
    'C-remotive_2091062.json': ['scope:ownership'],
    'C-remotive_2091133.json': ['scope:from-scratch', 'years-scope'],
    'C-remotive_2091141.json': ['scope:scale', 'scope:user-facing'],
  };
  for (const f of (haveEvalData ? readdirSync(dir) : []).filter((x) => /^[ABC]-.*\.json$/.test(x)).sort()) {
    it(`${f} blocks exactly ${JSON.stringify(expected[f] ?? [])}`, () => {
      const r = parseLoose(readFileSync(`${dir}/${f}`, 'utf8'));
      const job = jobs.find((j: any) => j.id === f.slice(2, -5).replace('_', ':'));
      const got = [...new Set(proseFindings(realBase, r, { jobDescription: job.description, jobTitle: job.title })
        .filter((x) => x.severity === 'block')
        .map((x) => (x.kind === 'scope' ? `scope:${x.value.split(':')[0]}` : x.kind)))].sort();
      expect(got).toEqual(expected[f] ?? []);
    });
  }
});

describe('proseFindings: fail-closed size cap and performance', () => {
  const ms = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t; };
  it('oversize tailored text blocks with the oversize reason', () => {
    const t = clone(); t.summary = `${'x '.repeat(10500)}Worked at Google as Staff Engineer. Grew revenue by 300%.`;
    expect(kinds(t)).toEqual(['block:oversize:oversize: tailored summary exceeds 20000 chars; not fact-checked']);
  });
  it('oversize bullet blocks too', () => {
    const t = clone(); t.experience[0].description[1] = 'y'.repeat(21000);
    expect(kinds(t)).toEqual(['block:oversize:oversize: tailored experience[0].description[1] exceeds 20000 chars; not fact-checked']);
  });
  it('oversize base text blocks', () => {
    const b = clone(); b.summary = 'z '.repeat(11000);
    expect(proseFindings(b, clone()).map((f) => `${f.severity}:${f.kind}:${f.value}`)).toEqual(['block:oversize:oversize: base summary exceeds 20000 chars; not fact-checked']);
  });
  it('normal-size text is unaffected', () => {
    const t = clone(); t.summary += ' Comfortable owning features end to end.';
    expect(kinds(t).some((k) => k.includes('oversize'))).toBe(false);
  });
  it('1 x 50000 digits through proseFindings is fast (oversize gate) and 19000 digits is fast (regex bound)', () => {
    let t = clone(); t.summary = '1'.repeat(50000);
    expect(ms(() => proseFindings(base, t))).toBeLessThan(1000);
    t = clone(); t.summary = `${'1'.repeat(19000)} years of experience`;
    expect(ms(() => proseFindings(base, t))).toBeLessThan(1000);
  });
  it('techClaims is linear on repeated negations', () => {
    const t = clone(); t.summary = 'not react '.repeat(1900);
    expect(ms(() => proseFindings(base, t))).toBeLessThan(1000);
  });
});

describe('proseFindings: golang spelling (case-insensitive) vs the verb "go"', () => {
  for (const spelling of ['golang', 'Golang', 'GOLANG']) {
    it(`blocks "${spelling}" claimed in the summary`, () => {
      const t = clone(); t.summary += ` Most of my backend work is in ${spelling}.`;
      expect(kinds(t)).toContain('block:tool:golang');
    });
  }
  it('still blocks capitalised "Go" after in/with/using', () => {
    const t = clone(); t.summary += ' Most of my backend work is in Go.';
    expect(kinds(t)).toContain('block:tool:golang');
  });
  it('does not treat the verb "go" as Golang', () => {
    const t = clone(); t.summary += ' Happy to go to meetings with frontend, backend and AI teams.';
    expect(kinds(t).filter((k) => k.includes('golang'))).toEqual([]);
    const u = clone(); u.summary += ' I go to meetings weekly.';
    expect(kinds(u).filter((k) => k.includes('golang'))).toEqual([]);
  });
});
