// apply_questions: the questions an application form asked that nothing reliable could answer. Rule: the applier never guesses or
// invents. An answer may come only from the owner's answer book (user-data/easy-apply-answers.json, the profile and resume), a value
// derived deterministically from the resume (src/apply/derive.ts), or an answer the owner gave here. Anything else pauses the job as
// `needs_answer` (a clean status, not drift and not a failure) and writes one open row per distinct question (normalized label + host).
// The owner answers with `npm run answers -- answer <id> "<text>" [--always]`; an answer sets the job back to retryable.
// Labels are untrusted page text: cleaned and capped before they are stored. Pure db code, no browser, no I/O besides the db.
import type BetterSqlite3 from 'better-sqlite3';
import { cleanText } from '../dash/clean.js';
import { normalizeQuestion } from './answers.js';

type Db = BetterSqlite3.Database;

export const QUESTION_KINDS = ['text', 'select', 'radio', 'checkbox'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type QuestionStatus = 'open' | 'answered' | 'skipped';
export type AnswerScope = 'once' | 'always';

export const NEEDS_ANSWER = 'needs_answer';
export const LABEL_MAX = 300;
export const ANSWER_MAX = 2000;
const OPTION_MAX = 80;
const OPTIONS_CAP = 30;

export interface QuestionRow {
  id: number;
  job_id: string;
  host: string;
  label: string;
  norm_label: string;
  kind: QuestionKind;
  options: string[];
  max_length: number | null;
  status: QuestionStatus;
  answer: string | null;
  answer_scope: AnswerScope | null;
  created_at: string;
  answered_at: string | null;
  /** Every job that met this question (the row's own job first). */
  job_ids: string[];
}

export function migrateApplyQuestions(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apply_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      host TEXT NOT NULL,
      label TEXT NOT NULL,
      norm_label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      options TEXT,
      max_length INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      answer TEXT,
      answer_scope TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_apply_questions_status ON apply_questions(status, host);
    CREATE INDEX IF NOT EXISTS idx_apply_questions_norm ON apply_questions(norm_label, host);
    CREATE TABLE IF NOT EXISTS apply_question_jobs (
      question_id INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      PRIMARY KEY (question_id, job_id)
    );
  `);
}

/** Cleaned label as shown to the owner: no controls, no angle brackets, one line, capped. */
export function cleanLabel(raw: string): string {
  return cleanText(String(raw ?? ''), LABEL_MAX).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

/** The dedupe and answer-book key: lowercase, one space, no trailing star. Same function the answer book matches with. */
export function normLabel(label: string): string {
  return normalizeQuestion(cleanLabel(label)).slice(0, 200);
}

const hostKey = (h: string): string => String(h ?? '').toLowerCase().slice(0, 253);

interface Raw {
  id: number; job_id: string; host: string; label: string; norm_label: string; kind: string; options: string | null; max_length: number | null;
  status: string; answer: string | null; answer_scope: string | null; created_at: string; answered_at: string | null;
}

function toRow(db: Db, r: Raw): QuestionRow {
  let options: string[] = [];
  try { const p = JSON.parse(r.options ?? '[]'); if (Array.isArray(p)) options = p.filter((x): x is string => typeof x === 'string'); } catch { /* none */ }
  const jobs = (db.prepare('SELECT job_id FROM apply_question_jobs WHERE question_id = ? ORDER BY rowid').all(r.id) as { job_id: string }[]).map((x) => x.job_id);
  return {
    ...r, kind: (QUESTION_KINDS as readonly string[]).includes(r.kind) ? (r.kind as QuestionKind) : 'text', options,
    status: r.status as QuestionStatus, answer_scope: (r.answer_scope as AnswerScope | null), job_ids: jobs.length ? jobs : [r.job_id],
  };
}

export interface RecordInput {
  jobId: string;
  host: string;
  label: string;
  kind: QuestionKind;
  options?: string[];
  maxLength?: number | null;
}

/**
 * One row per distinct unanswered question (normalized label + host). A repeat refreshes the open row and links the job to it; a question
 * the owner already skipped is not reopened (the job goes to manual_review); a question already answered `always` is not asked again.
 */
export function recordQuestion(db: Db, i: RecordInput, now: Date): { id: number; created: boolean; status: QuestionStatus } {
  const label = cleanLabel(i.label);
  const norm = normLabel(i.label);
  const host = hostKey(i.host);
  if (!label || !norm || !host) throw new Error('question needs a label and a host');
  const options = (i.options ?? []).map((o) => cleanText(String(o), OPTION_MAX).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, OPTIONS_CAP);
  const maxLength = i.maxLength && i.maxLength > 0 && i.maxLength < 100000 ? Math.floor(i.maxLength) : null;
  const existing = db.prepare(
    "SELECT * FROM apply_questions WHERE norm_label = ? AND host = ? AND (status = 'open' OR (status = 'skipped') OR (status = 'answered' AND answer_scope = 'always')) ORDER BY (status = 'open') DESC, id DESC LIMIT 1",
  ).get(norm, host) as Raw | undefined;
  if (existing) {
    db.prepare('INSERT OR IGNORE INTO apply_question_jobs (question_id, job_id) VALUES (?, ?)').run(existing.id, i.jobId);
    if (existing.status === 'open') {
      db.prepare('UPDATE apply_questions SET label = ?, kind = ?, options = ?, max_length = COALESCE(?, max_length) WHERE id = ?')
        .run(label, i.kind, JSON.stringify(options), maxLength, existing.id);
    }
    return { id: existing.id, created: false, status: existing.status as QuestionStatus };
  }
  const res = db.prepare(
    "INSERT INTO apply_questions (job_id, host, label, norm_label, kind, options, max_length, status, created_at) VALUES (?,?,?,?,?,?,?,'open',?)",
  ).run(i.jobId, host, label, norm, i.kind, JSON.stringify(options), maxLength, now.toISOString());
  const id = Number(res.lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO apply_question_jobs (question_id, job_id) VALUES (?, ?)').run(id, i.jobId);
  return { id, created: true, status: 'open' };
}

export function getQuestion(db: Db, id: number): QuestionRow | null {
  const r = db.prepare('SELECT * FROM apply_questions WHERE id = ?').get(id) as Raw | undefined;
  return r ? toRow(db, r) : null;
}

export function listQuestions(db: Db, opts: { status?: QuestionStatus | 'all'; limit?: number } = {}): QuestionRow[] {
  const status = opts.status ?? 'open';
  const lim = Math.min(500, Math.max(1, opts.limit ?? 200));
  const rows = (status === 'all'
    ? db.prepare('SELECT * FROM apply_questions ORDER BY id DESC LIMIT ?').all(lim)
    : db.prepare('SELECT * FROM apply_questions WHERE status = ? ORDER BY id ASC LIMIT ?').all(status, lim)) as Raw[];
  return rows.map((r) => toRow(db, r));
}

/** Open questions of one job (what its escalation lists). */
export function openQuestionsForJob(db: Db, jobId: string): QuestionRow[] {
  const rows = db.prepare(
    "SELECT q.* FROM apply_questions q JOIN apply_question_jobs j ON j.question_id = q.id WHERE j.job_id = ? AND q.status = 'open' ORDER BY q.id",
  ).all(jobId) as Raw[];
  return rows.map((r) => toRow(db, r));
}

export function openQuestionsForHost(db: Db, host: string): QuestionRow[] {
  return (db.prepare("SELECT * FROM apply_questions WHERE host = ? AND status = 'open' ORDER BY id").all(hostKey(host)) as Raw[]).map((r) => toRow(db, r));
}

export function countOpenQuestions(db: Db): number {
  try { return (db.prepare("SELECT COUNT(*) AS n FROM apply_questions WHERE status = 'open'").get() as { n: number }).n; } catch { return 0; }
}

/** The owner's answer for this exact question on this job (`once`) or this host and label (`always`); null when none. Never fuzzy. */
export function storedAnswer(db: Db, jobId: string, host: string, label: string): string | null {
  const norm = normLabel(label);
  if (!norm) return null;
  try {
    const once = db.prepare(
      "SELECT q.answer FROM apply_questions q JOIN apply_question_jobs j ON j.question_id = q.id WHERE j.job_id = ? AND q.norm_label = ? AND q.status = 'answered' AND q.answer_scope = 'once' AND q.answer IS NOT NULL ORDER BY q.id DESC LIMIT 1",
    ).get(jobId, norm) as { answer: string } | undefined;
    if (once) return once.answer;
    const always = db.prepare(
      "SELECT answer FROM apply_questions WHERE norm_label = ? AND host = ? AND status = 'answered' AND answer_scope = 'always' AND answer IS NOT NULL ORDER BY id DESC LIMIT 1",
    ).get(norm, hostKey(host)) as { answer: string } | undefined;
    return always?.answer ?? null;
  } catch { return null; }
}

/** Puts a paused job back in the apply queue once nothing it asked is still open. Returns the jobs released. */
function releaseJobs(db: Db, jobIds: string[]): string[] {
  const out: string[] = [];
  for (const jobId of new Set(jobIds)) {
    if (openQuestionsForJob(db, jobId).length) {
      refreshCount(db, jobId);
      continue;
    }
    const c = db.prepare("UPDATE outreach_queue SET apply_status = NULL, apply_note = NULL, updated_at = datetime('now') WHERE job_id = ? AND apply_status = ?").run(jobId, NEEDS_ANSWER).changes;
    if (c > 0) out.push(jobId);
  }
  return out;
}

function refreshCount(db: Db, jobId: string): void {
  const n = openQuestionsForJob(db, jobId).length;
  db.prepare("UPDATE outreach_queue SET apply_note = ?, updated_at = datetime('now') WHERE job_id = ? AND apply_status = ?").run(needsAnswerNote(n), jobId, NEEDS_ANSWER);
}

export const needsAnswerNote = (n: number): string => `${n} question${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} your answer`;

/** Pauses a job as needs_answer with the count of its open questions. Only a job still pending (or already paused) is touched. */
export function pauseJobNeedsAnswer(db: Db, jobId: string): number {
  const n = openQuestionsForJob(db, jobId).length;
  db.prepare(
    "UPDATE outreach_queue SET apply_status = ?, apply_note = ?, updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') IN ('', 'queued', ?, 'needs_owner')",
  ).run(NEEDS_ANSWER, needsAnswerNote(n), jobId, NEEDS_ANSWER);
  return n;
}

export type AnswerCheck = { ok: true; value: string } | { ok: false; reason: string };

/** Shape checks that need no gate: not empty, within the field's maxlength, one of the listed options for a select or radio. */
export function checkAnswerShape(q: Pick<QuestionRow, 'kind' | 'options' | 'max_length'>, text: string): AnswerCheck {
  const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!value) return { ok: false, reason: 'the answer is empty' };
  if (value.length > ANSWER_MAX) return { ok: false, reason: `the answer is longer than ${ANSWER_MAX} characters` };
  if (q.max_length && value.length > q.max_length) return { ok: false, reason: `the field allows at most ${q.max_length} characters, this answer has ${value.length}` };
  if ((q.kind === 'select' || q.kind === 'radio') && q.options.length) {
    const hit = q.options.find((o) => normalizeQuestion(o) === normalizeQuestion(value));
    if (!hit) return { ok: false, reason: `pick one of the options: ${q.options.join(' | ')}` };
    return { ok: true, value: hit };
  }
  return { ok: true, value };
}

export interface AnswerOutcome { answered: number[]; released: string[] }

/**
 * Stores the owner's answer. `once` covers this question's jobs only; `always` also answers every other open question with the same
 * normalized label (any host), because the answer book reuses it for every later form. Jobs with nothing left open become retryable.
 * The caller has already run the shape, output and fact gates and (for `always`) written the answer book.
 */
export function markAnswered(db: Db, id: number, value: string, scope: AnswerScope, now: Date): AnswerOutcome {
  const q = getQuestion(db, id);
  if (!q) throw new Error('no such question');
  if (q.status !== 'open') throw new Error(`question ${id} is already ${q.status}`);
  const run = db.transaction((): AnswerOutcome => {
    const targets = scope === 'always'
      ? (db.prepare("SELECT id FROM apply_questions WHERE status = 'open' AND norm_label = ?").all(q.norm_label) as { id: number }[]).map((r) => r.id)
      : [id];
    const jobs: string[] = [];
    for (const tid of targets) {
      const t = getQuestion(db, tid)!;
      jobs.push(...t.job_ids);
      db.prepare("UPDATE apply_questions SET status = 'answered', answer = ?, answer_scope = ?, answered_at = ? WHERE id = ?").run(value, scope, now.toISOString(), tid);
    }
    return { answered: targets, released: releaseJobs(db, jobs) };
  });
  return run();
}

/** The owner declines to answer: the question is not asked again on this host and its jobs go to manual_review (a clean end, not a failure). */
export function markSkipped(db: Db, id: number, now: Date): { jobs: string[] } {
  const q = getQuestion(db, id);
  if (!q) throw new Error('no such question');
  if (q.status !== 'open') throw new Error(`question ${id} is already ${q.status}`);
  db.transaction(() => {
    db.prepare("UPDATE apply_questions SET status = 'skipped', answered_at = ? WHERE id = ?").run(now.toISOString(), id);
    for (const j of q.job_ids) {
      db.prepare("UPDATE outreach_queue SET apply_status = 'manual_review', apply_note = 'question_skipped', updated_at = datetime('now') WHERE job_id = ? AND apply_status = ?").run(j, NEEDS_ANSWER);
    }
  })();
  return { jobs: q.job_ids };
}
