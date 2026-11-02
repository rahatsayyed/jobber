import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { addEscalation } from '../src/outreach/service.js';
import { listEscalations } from '../src/outreach/escalations.js';
import { renderEscalations } from '../src/status/escalations.js';
import {
  agentHandleAllowed, getQuestion, markAgentHandle, markAnswered, markSkipped, migrateApplyQuestions, openQuestionsForJob, ownerGuidanceFor,
  recordQuestion, storedAnswer, suggestedAnswer, type QuestionKind,
} from '../src/apply/questions.js';
import { groupedQuestions, questionCounts } from '../src/apply/questionInbox.js';
import { run as answersCli } from '../scripts/answers.js';
import { makeHarness, START, type Harness } from './helpers/webHarness.js';

const RESUME = { name: 'Jane Fixture', email: 'jane.fixture@example.com', location: 'Pune', website: { url: 'https://jane.example.com' }, experience: [{ start: '2020-01', end: '2023-01' }], skills: [{ items: ['TypeScript', 'React'] }] };
const resume = (): Record<string, unknown> => RESUME;
const HOST = 'boards.greenhouse.io';
const WHY = 'Why do you want to work here?';
const NOW = new Date(START);

function seed(db: BetterSqlite3.Database, jobId: string, title = 'Frontend Engineer', company = 'Acme'): void {
  db.prepare("INSERT OR IGNORE INTO jobs (id, source, title, company, apply_url) VALUES (?, 'x', ?, ?, ?)").run(jobId, title, company, `https://${HOST}/acme/${jobId}`);
  db.prepare("INSERT INTO outreach_queue (job_id, apply_platform, apply_status, resume_pdf_path, ats_note) VALUES (?, 'browser', 'needs_answer', ?, 'ats ok')").run(jobId, `/tmp/${jobId}.pdf`);
}
const ask = (db: BetterSqlite3.Database, jobId: string, label: string, kind: QuestionKind = 'text', extra: { options?: string[]; maxLength?: number } = {}): number =>
  recordQuestion(db, { jobId, host: HOST, label, kind, options: extra.options, maxLength: extra.maxLength }, NOW).id;
const status = (db: BetterSqlite3.Database, jobId: string): string | null =>
  (db.prepare('SELECT apply_status AS s FROM outreach_queue WHERE job_id = ?').get(jobId) as { s: string | null }).s;

describe('owner_comment migration', () => {
  it('adds the column to an old table once and keeps rows', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`CREATE TABLE apply_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, host TEXT NOT NULL, label TEXT NOT NULL, norm_label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text', options TEXT, max_length INTEGER, status TEXT NOT NULL DEFAULT 'open', answer TEXT, answer_scope TEXT, created_at TEXT NOT NULL, answered_at TEXT);
      INSERT INTO apply_questions (job_id, host, label, norm_label, created_at) VALUES ('j', 'h', 'L', 'l', 'now');`);
    migrateApplyQuestions(db);
    migrateApplyQuestions(db);
    const cols = (db.prepare('PRAGMA table_info(apply_questions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'owner_comment')).toHaveLength(1);
    expect(db.prepare('SELECT label, owner_comment FROM apply_questions').get()).toEqual({ label: 'L', owner_comment: null });
  });
});

describe('agent_handle rules', () => {
  const allowed = ['Why do you want to work at Acme?', 'Tell us about yourself', 'Describe a project you are proud of', 'What excites you about this role?', 'Cover letter'];
  const refused = ['Expected salary (CTC)', 'Notice period', 'Current location', 'Are you authorized to work in India?', 'LinkedIn URL', 'Aadhaar number', 'I agree to the privacy policy', 'Years of experience with React', 'Expected CTC'];
  it('allows free-text motivational questions and refuses factual ones', () => {
    for (const l of allowed) expect(agentHandleAllowed(l, 'text'), l).toBe(true);
    for (const l of refused) expect(agentHandleAllowed(l, 'text'), l).toBe(false);
    expect(agentHandleAllowed('Why do you want to work here?', 'select')).toBe(false);
  });

  it('stores agent_handle, keeps the question unanswered, keeps the job paused and never reopens it', () => {
    const db = openDb(':memory:');
    seed(db, 'j1');
    const id = ask(db, 'j1', WHY);
    markAgentHandle(db, id, NOW, 'mention my open source work');
    expect(getQuestion(db, id)).toMatchObject({ status: 'agent_handle', owner_comment: 'mention my open source work', answer: null });
    expect(storedAnswer(db, 'j1', HOST, WHY)).toBeNull();
    expect(status(db, 'j1')).toBe('needs_answer');
    expect((db.prepare('SELECT apply_note AS n FROM outreach_queue WHERE job_id = ?').get('j1') as { n: string }).n).toBe('1 question waiting for the agent to draft');
    // the applier meeting the question again gets the same row back, not a new open one
    expect(recordQuestion(db, { jobId: 'j1', host: HOST, label: WHY, kind: 'text' }, NOW)).toMatchObject({ id, created: false, status: 'agent_handle' });
    expect(openQuestionsForJob(db, 'j1')).toHaveLength(0);
  });

  it('refuses a factual question', () => {
    const db = openDb(':memory:');
    seed(db, 'j1');
    const id = ask(db, 'j1', 'Expected salary');
    expect(() => markAgentHandle(db, id, NOW)).toThrow(/only a free-text motivational/);
    expect(getQuestion(db, id)!.status).toBe('open');
  });

  it('an owner answer later replaces agent_handle and releases the job', () => {
    const db = openDb(':memory:');
    seed(db, 'j1');
    const a = ask(db, 'j1', WHY);
    const b = ask(db, 'j1', 'Notice period');
    markAgentHandle(db, a, NOW);
    markAnswered(db, b, '30 days', 'once', NOW);
    expect(status(db, 'j1')).toBe('needs_answer'); // the agent one still waits
    markAnswered(db, a, 'Because I like the product', 'once', NOW, 'wrote it myself');
    expect(status(db, 'j1')).toBeNull();
    expect(getQuestion(db, a)).toMatchObject({ status: 'answered', owner_comment: 'wrote it myself' });
  });
});

describe('status transitions and comments', () => {
  it('skip with a comment only: status skipped, job to manual_review', () => {
    const db = openDb(':memory:');
    seed(db, 'j1');
    const id = ask(db, 'j1', 'Expected salary');
    markSkipped(db, id, NOW, 'I applied by hand');
    expect(getQuestion(db, id)).toMatchObject({ status: 'skipped', owner_comment: 'I applied by hand' });
    expect(status(db, 'j1')).toBe('manual_review');
  });
  it('comment text is cleaned and capped', () => {
    const db = openDb(':memory:');
    seed(db, 'j1');
    const id = ask(db, 'j1', WHY);
    markAgentHandle(db, id, NOW, '<b>hi</b>' + 'x'.repeat(5000));
    const c = getQuestion(db, id)!.owner_comment!;
    expect(c).not.toContain('<');
    expect(c.length).toBeLessThanOrEqual(1000);
  });
});

describe('ownerGuidanceFor', () => {
  it('returns prior comments for the same or a similar normalized label, same host first', () => {
    const db = openDb(':memory:');
    seed(db, 'j1'); seed(db, 'j2');
    const a = ask(db, 'j1', WHY);
    markAgentHandle(db, a, NOW, 'stress the React work');
    const b = recordQuestion(db, { jobId: 'j2', host: 'jobs.lever.co', label: 'Why do you want to work here? *', kind: 'text' }, NOW).id;
    markSkipped(db, b, NOW, 'lever form is odd');
    ask(db, 'j2', 'Notice period');
    const g = ownerGuidanceFor(db, 'why do you want to work here', 'jobs.lever.co');
    expect(g.map((x) => x.comment)).toEqual(['lever form is odd', 'stress the React work']);
    expect(ownerGuidanceFor(db, 'Notice period')).toEqual([]);
    expect(ownerGuidanceFor(db, '')).toEqual([]);
  });
  it('suggestedAnswer derives only what the resume supports', () => {
    expect(suggestedAnswer('Years of experience', resume(), new Date('2026-01-01'))).toBe('3');
    expect(suggestedAnswer('Current location', resume())).toBe('Pune');
    expect(suggestedAnswer('Why us?', resume())).toBeNull();
    expect(suggestedAnswer('Years of experience', null)).toBeNull();
  });
});

describe('grouped read model', () => {
  it('groups by job with job details, options, maxlength, suggested and counts', () => {
    const db = openDb(':memory:');
    seed(db, 'j1'); seed(db, 'j2', 'Backend Dev', 'Globex');
    ask(db, 'j1', WHY, 'text', { maxLength: 500 });
    ask(db, 'j1', 'Work mode', 'select', { options: ['Remote', 'Hybrid'] });
    recordQuestion(db, { jobId: 'j2', host: HOST, label: WHY, kind: 'text' }, NOW); // shared question: also under j2
    ask(db, 'j2', 'Years of experience', 'text');
    const groups = groupedQuestions(db, { resume: RESUME, now: new Date('2026-01-01') });
    expect(groups.map((g) => g.job_id)).toEqual(['j1', 'j2']);
    const g1 = groups[0];
    expect(g1).toMatchObject({ title: 'Frontend Engineer', company: 'Acme', host: HOST, resume_pdf: '/tmp/j1.pdf', ats_note: 'ats ok', apply_url: `https://${HOST}/acme/j1` });
    expect(g1.questions[0]).toMatchObject({ label: WHY, kind: 'text', maxlength: 500, status: 'open', agent_allowed: true, job_count: 2 });
    expect(g1.questions[1]).toMatchObject({ kind: 'select', options: ['Remote', 'Hybrid'], agent_allowed: false });
    expect(groups[1].questions.find((q) => q.label.startsWith('Years'))!.suggested).toBe('3');
    expect(questionCounts(db)).toEqual({ questions: 3, jobs: 2 });
  });
});

describe('answers CLI additions', () => {
  it('agent subcommand, --comment, skip --comment and list', async () => {
    const db = openDb(':memory:');
    seed(db, 'j1');
    const why = ask(db, 'j1', WHY);
    const sal = ask(db, 'j1', 'Expected salary');
    const list = await answersCli(['list'], { db, now: () => NOW });
    const text = list.lines.join('\n');
    expect(text).toContain('Frontend Engineer at Acme');
    expect(text).toContain(`https://${HOST}/acme/j1`);
    expect(text).toContain(`npm run answers -- agent ${why}`);
    expect(text).not.toContain(`npm run answers -- agent ${sal}`);
    expect(text).toContain('Inbox tab');

    const refused = await answersCli(['agent', String(sal)], { db });
    expect(refused.code).toBe(1);
    expect(refused.lines[0]).toMatch(/^not saved: only a free-text/);

    const ok = await answersCli(['agent', String(why), '--comment', 'keep it short'], { db, now: () => NOW });
    expect(ok.code).toBe(0);
    expect(getQuestion(db, why)).toMatchObject({ status: 'agent_handle', owner_comment: 'keep it short' });
    expect((await answersCli(['list'], { db })).lines.join('\n')).toContain('waiting for the agent');

    const r = await answersCli(['answer', String(sal), '12 LPA', '--comment', 'negotiable'], { db, baseResume: resume, env: {}, now: () => NOW });
    expect(r.code).toBe(0);
    expect(getQuestion(db, sal)).toMatchObject({ status: 'answered', answer: '12 LPA', owner_comment: 'negotiable' });
    expect((await answersCli(['skip', String(why), '--comment'], { db })).code).toBe(2);
    expect((await answersCli(['skip', String(why), '--comment', 'by hand'], { db, now: () => NOW })).code).toBe(0);
    expect(getQuestion(db, why)).toMatchObject({ status: 'skipped', owner_comment: 'by hand' });
  });
});

describe('/escalations text and Telegram digest', () => {
  it('lists each open question with its job, link and the two ways to respond', () => {
    const db = openDb(':memory:');
    seed(db, 'j1');
    const why = ask(db, 'j1', WHY);
    ask(db, 'j1', 'Expected salary', 'text', { maxLength: 20 });
    addEscalation(db, { runId: null, platform: 'apply', reason: 'apply:needs_answer', threadRef: `answers:${HOST}`, detail: 'x' }, NOW);
    const { items, counts } = listEscalations(db, { now: NOW });
    const text = renderEscalations(items, counts, NOW);
    expect(text).toContain('Frontend Engineer at Acme');
    expect(text).toContain(`https://${HOST}/acme/j1`);
    expect(text).toContain('max 20 chars');
    expect(text).toContain('dashboard Inbox tab');
    expect(text).toContain(`npm run answers -- answer ${why} "<text>" [--always] [--comment "..."]`);
    expect(text).toContain(`npm run answers -- agent ${why}`);
    expect(text.match(/let the agent write it/g)).toHaveLength(1); // not offered for the salary question
  });
});

// ---- the HTTP API ----------------------------------------------------------------------------------------------------------------------

let h: Harness | null = null;
afterEach(async () => { if (h) await h.close(); h = null; });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qroutes-'));
  const answersPath = path.join(dir, 'answers.json');
  fs.writeFileSync(answersPath, JSON.stringify({ custom: {} }), { mode: 0o600 });
  h = await makeHarness({
    questions: { write: (fn) => fn(h!.data), resume, answer: { baseResume: resume, env: {}, answersPath, profilePath: path.join(dir, 'none.json') } },
  });
  const { cookie } = await h.login();
  const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
  const origin = `http://127.0.0.1:${h.port}`;
  const post = (p: string, body: unknown, extra: Record<string, string> = {}) =>
    h!.call('POST', p, { headers: { cookie, 'x-csrf-token': s.csrf, origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const get = (p: string) => h!.call('GET', p, { headers: { cookie } });
  return { cookie, post, get, origin, csrf: s.csrf, answersPath };
}
const j = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;
const auditKinds = (): string[] => (h!.auth.prepare('SELECT kind FROM audit_log ORDER BY id').all() as { kind: string }[]).map((r) => r.kind);

describe('apply-questions API', () => {
  it('refuses unauthenticated reads and writes', async () => {
    await setup();
    seed(h!.data, 'j1');
    const id = ask(h!.data, 'j1', WHY);
    const hdr = { origin: `http://127.0.0.1:${h!.port}`, 'content-type': 'application/json' };
    expect((await h!.call('GET', '/api/apply-questions')).status).toBe(401);
    for (const p of ['answer', 'agent-handle', 'skip']) {
      expect((await h!.call('POST', `/api/apply-questions/${p}`, { headers: hdr, body: JSON.stringify({ id, ids: [id], answer: 'x', scope: 'once' }) })).status).toBe(401);
    }
    expect(getQuestion(h!.data, id)!.status).toBe('open');
  });

  it('writes need the CSRF token and a same-origin Origin', async () => {
    const s = await setup();
    seed(h!.data, 'j1');
    const id = ask(h!.data, 'j1', WHY);
    const base = { cookie: s.cookie, 'content-type': 'application/json' };
    const body = JSON.stringify({ ids: [id] });
    expect((await h!.call('POST', '/api/apply-questions/agent-handle', { headers: { ...base, origin: s.origin }, body })).status).toBe(403);
    expect((await h!.call('POST', '/api/apply-questions/agent-handle', { headers: { ...base, 'x-csrf-token': 'wrong', origin: s.origin }, body })).status).toBe(403);
    expect((await h!.call('POST', '/api/apply-questions/agent-handle', { headers: { ...base, 'x-csrf-token': s.csrf, origin: 'http://evil.example' }, body })).status).toBeGreaterThanOrEqual(400);
    expect(getQuestion(h!.data, id)!.status).toBe('open');
  });

  it('lists open questions grouped by job with a suggested hint, and counts them', async () => {
    const s = await setup();
    seed(h!.data, 'j1');
    ask(h!.data, 'j1', WHY, 'text', { maxLength: 300 });
    ask(h!.data, 'j1', 'Current location');
    const r = j(await s.get('/api/apply-questions?status=open'));
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({ job_id: 'j1', title: 'Frontend Engineer', company: 'Acme', host: HOST, resume_pdf: '/tmp/j1.pdf', ats_note: 'ats ok' });
    expect(r.jobs[0].questions.map((q: any) => [q.label, q.maxlength, q.suggested, q.agent_allowed])).toEqual([[WHY, 300, null, true], ['Current location', null, 'Pune', false]]);
    expect(r.counts).toEqual({ questions: 2, jobs: 1 });
    expect((await s.get('/api/apply-questions?status=zzz')).status).toBe(400);
    const c = j(await s.get('/api/escalations/count'));
    expect(c).toMatchObject({ questions: 2, questionJobs: 1, badge: 1 });
  });

  it('bulk-answers several questions of one job, applies the job comment, releases the job and audits without text', async () => {
    const s = await setup();
    seed(h!.data, 'j1');
    const a = ask(h!.data, 'j1', 'Work mode', 'select', { options: ['Remote', 'Hybrid'] });
    const b = ask(h!.data, 'j1', 'Current location');
    const res = await s.post('/api/apply-questions/answer', {
      answers: [{ id: a, answer: 'remote', scope: 'once' }, { id: b, answer: 'Pune', scope: 'always' }], comment: 'secret-comment-text',
    });
    expect(res.status).toBe(200);
    const body = j(res);
    expect(body.ok).toBe(true);
    expect(body.results.map((x: any) => x.ok)).toEqual([true, true]);
    expect(getQuestion(h!.data, a)).toMatchObject({ status: 'answered', answer: 'Remote', answer_scope: 'once', owner_comment: 'secret-comment-text' });
    expect(getQuestion(h!.data, b)).toMatchObject({ status: 'answered', answer_scope: 'always' });
    expect(status(h!.data, 'j1')).toBeNull(); // retryable
    expect(JSON.parse(fs.readFileSync(s.answersPath, 'utf8')).custom).toEqual({ 'current location': 'Pune' });
    expect(auditKinds()).toContain('apply_question_answer');
    const notes = (h!.auth.prepare('SELECT note FROM audit_log').all() as { note: string | null }[]).map((r) => r.note ?? '').join('|');
    expect(notes).not.toContain('Pune');
    expect(notes).not.toContain('secret-comment-text');
  });

  it('single answer runs the gates: bad option, too long and a link not in the resume are refused with a reason', async () => {
    const s = await setup();
    seed(h!.data, 'j1');
    const sel = ask(h!.data, 'j1', 'Work mode', 'select', { options: ['Remote', 'Hybrid'] });
    const short = ask(h!.data, 'j1', 'Nickname', 'text', { maxLength: 5 });
    const link = ask(h!.data, 'j1', 'Portfolio', 'text');
    let r = await s.post('/api/apply-questions/answer', { id: sel, answer: 'Onsite', scope: 'once' });
    expect(r.status).toBe(422);
    expect(j(r).error).toContain('pick one of the options');
    r = await s.post('/api/apply-questions/answer', { id: short, answer: 'much too long', scope: 'once' });
    expect(j(r).error).toContain('at most 5');
    r = await s.post('/api/apply-questions/answer', { id: link, answer: 'https://evil.example.org/x', scope: 'once' });
    expect(j(r).error).toContain('url_not_allowed');
    expect(getQuestion(h!.data, sel)!.status).toBe('open');
    expect(status(h!.data, 'j1')).toBe('needs_answer');
  });

  it('validates input: ids, scope, lengths and JSON only', async () => {
    const s = await setup();
    seed(h!.data, 'j1');
    const id = ask(h!.data, 'j1', WHY);
    for (const [p, b] of [
      ['answer', { id: 0, answer: 'x', scope: 'once' }], ['answer', { id: 'a', answer: 'x', scope: 'once' }], ['answer', { id, answer: 'x', scope: 'forever' }],
      ['answer', { id, answer: 5, scope: 'once' }], ['answer', { id, answer: 'x', scope: 'once', comment: 'c'.repeat(1001) }], ['answer', { answers: [] }],
      ['answer', { answers: [{ id, answer: 'x', scope: 'once' }, { id, answer: 'y', scope: 'once' }] }],
      ['agent-handle', { ids: [] }], ['agent-handle', { ids: [-1] }], ['agent-handle', { ids: [1.5] }], ['agent-handle', { ids: [id], comment: 7 }], ['skip', { ids: 'x' }],
    ] as [string, unknown][]) {
      expect((await s.post(`/api/apply-questions/${p}`, b)).status, `${p} ${JSON.stringify(b)}`).toBe(400);
    }
    const notJson = await h!.call('POST', '/api/apply-questions/skip', { headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: s.origin, 'content-type': 'text/plain' }, body: 'ids=1' });
    expect(notJson.status).toBe(415);
    expect(auditKinds()).toContain('apply_question_reject');
    expect(getQuestion(h!.data, id)!.status).toBe('open');
  });

  it('agent-handle: allowed for a motivational question, refused for a factual one, job stays paused', async () => {
    const s = await setup();
    seed(h!.data, 'j1');
    const why = ask(h!.data, 'j1', WHY);
    const sal = ask(h!.data, 'j1', 'Expected salary');
    const bad = await s.post('/api/apply-questions/agent-handle', { ids: [sal] });
    expect(bad.status).toBe(422);
    expect(j(bad).error).toMatch(/only a free-text/);
    const mixed = await s.post('/api/apply-questions/agent-handle', { ids: [why, sal], comment: 'lean on my React work' });
    expect(mixed.status).toBe(200);
    expect(j(mixed).results.map((x: any) => x.ok)).toEqual([true, false]);
    expect(getQuestion(h!.data, why)).toMatchObject({ status: 'agent_handle', owner_comment: 'lean on my React work' });
    expect(getQuestion(h!.data, sal)!.status).toBe('open');
    expect(status(h!.data, 'j1')).toBe('needs_answer');
    // still listed (so the owner can answer it by hand) while another question is open; counts only the open one
    const r = j(await s.get('/api/apply-questions'));
    expect(r.jobs[0].questions.map((q: any) => q.status)).toEqual(['agent_handle', 'open']);
    expect(r.counts.questions).toBe(1);
  });

  it('skip with a comment moves the job to manual_review', async () => {
    const s = await setup();
    seed(h!.data, 'j1');
    const id = ask(h!.data, 'j1', 'Expected salary');
    const r = await s.post('/api/apply-questions/skip', { ids: [id], comment: 'applied by hand' });
    expect(r.status).toBe(200);
    expect(getQuestion(h!.data, id)).toMatchObject({ status: 'skipped', owner_comment: 'applied by hand' });
    expect(status(h!.data, 'j1')).toBe('manual_review');
    expect((await s.post('/api/apply-questions/skip', { ids: [id] })).status).toBe(422); // already skipped
    expect(auditKinds().filter((k) => k === 'apply_question_skip')).toHaveLength(2);
  });

  it('answers a write failure when no writer is configured', async () => {
    h = await makeHarness();
    const { cookie } = await h.login();
    const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
    seed(h.data, 'j1');
    const id = ask(h.data, 'j1', WHY);
    const r = await h.call('POST', '/api/apply-questions/agent-handle', { headers: { cookie, 'x-csrf-token': s.csrf, origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    expect(r.status).toBe(422);
    expect(j(r).error).toBe('write failed');
    expect(getQuestion(h.data, id)!.status).toBe('open');
  });
});
