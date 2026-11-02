import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleEscalate } from '../src/applier/escalate.js';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleFill } from '../src/applier/tools/fill.js';
import { createApplierState } from '../src/applier/tools/common.js';
import { listEscalations } from '../src/outreach/escalations.js';
import { renderEscalations } from '../src/status/escalations.js';
import { renderWorking } from '../src/status/render.js';
import { buildSnapshot } from '../src/status/snapshot.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { listQuestions, openQuestionsForJob, recordQuestion, normLabel, checkAnswerShape } from '../src/apply/questions.js';
import { loadAnswerBook, saveCustomAnswer } from '../src/apply/answers.js';
import { run as answersCli } from '../scripts/answers.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { makeApplier, type ApplierHarness } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const A = (key: string) => ({ kind: 'answer' as const, key });
const x = () => ({ notify: () => undefined, styleCfg: DEFAULT_STYLE_CONFIG, runId: 'run-a', telegram: { send: async () => ({ ok: true, detail: 'x' }) } });
const resume = () => ({ name: 'Jane Fixture', email: 'jane.fixture@example.com', website: { url: 'https://jane.example.com' }, experience: [], skills: [] });
const WHY = 'Why do you want to work here?';

async function opened(): Promise<ApplierHarness> {
  h = makeApplier({ why: false });
  await handleOpen({ job_id: 'job-1' }, h.deps);
  return h;
}

describe('needs_answer lifecycle', () => {
  it('an unanswerable required question is needs_answer, one row per distinct question, nothing typed', async () => {
    const t = await opened();
    const r = await handleFill({ field: 'f8', ref: A('custom:whatever') }, t.deps);
    expect(r).toMatchObject({ status: 'needs_answer' });
    expect((r as { question_id?: number }).question_id).toBeGreaterThan(0);
    await handleFill({ field: 'f8', ref: A('custom:again') }, t.deps);
    const rows = listQuestions(t.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: 'boards.greenhouse.io', status: 'open', kind: 'text', norm_label: normLabel(WHY) });
    expect(t.site.fills).toEqual([]);
  });

  it('apply_escalate question parks the job as needs_answer, lists the exact questions and says "needs your answer"', async () => {
    const t = await opened();
    await handleFill({ field: 'f8', ref: A('custom:whatever') }, t.deps);
    const e = await handleEscalate({ job_id: 'job-1', reason: 'question' }, t.deps, x());
    expect(e).toMatchObject({ status: 'needs_answer', code: 'escalated' });
    const q = t.db.prepare('SELECT apply_status, apply_note FROM outreach_queue WHERE job_id = ?').get('job-1') as { apply_status: string; apply_note: string };
    expect(q.apply_status).toBe('needs_answer');
    expect(q.apply_note).toMatch(/^\d+ questions? needs? your answer$/);
    const now = new Date();
    const { items, counts } = listEscalations(t.db, { now });
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Needs your answer');
    expect(items[0].questions.some((qq) => qq.label.startsWith(WHY) && qq.answerCommand.startsWith('npm run answers -- answer '))).toBe(true);
    const text = renderEscalations(items, counts, now);
    expect(text).toContain('needs your answer');
    expect(text).toContain(WHY);
    // a second escalation for the same host merges into the one card
    const snap = buildSnapshot(t.db, loadOutreachConfig({}), now);
    expect(snap.openQuestions.count).toBe(openQuestionsForJob(t.db, 'job-1').length);
    expect(renderWorking(snap)).toContain('needs your answer');
    // drift is not used for a missing answer
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE reason LIKE '%drift%'").get()).toEqual({ n: 0 });
  });

  it('a once answer releases the job, is used by the next fill, and nothing else sees it', async () => {
    const t = await opened();
    await handleFill({ field: 'f8', ref: A('custom:whatever') }, t.deps);
    await handleEscalate({ job_id: 'job-1', reason: 'question' }, t.deps, x());
    const id = listQuestions(t.db)[0].id;
    const r = await answersCli(['answer', String(id), 'Because the product is interesting and the team ships.'], { db: t.db, baseResume: resume, env: {} });
    expect(r.code).toBe(0);
    expect(t.db.prepare('SELECT apply_status, apply_note FROM outreach_queue WHERE job_id = ?').get('job-1')).toEqual({ apply_status: null, apply_note: null });
    // a later apply stage (fresh run state) types the stored answer for this job
    t.deps.state = createApplierState();
    await handleOpen({ job_id: 'job-1' }, t.deps);
    expect(await handleFill({ field: 'f8', ref: A('custom:x') }, t.deps)).toMatchObject({ status: 'ok', code: 'filled' });
    expect(t.site.fills.map((f) => f.value)).toEqual(['Because the product is interesting and the team ships.']);
  });

  it('skip ends the job in manual_review and the question is not asked again', async () => {
    const t = await opened();
    await handleFill({ field: 'f8', ref: A('custom:whatever') }, t.deps);
    await handleEscalate({ job_id: 'job-1', reason: 'question' }, t.deps, x());
    const id = listQuestions(t.db)[0].id;
    expect((await answersCli(['skip', String(id)], { db: t.db, env: {} })).code).toBe(0);
    expect(t.db.prepare('SELECT apply_status FROM outreach_queue WHERE job_id = ?').get('job-1')).toEqual({ apply_status: 'manual_review' });
    expect(recordQuestion(t.db, { jobId: 'job-2', host: 'boards.greenhouse.io', label: WHY, kind: 'text' }, new Date()).status).toBe('skipped');
  });
});

describe('answers CLI and the answer book', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-'));
    const answersPath = path.join(dir, 'a.json');
    fs.writeFileSync(answersPath, JSON.stringify({ years_experience: 3, custom: {} }), { mode: 0o600 });
    const resumePath = path.join(dir, 'resume.json');
    fs.writeFileSync(resumePath, JSON.stringify({ name: 'J', location: 'Pune', skills: [{ items: ['React', 'TypeScript'] }], experience: [{ start: '2020-01', end: '2022-01' }, { start: '2021-06', end: '2023-01' }] }));
    return { dir, answersPath, resumePath };
  };

  it('--always stores the normalized label in the answer book and answers every open copy of the question', async () => {
    const t = await opened();
    const { answersPath, resumePath } = setup();
    recordQuestion(t.db, { jobId: 'job-1', host: 'a.example.com', label: 'Interested Location *', kind: 'text' }, new Date());
    t.db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('job-2','x','T','C')").run();
    t.db.prepare("INSERT INTO outreach_queue (job_id, apply_platform, apply_status) VALUES ('job-2','browser','needs_answer')").run();
    recordQuestion(t.db, { jobId: 'job-2', host: 'b.example.com', label: 'interested   location', kind: 'text' }, new Date());
    const [first] = listQuestions(t.db);
    const r = await answersCli(['answer', String(first.id), 'Bangalore', '--always'], { db: t.db, baseResume: resume, answersPath, env: {} });
    expect(r.code).toBe(0);
    expect(r.lines.join(' ')).toContain('also answered 1 other');
    const book = loadAnswerBook({ answersPath, profilePath: resumePath });
    const s = book.suggest('INTERESTED LOCATION');
    expect(s.cls).toBe('custom');
    expect(book.resolve(s.ref!, {})).toBe('Bangalore');
    expect(JSON.parse(fs.readFileSync(answersPath, 'utf8')).custom).toEqual({ 'interested location': 'Bangalore' });
    expect(listQuestions(t.db).length).toBe(0);
  });

  it('refuses an answer longer than the field, an unlisted option, a link not in the resume, and an unsupported claim', async () => {
    const t = await opened();
    const a = recordQuestion(t.db, { jobId: 'job-1', host: 'h.example.com', label: 'Short bio', kind: 'text', maxLength: 10 }, new Date());
    expect((await answersCli(['answer', String(a.id), 'this is way too long'], { db: t.db, baseResume: resume, env: {} })).lines[0]).toContain('at most 10');
    const b = recordQuestion(t.db, { jobId: 'job-1', host: 'h.example.com', label: 'Work mode', kind: 'select', options: ['Remote', 'Onsite'] }, new Date());
    expect((await answersCli(['answer', String(b.id), 'Hybrid'], { db: t.db, baseResume: resume, env: {} })).lines[0]).toContain('pick one of the options');
    expect(checkAnswerShape({ kind: 'select', options: ['Remote', 'Onsite'], max_length: null }, 'remote')).toEqual({ ok: true, value: 'Remote' });
    const c = recordQuestion(t.db, { jobId: 'job-1', host: 'h.example.com', label: 'Portfolio link', kind: 'text' }, new Date());
    expect((await answersCli(['answer', String(c.id), 'https://evil.example.org/x'], { db: t.db, baseResume: resume, env: {} })).lines[0]).toContain('url_not_allowed');
    expect((await answersCli(['answer', String(c.id), 'https://jane.example.com'], { db: t.db, baseResume: resume, env: {} })).code).toBe(0);
    const d = recordQuestion(t.db, { jobId: 'job-1', host: 'h.example.com', label: 'Tell us about your biggest achievement', kind: 'text' }, new Date());
    const bad = await answersCli(['answer', String(d.id), 'I led a team of 40 engineers and cut costs by 85% across the whole company'], { db: t.db, baseResume: resume, env: {} });
    expect(bad.code).toBe(1);
    expect(bad.lines[0]).toContain('fact_gate_block');
  });

  it('matches exact normalized labels first, derives years and skills from the resume, and never guesses "Native location"', () => {
    const { answersPath, resumePath } = setup();
    saveCustomAnswer('  Your   Notice Period?* ', '30 days', answersPath);
    const book = loadAnswerBook({ answersPath, profilePath: resumePath });
    expect(book.suggest('your notice period?').cls).toBe('custom');
    expect(book.suggest('Native location')).toEqual({ ref: null, cls: 'unknown' });
    expect(book.suggest('Interested Location')).toEqual({ ref: null, cls: 'unknown' });
    const loc = book.suggest('Current location');
    expect(book.resolve(loc.ref!, {})).toBe('Pune');
    expect(book.resolve(book.suggest('Your Skill Set').ref!, {})).toBe('React, TypeScript');
    // years in the answer file win over the resume
    expect(book.resolve(book.suggest('Years of Exp').ref!, {})).toBe(3);
    // without the answer file value the union of the date ranges (2020-01 .. 2023-01 = 3y 1m) is used, rounded down
    const noYears = path.join(path.dirname(answersPath), 'b.json');
    fs.writeFileSync(noYears, JSON.stringify({ custom: {} }));
    expect(loadAnswerBook({ answersPath: noYears, profilePath: resumePath }).resolve({ kind: 'answer', key: 'years_experience' }, {})).toBe(3);
    // consent and attestation are never answered from a book
    saveCustomAnswer('I agree to the terms', 'yes', answersPath);
    expect(loadAnswerBook({ answersPath, profilePath: resumePath }).suggest('I agree to the terms').cls).toBe('consent');
  });
});
