import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkOutreachText, checkResume, loadFactGateConfig } from '../src/resumeFacts.js';
import { getBaseResume } from '../src/resume.js';

const base: any = {
  name: 'Test User', jobTitle: null, email: 't@example.com', phone: '+91 90000 00000',
  summary: 'Software Engineer with 3+ years of experience in frontend architecture and AI-integrated systems; architected a state management refactor that improved loading by 11 seconds.',
  experience: [{ title: 'Software Engineer', company: 'Acme Labs', location: null, start: 'Jul 2025', end: 'Present', description: [
    'Led the architecture of a policy-driven governance layer centralizing MCP access control, reducing policy misconfiguration issues by ~50%.',
    'Directed a system-wide refactor of React state management, eliminating 9+ redundant API calls and reducing initial load time by 11 seconds.',
  ] }],
  projects: [], education: [{ degree: 'BE', school: 'XYZ Univ', location: 'Pune', year: '2021' }],
  skills: [{ category: 'Frontend', items: ['React', 'TypeScript'] }, { category: 'Backend', items: ['Node.js'] }], certificates: [],
};
const clone = () => JSON.parse(JSON.stringify(base));
const config = { allow_metrics: [], allow_facts: [], forbidden_phrases: ['passionate about'], warn_phrases: ['spearheaded'] };
const O = { config };

describe('checkResume', () => {
  it('passes the base against itself', () => {
    expect(checkResume(base, clone(), O)).toEqual({ verdict: 'pass', invented: [], unsupported: [], forbidden: [], warnings: [], configMissing: false });
  });
  it('passes the real base resume against itself with the real config', () => {
    expect(checkResume(getBaseResume(), getBaseResume()).verdict).toBe('pass');
  });
  it('blocks a forbidden phrase', () => {
    const t = clone(); t.summary += ' I am passionate about clean code.';
    const r = checkResume(base, t, O);
    expect(r.verdict).toBe('block');
    expect(r.forbidden).toEqual(['passionate about']);
  });
  it('warns on a warn phrase the base does not use', () => {
    const t = clone(); t.experience[0].description[0] = t.experience[0].description[0].replace('Led', 'Spearheaded');
    expect(checkResume(base, t, O)).toMatchObject({ verdict: 'warn', warnings: ['phrase:spearheaded'] });
  });
  it('blocks a noun-bound count inflation', () => {
    const t = clone(); t.summary += ' Grew the platform to 50k users.';
    expect(checkResume(base, t, O).invented).toEqual(['metric:50k', 'count:50k users']);
  });
  it('blocks prose escalation with a location and honours allow_facts', () => {
    const t = clone(); t.summary += ' Comfortable owning features end to end.';
    expect(checkResume(base, t, O).unsupported).toEqual(['scope:ownership: "owning" @summary[1]', 'scope:end-to-end: "end to end" @summary[1]']);
    expect(checkResume(base, t, { config: { ...config, allow_facts: ['owning', 'end to end'] } }).verdict).toBe('pass');
  });
  it('allow_metrics admits a confirmed number', () => {
    const t = clone(); t.summary += ' Cut costs by 25%.';
    expect(checkResume(base, t, O).verdict).toBe('block');
    expect(checkResume(base, t, { config: { ...config, allow_metrics: ['25%'] } }).verdict).toBe('pass');
  });
  it('reports a missing config as a warning, never silently', () => {
    expect(checkResume(base, clone(), { config, configMissing: true })).toMatchObject({ verdict: 'warn', configMissing: true });
  });
});

describe('loadFactGateConfig', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'factgate-'));
  it('missing file -> missing:true with empty lists', () => {
    expect(loadFactGateConfig(path.join(dir, 'nope.json'))).toEqual({ config: { allow_metrics: [], allow_facts: [], forbidden_phrases: [], warn_phrases: [] }, missing: true });
  });
  it('malformed JSON throws (fail closed)', () => {
    const f = path.join(dir, 'bad.json'); writeFileSync(f, '{nope');
    expect(() => loadFactGateConfig(f)).toThrow();
  });
  it('a non-string-array key throws', () => {
    const f = path.join(dir, 'bad2.json'); writeFileSync(f, JSON.stringify({ forbidden_phrases: 'x' }));
    expect(() => loadFactGateConfig(f)).toThrow(/forbidden_phrases must be an array of strings/);
  });
  it('the shipped config parses', () => {
    expect(loadFactGateConfig().missing).toBe(false);
  });
});

describe('checkOutreachText', () => {
  it('passes a truthful email whose footer URL has digits', () => {
    expect(checkOutreachText('Hi Priya, I cut initial load time by 11 seconds with a React state refactor. Happy to share more. Portfolio: https://x.dev/p2', base, O).verdict).toBe('pass');
  });
  it('blocks invented multipliers, team size, leadership and tools', () => {
    const r = checkOutreachText('I grew revenue 3x and led a team of 6 engineers on Kubernetes.', base, O);
    expect(r.verdict).toBe('block');
    expect(r.invented).toEqual(['metric:3x', 'metric:6 engineers']);
    expect(r.unsupported).toEqual(expect.arrayContaining(['tool:kubernetes']));
  });
  it('does not block an honest gap line (P4)', () => {
    const a = checkOutreachText("I haven't worked with Kubernetes yet, but my React state refactor cut load time by 11 seconds.", base, O);
    expect(a.invented).toEqual([]);
    expect(a.unsupported).toEqual([]);
    const b = checkOutreachText("I haven't used Redux in production, but my React state refactor cut load time by 11 seconds.", base, O);
    expect(b.invented).toEqual([]);
    expect(b.unsupported).toEqual([]);
    expect(b.verdict).not.toBe('block');
  });
  it('does not block a quoted posting title when job_title and company are passed (P4)', () => {
    const note = 'Hi Priya, I saw the Full Stack Developer - React.js & Redux opening at Jobdost. My React state refactor cut load time by 11 seconds.';
    expect(checkOutreachText(note, base, O).unsupported).toContain('tool:redux');
    const r = checkOutreachText(note, base, { ...O, jobTitle: 'Full Stack Developer - React.js & Redux', company: 'Jobdost' });
    expect(r.unsupported).toEqual([]);
    expect(r.verdict).not.toBe('block');
  });
  it('still blocks an affirmative tool claim made next to a gap line', () => {
    const r = checkOutreachText("I haven't worked with Kubernetes yet. I deployed the frontend on Terraform.", base, O);
    expect(r.unsupported).toEqual(expect.arrayContaining(['tool:terraform']));
  });
  it('accepts a claim that comes from extraSource (the original sent email)', () => {
    expect(checkOutreachText('As I mentioned, the 25% faster builds came from layer caching.', base, { ...O, extraSource: 'Docker layer caching gave 25% faster builds.' }).verdict).toBe('pass');
  });
});

describe('posting-context blanking (fix round 1)', () => {
  const realTitle = 'Full Stack Developer - React js & Redux';
  const jobdost = 'Hi Priya, I saw the Full Stack Developer - React.js & Redux opening at Jobdost. My React state refactor cut load time by 11 seconds.';
  it('matches the undotted real title against a dotted quote', () => {
    const r = checkOutreachText(jobdost, base, { ...O, jobTitle: realTitle, company: 'Jobdost' });
    expect(r.unsupported).toEqual([]);
    expect(r.verdict).not.toBe('block');
  });
  it('matches across an en dash and ReactJS spelling', () => {
    const note = 'I noticed the Full Stack Developer – ReactJS & Redux role at Jobdost. My React state refactor cut load time by 11 seconds.';
    const r = checkOutreachText(note, base, { ...O, jobTitle: realTitle, company: 'Jobdost' });
    expect(r.unsupported).toEqual([]);
  });
  it('does not hide a real claim that merely repeats the title', () => {
    expect(checkOutreachText('I have 3 years as a Kubernetes Engineer running clusters.', base, { ...O, jobTitle: 'Kubernetes Engineer' }).unsupported).toContain('tool:kubernetes');
  });
  it('does not hide a real claim that repeats the company', () => {
    expect(checkOutreachText('I built the Stripe integration at Stripe.', base, { ...O, company: 'Stripe' }).unsupported).toContain('tool:stripe');
  });
  it('blanks a cued posting mention of title and company', () => {
    const r = checkOutreachText('I noticed the Kubernetes Engineer opening at Stripe.', base, { ...O, jobTitle: 'Kubernetes Engineer', company: 'Stripe' });
    expect(r.unsupported).toEqual([]);
  });
  it('blanks a quoted title with no cue word', () => {
    const r = checkOutreachText('Your "Kubernetes Engineer" is a great fit for me.', base, { ...O, jobTitle: 'Kubernetes Engineer' });
    expect(r.unsupported).toEqual([]);
  });
  it('still blocks the second sentence of a mixed note', () => {
    const r = checkOutreachText('I saw the Redux Developer role. I shipped Redux stores for 3 years.', base, { ...O, jobTitle: 'Redux Developer' });
    expect(r.unsupported).toContain('tool:redux');
  });
  it('extraSource also feeds the prose rules', () => {
    const extra = 'I enjoy owning features end to end.';
    const reply = 'As I said, I enjoy owning features end to end.';
    const without = checkOutreachText(reply, base, O);
    const withExtra = checkOutreachText(reply, base, { ...O, extraSource: extra });
    expect(without.unsupported.some((x) => x.startsWith('scope:'))).toBe(true);
    expect(withExtra.verdict).toBe('pass');
  });
});

describe('structural posting references only (fix round 2, Q4)', () => {
  const K = { ...O, jobTitle: 'Kubernetes Engineer', company: 'Stripe' };
  const pass = [
    'I am applying for the Kubernetes Engineer role.',
    'I was drawn to the Kubernetes Engineer position.',
    'Your Kubernetes Engineer role caught my eye.',
    'I noticed the Kubernetes Engineer opening at Stripe.',
    'Your "Kubernetes Engineer" is a great fit for me.',
  ];
  const block: Array<[string, string]> = [
    ['I found success as a Kubernetes Engineer running clusters for 3 years.', 'tool:kubernetes'],
    ['My job as a Kubernetes Engineer was to run clusters.', 'tool:kubernetes'],
    ['In my last job I worked as a Kubernetes Engineer for 3 years.', 'tool:kubernetes'],
    ['I have 3 years as a Kubernetes Engineer, a role I loved.', 'tool:kubernetes'],
    ['I built the Stripe integration at Stripe, a job I loved.', 'tool:stripe'],
    ['I found the Stripe integration I built at Stripe was fast.', 'tool:stripe'],
    ['I have 3 years as a Kubernetes Engineer running clusters.', 'tool:kubernetes'],
    ['I built the Stripe integration at Stripe.', 'tool:stripe'],
    ['As a Kubernetes Engineer I ran clusters.', 'tool:kubernetes'],
    ['I saw the Redux Developer role. I shipped Redux stores for 3 years.', 'tool:redux'],
  ];
  for (const t of pass) it(`passes: ${t}`, () => expect(checkOutreachText(t, base, K).unsupported).toEqual([]));
  for (const [t, c] of block) it(`blocks: ${t}`, () => expect(checkOutreachText(t, base, { ...K, jobTitle: t.includes('Redux') ? 'Redux Developer' : 'Kubernetes Engineer' }).unsupported).toContain(c));
});

describe('loadFactGateConfig strictness (fix round 1)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'factgate2-'));
  const put = (name: string, body: string) => { const f = path.join(dir, name); writeFileSync(f, body); return f; };
  it('allows an empty object', () => {
    expect(loadFactGateConfig(put('e.json', '{}')).missing).toBe(false);
  });
  it('rejects array and null top levels', () => {
    expect(() => loadFactGateConfig(put('a.json', '[]'))).toThrow(/top level must be an object/);
    expect(() => loadFactGateConfig(put('n.json', 'null'))).toThrow(/top level must be an object/);
  });
  it('rejects a misspelled key by name', () => {
    expect(() => loadFactGateConfig(put('m.json', '{"forbidden_phrase":[]}'))).toThrow(/unknown key "forbidden_phrase"/);
  });
});

describe('oversize inputs fail closed (Q2)', () => {
  const big = 'Built a thing. '.repeat(1400);
  const msg = (f: string) => `oversize: ${f} exceeds 20000 chars; not fact-checked`;
  it('blocks an oversize tailored resume', () => {
    const t = clone(); t.summary += ' ' + big;
    const r = checkResume(base, t, O);
    expect(r.verdict).toBe('block');
    expect(r.unsupported).toContain(msg('tailored resume'));
  });
  it('blocks an oversize base resume', () => {
    const b = clone(); b.summary += ' ' + big;
    const r = checkResume(b, clone(), O);
    expect(r.verdict).toBe('block');
    expect(r.unsupported.some((x) => x.startsWith('oversize: base resume'))).toBe(true);
  });
  it('blocks oversize outreach text', () => {
    const r = checkOutreachText(big, base, O);
    expect(r.verdict).toBe('block');
    expect(r.unsupported).toEqual([msg('outreach text')]);
  });
  it('blocks outreach when the base or extraSource is oversize', () => {
    const r = checkOutreachText('Hello there.', base, { ...O, extraSource: big });
    expect(r.verdict).toBe('block');
    expect(r.unsupported).toEqual([msg('extra source')]);
  });
  it('normal 4-5k char inputs are unaffected', () => {
    const t = clone(); t.summary += ' ' + 'Built a thing. '.repeat(250);
    expect(checkResume(base, t, O).unsupported.some((x) => x.startsWith('oversize'))).toBe(false);
    expect(checkOutreachText('Built a thing. '.repeat(300), base, O).unsupported.some((x) => x.startsWith('oversize'))).toBe(false);
  });
});
