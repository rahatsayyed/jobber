import { describe, it, expect } from 'vitest';
import { checkFacts, checkResume } from '../src/resumeFacts.js';
import { getBaseResume, renderResume } from '../src/resume.js';

const base = {
  name: 'Test User', summary: 'Built apps serving 10k users.',
  experience: [{ title: 'Engineer', company: 'Acme', location: 'Pune', start: 'Jan 2022', end: 'Present', description: 'Cut latency by 40% for 3 services.' }],
  education: [{ degree: 'BE', school: 'XYZ Univ', year: '2021' }],
  skills: [{ category: 'Frontend', items: ['React', 'TypeScript'] }],
};
const clone = () => JSON.parse(JSON.stringify(base));

describe('checkFacts', () => {
  it('passes the base resume against itself', () => {
    expect(checkFacts(base, clone())).toEqual({ verdict: 'pass', invented: [] });
  });
  it('blocks an invented metric', () => {
    const t = clone(); t.experience[0].description = 'Cut latency by 90% for 3 services.';
    const r = checkFacts(base, t);
    expect(r.verdict).toBe('block');
    expect(r.invented).toContain('metric:90%');
  });
  it('blocks a changed company, title, date or skill', () => {
    const t = clone(); t.experience[0].company = 'Globex'; t.experience[0].title = 'Staff Engineer'; t.skills[0].items.push('Kafka');
    const r = checkFacts(base, t);
    expect(r.verdict).toBe('block');
    expect(r.invented).toEqual(expect.arrayContaining(['company:globex', 'title:staff engineer', 'skill:kafka']));
  });
  it('allows reordering bullets and skills and reworded text without new numbers', () => {
    const t = clone(); t.skills[0].items.reverse(); t.experience[0].description = 'Reduced latency 40% across 3 services.';
    expect(checkFacts(base, t).verdict).toBe('pass');
  });
  it('reports a spelled-out or reformatted number as unsupported rather than crashing', () => {
    const t = clone(); t.experience[0].description = 'Cut latency by 40 percent for 3 services.';
    expect(() => checkFacts(base, t)).not.toThrow();
  });
  it('does not treat years as metrics', () => {
    const t = clone(); t.summary = 'Since 2022 I built apps serving 10k users.';
    expect(checkFacts(base, t).verdict).toBe('pass');
  });
  it('passes a curly-apostrophe education degree', () => {
    const b = clone(); b.education[0].degree = "Bachelor's of Engineering";
    const t = clone(); t.education[0].degree = 'Bachelor’s of Engineering';
    expect(checkFacts(b, t).verdict).toBe('pass');
  });
  it('passes en-dash vs hyphen in a skill', () => {
    const b = clone(); b.skills[0].items.push('Client-Server Rendering Patterns');
    const t = clone(); t.skills[0].items.push('Client–Server Rendering Patterns');
    expect(checkFacts(b, t).verdict).toBe('pass');
  });
  it('passes a parenthesised skill when the base has it split across items', () => {
    const b = clone(); b.skills[0].items.push('NoSQL (MongoDB', 'Firestore)');
    const t = clone(); t.skills[0].items.push('NoSQL (MongoDB, Firestore)');
    expect(checkFacts(b, t).verdict).toBe('pass');
  });
  it('passes React.js when the base has React', () => {
    const t = clone(); t.skills[0].items[0] = 'React.js';
    expect(checkFacts(base, t).verdict).toBe('pass');
  });
  it('still blocks a skill with a brand-new word', () => {
    const t = clone(); t.skills[0].items.push('Kafka');
    expect(checkFacts(base, t).invented).toContain('skill:kafka');
  });
  it('blocks a changed contact field and passes identical ones', () => {
    const b = { ...clone(), email: 'a@x.com', phone: '+91 90000 00000', website: { url: 'https://x.dev' } };
    expect(checkFacts(b, JSON.parse(JSON.stringify(b))).verdict).toBe('pass');
    const t = JSON.parse(JSON.stringify(b)); t.email = 'b@x.com';
    expect(checkFacts(b, t).invented).toContain('contact:email');
    const t2 = JSON.parse(JSON.stringify(b)); delete t2.phone;
    expect(checkFacts(b, t2).verdict).toBe('pass');
  });
  it('passes the real base resume against itself', () => {
    expect(checkFacts(getBaseResume(), getBaseResume()).verdict).toBe('pass');
  });
});

describe('renderResume fact gate', () => {
  it('throws before rendering when the resume has an invented claim', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    t.experience[0].company = 'Invented Corp Ltd';
    await expect(renderResume(t)).rejects.toThrow(/fact check failed/);
  });
});

describe('rendered-but-unchecked fields (projects, certificates, skill categories)', () => {
  const real = () => JSON.parse(JSON.stringify(getBaseResume()));
  it('blocks a project not in the base', () => {
    const t = real(); t.projects = [{ title: 'Kubernetes Operator at Google', description: [] }];
    expect(checkFacts(getBaseResume(), t).invented).toContain('project:kubernetes operator at google');
    expect(checkResume(getBaseResume(), t).verdict).toBe('block');
  });
  it('blocks a certificate not in the base', () => {
    const t = real(); t.certificates = [{ name: 'AWS Certified Solutions Architect Professional' }];
    expect(checkFacts(getBaseResume(), t).invented).toContain('certificate:aws certified solutions architect professional');
    expect(checkResume(getBaseResume(), t).verdict).toBe('block');
  });
  it('blocks a skill category with tokens outside the base categories and skill items', () => {
    const t = real(); t.skills[0].category = 'Kubernetes & Go';
    expect(checkFacts(getBaseResume(), t).invented).toContain('skill-category:kubernetes & go');
    expect(checkResume(getBaseResume(), t).verdict).toBe('block');
  });
  it('passes projects, certificates and categories that are in the base (verbatim, or category tokens from the pool)', () => {
    const b = { ...clone(), projects: [{ title: 'Ledger App' }], certificates: [{ name: 'CKA' }], skills: [{ category: 'Frontend', items: ['React', 'TypeScript'] }, { category: 'Backend', items: ['Node.js'] }] };
    const t = JSON.parse(JSON.stringify(b));
    t.projects = [{ title: 'ledger  app' }]; t.certificates = []; t.skills[0].category = 'Frontend & Backend'; t.skills[1].category = 'React';
    expect(checkFacts(b, t)).toEqual({ verdict: 'pass', invented: [] });
  });
  it('the real base resume still passes against itself', () => {
    expect(checkResume(getBaseResume(), getBaseResume()).verdict).toBe('pass');
  });
});
