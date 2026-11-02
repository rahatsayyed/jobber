import { describe, expect, it } from 'vitest';
import { classifyKeywords, coveragePct, isGenericKeyword, proseCoveragePct } from '../src/atsKeywords.js';
import { ATS_NOTE_JD_INCOMPLETE, applyJdNote, isJdIncomplete } from '../src/atsJd.js';
import { enqueueOutreach, openDb } from '../src/db.js';
import { run as fixIncomplete } from '../scripts/fix-ats-incomplete.js';

const FULL = 'We are hiring a full stack engineer to build React and Node.js products with PostgreSQL and TypeScript. '.repeat(6);
const item = {
  job_id: 'j1', resume_pdf_path: null, email_subject: null, email_body: null, email_to: null,
  connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null,
  apply_platform: 'greenhouse', apply_url: 'https://boards.greenhouse.io/x/jobs/1',
};
const addJob = (db: ReturnType<typeof openDb>, id: string, description: string | null) =>
  db.prepare('INSERT INTO jobs (id, source, title, company, description) VALUES (?,?,?,?,?)').run(id, 'naukri', 'T', 'C', description);

describe('incomplete job descriptions', () => {
  it('flags a snippet, an empty text and a cut-off text, and accepts a full posting', () => {
    expect(isJdIncomplete(null)).toBe(true);
    expect(isJdIncomplete('India (Remote)')).toBe(true);
    expect(isJdIncomplete('Build scalable web applications using React and Node. '.repeat(1).slice(0, 90))).toBe(true);
    expect(isJdIncomplete(`${FULL}...`)).toBe(true);
    expect(isJdIncomplete(`${FULL}…`)).toBe(true);
    expect(isJdIncomplete(`${FULL} Read more`)).toBe(true);
    expect(isJdIncomplete(FULL)).toBe(false);
    expect(applyJdNote(40, 'short')).toEqual({ coverage: null, note: ATS_NOTE_JD_INCOMPLETE });
    expect(applyJdNote(40, FULL)).toEqual({ coverage: 40, note: null });
  });

  it('enqueue stores NULL plus the note for a snippet, and the value for a full description; a model-supplied note is ignored', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'Build scalable web applications using ...');
    addJob(db, 'j2', FULL);
    const a = enqueueOutreach(db, { ...item, job_id: 'j1', ats_coverage: 13, ats_note: 'made_up' });
    const b = enqueueOutreach(db, { ...item, job_id: 'j2', ats_coverage: 71, ats_note: 'jd_incomplete' });
    expect(db.prepare('SELECT ats_coverage, ats_note FROM outreach_queue WHERE id = ?').get(a)).toEqual({ ats_coverage: null, ats_note: 'jd_incomplete' });
    expect(db.prepare('SELECT ats_coverage, ats_note FROM outreach_queue WHERE id = ?').get(b)).toEqual({ ats_coverage: 71, ats_note: null });
  });

  it('the maintenance script marks old low numbers on snippets, leaves full descriptions alone, and is idempotent', () => {
    const db = openDb(':memory:');
    addJob(db, 'j1', 'snippet'); addJob(db, 'j2', FULL);
    db.prepare('INSERT INTO outreach_queue (job_id, ats_coverage) VALUES (?, ?)').run('j1', 13);
    db.prepare('INSERT INTO outreach_queue (job_id, ats_coverage) VALUES (?, ?)').run('j2', 55);
    expect(fixIncomplete(['--dry'], db).lines[0]).toContain('would mark 1 of 2');
    expect(db.prepare('SELECT ats_coverage FROM outreach_queue WHERE job_id = ?').get('j1')).toEqual({ ats_coverage: 13 });
    expect(fixIncomplete([], db).lines[0]).toContain('marked 1 of 2');
    expect(fixIncomplete([], db).lines[0]).toContain('marked 0 of 1');
    expect(db.prepare('SELECT ats_coverage, ats_note FROM outreach_queue WHERE job_id = ?').get('j1')).toEqual({ ats_coverage: null, ats_note: 'jd_incomplete' });
    expect(db.prepare('SELECT ats_coverage FROM outreach_queue WHERE job_id = ?').get('j2')).toEqual({ ats_coverage: 55 });
  });
});

describe('keyword coverage', () => {
  it('ignores generic boilerplate instead of counting it as a miss', () => {
    for (const t of ['communication skills', 'Team player', 'experience', 'Problem-solving', 'fast-paced environment', 'B.Tech']) expect(isGenericKeyword(t), t).toBe(true);
    for (const t of ['React', 'Node.js', 'C++', 'REST APIs', 'Go']) expect(isGenericKeyword(t), t).toBe(false);
    const r = classifyKeywords([{ term: 'React', priority: 'required' }, { term: 'communication skills', priority: 'required' }, { term: 'team', priority: 'preferred' }], 'Built React apps.', '');
    expect(r.map((x) => x.term)).toEqual(['React']);
    expect(coveragePct(r)).toBe(100);
  });

  it('credits what the final resume shows (prose, synonym, skills list) and nothing else', () => {
    const kws = ['React', 'JavaScript', 'Node.js', 'Docker', 'Kubernetes'].map((term) => ({ term, priority: 'required' as const }));
    // React in prose, JS synonym in prose, Node.js only in the skills list, Docker only in a base bullet the tailoring dropped, Kubernetes nowhere
    const r = classifyKeywords(kws, 'Built React apps with JS.', 'Optimized a Docker build.', 'Node.js, Express');
    expect(r.map((x) => x.status)).toEqual(['covered', 'synonym_only', 'skills_only', 'missing_have_it', 'gap']);
    expect(coveragePct(r)).toBe(60);
    expect(proseCoveragePct(r)).toBe(20);
    // the fact gate is unchanged: a term the resume does not have is never credited
    expect(classifyKeywords([{ term: 'Rust', priority: 'required' }], 'Built React apps.', 'Built React apps.', 'React')[0].status).toBe('gap');
  });
});
