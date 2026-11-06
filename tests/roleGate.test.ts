import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkRole, loadRoleGateConfig, parseRoleGateConfig, sweepRoleGate } from '../src/roleGate.js';
import { listUnscoredJobs, openDb, saveJob } from '../src/db.js';
import { applyVetoes, loadDealBreakers, vetoResults } from '../src/vetoes.js';
import { rematchGate } from '../scripts/rematch-gate.js';

const cfg = loadRoleGateConfig();
const role = (title: string, description = '') => checkRole({ title, description }, cfg.config);

describe('role gate config', () => {
  it('the shipped config/role-families.json is valid', () => {
    expect(cfg.source).toBe('file');
    expect(cfg.invalid).toBeUndefined();
  });
  it('an invalid file falls back to defaults and says why; a bad regex is invalid', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rg-'));
    const f = path.join(dir, 'bad.json');
    writeFileSync(f, JSON.stringify({ deny: ['('], allow: [{ family: 'x', patterns: ['x'] }] }));
    const r = loadRoleGateConfig(f);
    expect(r.invalid).toBeTruthy();
    expect(r.source).toBe('default');
    expect(() => parseRoleGateConfig({ deny: [], allow: [] })).toThrow();
  });
  it('a missing file uses the built-in defaults', () => {
    expect(loadRoleGateConfig('/nonexistent/role-families.json').source).toBe('default');
  });
});

describe('role gate title table', () => {
  it.each([
    ['Code Reviewer – JavaScript', 'reviewer'],
    ['AI Tutor', 'tutor'],
    ['QA Engineer', 'qa'],
    ['Sales Engineer', 'sales'],
    ['Data Annotator', 'annotator'],
    ['Freelance JavaScript Developer (per-task gig)', 'freelance'],
    ['Software Engineering Intern', 'intern'],
    ['Technical Support Engineer', 'support'],
    ['UI/UX Designer', 'designer'],
    ['Recruiter, Engineering', 'recruiter'],
  ])('rejects %s', (title, word) => {
    const r = role(title);
    expect(r.verdict).toBe('reject');
    expect((r as any).reason).toBe(`role: ${word}`);
  });

  it.each(['Full Stack Developer', 'React Developer', 'Senior Software Engineer', 'MERN Stack Developer', 'Frontend Engineer II', 'UI Engineer', 'Fullstack Engineer', 'Front-End Developer', 'Lead JavaScript Developer', 'Web Developer', 'TypeScript Engineer', 'Sr. Software Developer', 'Senior Software Development Engineer', 'Software Development Engineer II', 'SDE 2'])('passes %s', (title) => {
    expect(role(title).verdict).toBe('pass');
  });

  it('borderline: Backend Engineer and Node.js Developer with a javascript signal go to the matcher', () => {
    expect(role('Backend Engineer', 'We use TypeScript and React.').verdict).toBe('borderline');
    expect(role('Node.js Developer').verdict).toBe('borderline');
    expect(role('React Native Developer').verdict).toBe('borderline');
    expect(role('Developer').verdict).toBe('borderline');
    expect(role('Senior Engineer').verdict).toBe('borderline');
  });
  it('a backend title with no javascript, react or full-stack signal is rejected', () => {
    const r = role('Backend Engineer', 'Java and Spring Boot microservices.');
    expect(r.verdict).toBe('reject');
  });
  it('a title in no family is rejected', () => {
    expect(role('Data Engineer')).toEqual({ verdict: 'reject', reason: 'role: no target role family' });
    expect(role('Marketing Manager').verdict).toBe('reject');
  });
  it('deny words win over allowed words', () => {
    expect(role('Full Stack Developer - QA').verdict).toBe('reject');
    expect(role('React Developer Intern').verdict).toBe('reject');
    expect(role('Full Stack Developer (Freelance)').verdict).toBe('reject');
    expect(role('Software Engineer, Sales Tools').verdict).toBe('reject');
  });
  it('a deny word is a whole word: Contestant, Latest, Supportive are not hits', () => {
    expect(role('Full Stack Developer, Latest Platforms').verdict).toBe('pass');
    expect(role('Frontend Developer at Intern-net Labs').verdict).toBe('reject'); // "Intern" as a word is a hit
  });
  it('pay-model phrases in the posting reject an otherwise good title', () => {
    const r = role('Full Stack Developer', 'You are paid per approved task, flexible hours.');
    expect(r.verdict).toBe('reject');
    expect((r as any).reason).toContain('role: pay model');
  });
  it('a LinkedIn hiring post (no real title) is borderline, not rejected', () => {
    expect(role('Hiring post by Asha Rao').verdict).toBe('borderline');
    expect(role('').verdict).toBe('borderline');
  });
  it('interns are allowed only when the owner config allows them', () => {
    const c = parseRoleGateConfig({ ...JSON.parse(JSON.stringify(cfg.config)), allow_intern: true });
    expect(checkRole({ title: 'React Developer Intern' }, c).verdict).toBe('pass');
  });
});

describe('role gate in applyVetoes (manual and already-matched jobs)', () => {
  it('excludes a bad title with reason "role: <word>" and keeps working without the option', () => {
    const j = { title: 'Code Reviewer – JavaScript', description: 'review code' };
    expect(applyVetoes({ job_id: 'a', score: 90 }, j, [], { roleGate: cfg.config }).reason).toBe('role: reviewer');
    expect(applyVetoes({ job_id: 'a', score: 90 }, j, []).excluded).toBe(false);
  });
  it('a borderline title is a flag, a good title no flag, an invalid config a flag', () => {
    const b = applyVetoes({ job_id: 'a', score: 90 }, { title: 'Node.js Developer', description: '' }, [], { roleGate: cfg.config });
    expect(b.excluded).toBe(false);
    expect(b.flags.join()).toContain('role gate borderline');
    expect(applyVetoes({ job_id: 'a', score: 90 }, { title: 'Full Stack Developer', description: '' }, [], { roleGate: cfg.config }).flags).toEqual([]);
    const inv = applyVetoes({ job_id: 'a', score: 90 }, { title: 'Full Stack Developer', description: '' }, [], { roleGate: cfg.config, roleGateInvalid: 'bad file' });
    expect(inv.flags.join()).toContain('role gate config invalid');
  });
  it('vetoResults passes the gate through its context', () => {
    const out = vetoResults([{ job_id: 'a', score: 90 }], [{ id: 'a', title: 'AI Tutor', description: '' }], [], { roleGate: cfg.config });
    expect(out[0].reason).toBe('role: tutor');
  });
});

describe('deal-breaker pay-model phrases', () => {
  it('config/deal-breakers.json holds the per-task phrases', () => {
    const kws = loadDealBreakers();
    for (const k of ['per task', 'per-task', 'per approved task', 'paid per task', 'pay per task', 'gig work', 'crowd work']) expect(kws).toContain(k);
  });
});

const mk = (db: ReturnType<typeof openDb>, id: string, title: string, extra: Record<string, unknown> = {}) => {
  saveJob(db, { id, source: 'remotive', title, company: `Co ${id}`, url: `https://x.test/${id}`, apply_url: `https://x.test/${id}`, description: 'A role. '.repeat(30), ...extra } as any);
};

describe('sweep inside list_unscored_jobs (before the matcher)', () => {
  it('excludes a role mismatch (manual priority jobs too) and never returns it; borderline carries role_gate', () => {
    const db = openDb(':memory:');
    mk(db, 'good', 'Full Stack Developer');
    mk(db, 'bad', 'Code Reviewer – JavaScript');
    mk(db, 'manual-bad', 'AI Tutor', { priority: 1 });
    mk(db, 'edge', 'Node.js Developer');
    const out = listUnscoredJobs(db, { kind: 'unscored', limit: 20, roleGate: cfg.config });
    expect(out.map((j) => j.id).sort()).toEqual(['edge', 'good']);
    expect(out.find((j) => j.id === 'edge')!.role_gate).toBe('borderline');
    expect(out.find((j) => j.id === 'good')!.role_gate).toBeUndefined();
    const row = (id: string) => db.prepare('SELECT status, excluded_reason FROM jobs WHERE id = ?').get(id) as any;
    expect(row('bad')).toEqual({ status: 'role_mismatch', excluded_reason: 'role: reviewer' });
    expect(row('manual-bad').excluded_reason).toBe('role: tutor');
    // idempotent
    expect(listUnscoredJobs(db, { kind: 'unscored', limit: 20, roleGate: cfg.config }).length).toBe(2);
  });
  it('without the option nothing changes (existing callers)', () => {
    const db = openDb(':memory:');
    mk(db, 'bad', 'AI Tutor');
    expect(listUnscoredJobs(db, { kind: 'unscored', limit: 5 }).map((j) => j.id)).toEqual(['bad']);
  });
  it('an owner /include override (job_exclusion_log row) is respected, a queued row is left alone', () => {
    const db = openDb(':memory:');
    mk(db, 'inc', 'AI Tutor');
    mk(db, 'queued', 'QA Engineer');
    db.prepare("INSERT INTO job_exclusion_log (job_id, previous_reason) VALUES ('inc', 'role: tutor')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('queued', 'queued')").run();
    expect(sweepRoleGate(db, { cfg: cfg.config, windowStart: '2000-01-01 00:00:00' })).toEqual([]);
  });
  it('matched jobs without a queue row are judged as well', () => {
    const db = openDb(':memory:');
    mk(db, 'm', 'Sales Engineer');
    db.prepare("UPDATE jobs SET score = 4 WHERE id = 'm'").run();
    const out = listUnscoredJobs(db, { kind: 'matched', limit: 5, matchThreshold: 3, roleGate: cfg.config });
    expect(out).toEqual([]);
    expect((db.prepare("SELECT excluded_reason FROM jobs WHERE id = 'm'").get() as any).excluded_reason).toBe('role: sales');
  });
});

describe('migration scripts/rematch-gate.ts', () => {
  const setup = () => {
    const db = openDb(':memory:');
    mk(db, 'ok', 'Full Stack Developer');
    mk(db, 'bad', 'Code Reviewer – JavaScript');
    mk(db, 'sent', 'AI Tutor');
    mk(db, 'sending', 'QA Engineer');
    mk(db, 'applied', 'Sales Engineer');
    mk(db, 'dim', 'React Developer');
    mk(db, 'colow', 'Full Stack Engineer');
    mk(db, 'cook', 'Full Stack Engineer II');
    db.prepare('UPDATE jobs SET score = 3.6').run();
    db.prepare("UPDATE jobs SET score_dims = ? WHERE id = 'bad'").run(JSON.stringify({ skills: 20, seniority: 15, domain: 12, location: 25 }));
    db.prepare("UPDATE jobs SET score_dims = ? WHERE id = 'dim'").run(JSON.stringify({ role_fit: 6, skills: 16, seniority_comp: 14, location: 18, flags: 18 }));
    // career_ops_v1 rows: judged by the cutoff (default 4.0 of 5), not by the old minimums
    const co = (g: number) => JSON.stringify({ rubric: 'career_ops_v1', cv_match: g, north_star: g, comp: g, culture: g, red_flags: 0, global: g });
    db.prepare("UPDATE jobs SET score = 3.8, score_dims = ? WHERE id = 'colow'").run(co(3.8));
    db.prepare("UPDATE jobs SET score = 4, score_dims = ? WHERE id = 'cook'").run(co(4.0));
    for (const id of ['ok', 'bad', 'sent', 'sending', 'applied', 'dim', 'colow', 'cook']) db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES (?, 'queued')").run(id);
    db.prepare("UPDATE outreach_queue SET email_sent_at = datetime('now'), email_status = 'sent' WHERE job_id = 'sent'").run();
    db.prepare("UPDATE outreach_queue SET email_status = 'sending' WHERE job_id = 'sending'").run();
    db.prepare("INSERT INTO applications (job_id, platform, status) VALUES ('applied', 'greenhouse', 'submitted')").run();
    return db;
  };
  it('dry run lists what would be parked and changes nothing', () => {
    const db = setup();
    const r = rematchGate(db, { cfg: cfg.config });
    expect(r.applied).toBe(false);
    expect(r.would_park.map((x) => [x.job_id, x.reason])).toEqual([['bad', 'role: reviewer'], ['colow', 'below_cutoff:3.8'], ['dim', 'dim_min:role_fit']]);
    expect(r.would_park[0]).toMatchObject({ title: 'Code Reviewer – JavaScript', company: 'Co bad' });
    expect((db.prepare("SELECT status FROM outreach_queue WHERE job_id = 'bad'").get() as any).status).toBe('queued');
    expect((db.prepare("SELECT excluded_reason FROM jobs WHERE id = 'bad'").get() as any).excluded_reason).toBeNull();
  });
  it('apply parks them, never touches sent / sending / applied rows, and is idempotent', () => {
    const db = setup();
    const r = rematchGate(db, { apply: true, cfg: cfg.config });
    expect(r.parked).toBe(3);
    const q = (id: string) => db.prepare('SELECT status FROM outreach_queue WHERE job_id = ?').get(id) as any;
    expect(q('bad').status).toBe('skipped');
    expect(q('dim').status).toBe('skipped');
    expect(q('colow').status).toBe('skipped');
    for (const id of ['ok', 'sent', 'sending', 'applied', 'cook']) expect(q(id).status).toBe('queued');
    const j = (id: string) => db.prepare('SELECT status, excluded_reason FROM jobs WHERE id = ?').get(id) as any;
    expect(j('bad')).toEqual({ status: 'role_mismatch', excluded_reason: 'role: reviewer' });
    expect(j('dim').excluded_reason).toBe('dim_min:role_fit');
    expect(j('colow').excluded_reason).toBe('below_cutoff:3.8');
    expect(j('cook').excluded_reason).toBeNull();
    expect(j('sent').excluded_reason).toBeNull();
    expect(j('applied').excluded_reason).toBeNull();
    expect(rematchGate(db, { apply: true, cfg: cfg.config }).would_park).toEqual([]);
  });
  it('an old 4-key row gets the title gate only (no dimension check, and its old score is not judged against the new cutoff)', () => {
    const db = openDb(':memory:');
    mk(db, 'old', 'Full Stack Developer');
    db.prepare("UPDATE jobs SET score = 3.5, score_dims = ? WHERE id = 'old'").run(JSON.stringify({ skills: 1, seniority: 1, domain: 1, location: 1 }));
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('old', 'queued')").run();
    expect(rematchGate(db, { cfg: cfg.config }).would_park).toEqual([]);
  });
});
