// apply_questions: the questions an application form asked that nothing reliable could answer. Rule: the applier never guesses or
// invents. An answer may come only from the owner's answer book (user-data/easy-apply-answers.json, the profile and resume), a value
// derived deterministically from the resume (src/apply/derive.ts), or an answer the owner gave here. Anything else pauses the job as
// `needs_answer` (a clean status, not drift and not a failure) and writes one open row per distinct question (normalized label + host).
// The owner answers with `npm run answers -- answer <id> "<text>" [--always]`; an answer sets the job back to retryable.
// Labels are untrusted page text: cleaned and capped before they are stored. Pure db code, no browser, no I/O besides the db.
import type BetterSqlite3 from 'better-sqlite3';
import { cleanText } from '../dash/clean.js';
import { normalizeQuestion } from './answers.js';
import { deriveFromResume } from './derive.js';

type Db = BetterSqlite3.Database;

export const QUESTION_KINDS = ['text', 'select', 'radio', 'checkbox'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
// `agent_handle`: the owner asked the agent to draft the answer itself (the drafting is a later task); until then the question is still unanswered.
export type QuestionStatus = 'open' | 'answered' | 'skipped' | 'agent_handle';
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
  /** The owner's note: guidance for `agent_handle`, the reason for `skipped`, context for an answer. */
  owner_comment: string | null;
  /** Who wrote the stored answer: `drafted` (the apply-operator, behind the gates) or null (the owner). */
  answer_source: string | null;
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
  const cols = new Set((db.prepare('PRAGMA table_info(apply_questions)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('owner_comment')) db.exec('ALTER TABLE apply_questions ADD COLUMN owner_comment TEXT');
  if (!cols.has('answer_source')) db.exec('ALTER TABLE apply_questions ADD COLUMN answer_source TEXT');
}

export const COMMENT_MAX = 1000;

/** Owner comment as stored: controls removed, angle brackets dropped, capped. Empty becomes null. */
export function cleanComment(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = cleanText(raw, COMMENT_MAX).replace(/[<>]/g, '').trim();
  return t || null;
}

// Only free-text motivational or descriptive questions may be left to the agent to draft. Anything factual (money, dates, places, work
// authorization, links, ids, consent, personal data) is refused: the agent must never invent those.
const FACTUAL_RE = /salary|ctc|compensation|remunerat|\bpay\b|expected|notice|start date|available|availability|joining|location|city|country|state\b|relocat|authori[sz]|visa|sponsor|citizen|work permit|\burl\b|link|linkedin|github|portfolio|website|\bphone\b|mobile|email|address|\bid\b|number|consent|agree|gdpr|privacy|terms|gender|race|ethnic|veteran|disab|pronoun|birth|\bage\b|years?\b|how many|referr|how did you hear|\bname\b|degree|graduat|cgpa|percentage|current employer|current company|current title/i;
const DESCRIPTIVE_RE = /why (do|are|would|should|did)|why (this|our|us)|why you|motivat|what (excites|interests|attracts|draws)|interested in|interest in|about (you|yourself)|tell us|describe|cover letter|passion|what makes you|anything else|additional information|your experience with|proud|challenge|strengths?/i;

/** True only for a free-text question the agent may draft (why this company or role, interests, about you, cover-letter style). */
export function agentHandleAllowed(label: string, kind: QuestionKind): boolean {
  if (kind !== 'text') return false;
  const l = cleanLabel(label);
  if (!l || FACTUAL_RE.test(l)) return false;
  return DESCRIPTIVE_RE.test(l);
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
  status: string; answer: string | null; answer_scope: string | null; created_at: string; answered_at: string | null; owner_comment?: string | null; answer_source?: string | null;
}

function toRow(db: Db, r: Raw): QuestionRow {
  let options: string[] = [];
  try { const p = JSON.parse(r.options ?? '[]'); if (Array.isArray(p)) options = p.filter((x): x is string => typeof x === 'string'); } catch { /* none */ }
  const jobs = (db.prepare('SELECT job_id FROM apply_question_jobs WHERE question_id = ? ORDER BY rowid').all(r.id) as { job_id: string }[]).map((x) => x.job_id);
  return {
    ...r, owner_comment: r.owner_comment ?? null, answer_source: r.answer_source ?? null, kind: (QUESTION_KINDS as readonly string[]).includes(r.kind) ? (r.kind as QuestionKind) : 'text', options,
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
    "SELECT * FROM apply_questions WHERE norm_label = ? AND host = ? AND (status = 'open' OR status = 'agent_handle' OR (status = 'skipped') OR (status = 'answered' AND answer_scope = 'always')) ORDER BY (status = 'open') DESC, (status = 'agent_handle') DESC, id DESC LIMIT 1",
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

/** Questions of one job the owner left to the agent to draft (still unanswered: nothing is guessed until the drafting exists). */
export function agentQuestionsForJob(db: Db, jobId: string): QuestionRow[] {
  const rows = db.prepare(
    "SELECT q.* FROM apply_questions q JOIN apply_question_jobs j ON j.question_id = q.id WHERE j.job_id = ? AND q.status = 'agent_handle' ORDER BY q.id",
  ).all(jobId) as Raw[];
  return rows.map((r) => toRow(db, r));
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
      // Questions still waiting for the owner keep the job paused (the applier never guesses). Questions left to the agent
      // (`agent_handle`) do not: the next apply run drafts them behind the gates, or hands them back to the owner.
      refreshCount(db, jobId);
      continue;
    }
    const c = db.prepare("UPDATE outreach_queue SET apply_status = NULL, apply_note = NULL, updated_at = datetime('now') WHERE job_id = ? AND apply_status = ?").run(jobId, NEEDS_ANSWER).changes;
    if (c > 0) out.push(jobId);
  }
  return out;
}

function refreshCount(db: Db, jobId: string): void {
  db.prepare("UPDATE outreach_queue SET apply_note = ?, updated_at = datetime('now') WHERE job_id = ? AND apply_status = ?").run(jobNote(db, jobId), jobId, NEEDS_ANSWER);
}

function jobNote(db: Db, jobId: string): string {
  const n = openQuestionsForJob(db, jobId).length;
  const a = agentQuestionsForJob(db, jobId).length;
  return n === 0 && a > 0 ? `${a} question${a === 1 ? '' : 's'} waiting for the agent to draft` : needsAnswerNote(n);
}

export const needsAnswerNote = (n: number): string => `${n} question${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} your answer`;

/** Pauses a job as needs_answer with the count of its open questions. Only a job still pending (or already paused) is touched. */
export function pauseJobNeedsAnswer(db: Db, jobId: string): number {
  const n = openQuestionsForJob(db, jobId).length;
  db.prepare(
    "UPDATE outreach_queue SET apply_status = ?, apply_note = ?, updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') IN ('', 'queued', ?, 'needs_owner')",
  ).run(NEEDS_ANSWER, jobNote(db, jobId), jobId, NEEDS_ANSWER);
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
export function markAnswered(db: Db, id: number, value: string, scope: AnswerScope, now: Date, comment?: string | null, source?: 'drafted' | null): AnswerOutcome {
  const q = getQuestion(db, id);
  if (!q) throw new Error('no such question');
  if (q.status !== 'open' && q.status !== 'agent_handle') throw new Error(`question ${id} is already ${q.status}`);
  const note = cleanComment(comment);
  const run = db.transaction((): AnswerOutcome => {
    const targets = scope === 'always'
      ? (db.prepare("SELECT id FROM apply_questions WHERE status IN ('open', 'agent_handle') AND norm_label = ?").all(q.norm_label) as { id: number }[]).map((r) => r.id)
      : [id];
    const jobs: string[] = [];
    for (const tid of targets) {
      const t = getQuestion(db, tid)!;
      jobs.push(...t.job_ids);
      db.prepare("UPDATE apply_questions SET status = 'answered', answer = ?, answer_scope = ?, answered_at = ?, owner_comment = COALESCE(?, owner_comment), answer_source = ? WHERE id = ?").run(value, scope, now.toISOString(), note, source ?? null, tid);
    }
    return { answered: targets, released: releaseJobs(db, jobs) };
  });
  return run();
}

/** The owner declines to answer ("I applied by hand"): the question is not asked again on this host and its jobs go to manual_review (a clean end, not a failure). */
export function markSkipped(db: Db, id: number, now: Date, comment?: string | null): { jobs: string[] } {
  const q = getQuestion(db, id);
  if (!q) throw new Error('no such question');
  if (q.status !== 'open' && q.status !== 'agent_handle') throw new Error(`question ${id} is already ${q.status}`);
  const note = cleanComment(comment);
  db.transaction(() => {
    db.prepare("UPDATE apply_questions SET status = 'skipped', answered_at = ?, owner_comment = COALESCE(?, owner_comment) WHERE id = ?").run(now.toISOString(), note, id);
    for (const j of q.job_ids) {
      db.prepare("UPDATE outreach_queue SET apply_status = 'manual_review', apply_note = 'question_skipped', updated_at = datetime('now') WHERE job_id = ? AND apply_status = ?").run(j, NEEDS_ANSWER);
    }
  })();
  return { jobs: q.job_ids };
}

/**
 * The owner leaves the question to the agent. Only a free-text motivational or descriptive question qualifies (`agentHandleAllowed`).
 * The question stays unanswered (nothing is guessed): the job stays paused until the later drafting task answers it. The comment is
 * guidance that task reads.
 */
export function markAgentHandle(db: Db, id: number, now: Date, comment?: string | null): { jobs: string[] } {
  const q = getQuestion(db, id);
  if (!q) throw new Error('no such question');
  if (q.status !== 'open' && q.status !== 'agent_handle') throw new Error(`question ${id} is already ${q.status}`);
  if (!agentHandleAllowed(q.label, q.kind)) throw new Error('not_allowed: only a free-text motivational question can be left to the agent');
  const note = cleanComment(comment);
  db.transaction(() => {
    db.prepare("UPDATE apply_questions SET status = 'agent_handle', answered_at = ?, owner_comment = COALESCE(?, owner_comment) WHERE id = ?").run(now.toISOString(), note, id);
    // A job whose only open questions are now left to the agent goes back to the apply queue: the next run drafts the answers.
    releaseJobs(db, q.job_ids);
  })();
  return { jobs: q.job_ids };
}

/**
 * Stores a DRAFTED answer for ONE job (scope `once`). A drafted answer is company-specific, so a row shared with other jobs is split:
 * this job gets its own answered row and is unlinked from the shared one, which stays as it was for the other jobs (they draft their own).
 */
export function markAnsweredForJob(db: Db, id: number, jobId: string, value: string, now: Date, source: 'drafted' = 'drafted'): AnswerOutcome {
  const q = getQuestion(db, id);
  if (!q) throw new Error('no such question');
  if (q.status !== 'open' && q.status !== 'agent_handle') throw new Error(`question ${id} is already ${q.status}`);
  const others = q.job_ids.filter((j) => j !== jobId);
  if (others.length === 0) return markAnswered(db, id, value, 'once', now, null, source);
  return db.transaction((): AnswerOutcome => {
    const res = db.prepare(
      `INSERT INTO apply_questions (job_id, host, label, norm_label, kind, options, max_length, status, answer, answer_scope, created_at, answered_at, owner_comment, answer_source)
       VALUES (?,?,?,?,?,?,?,'answered',?,'once',?,?,?,?)`,
    ).run(jobId, q.host, q.label, q.norm_label, q.kind, JSON.stringify(q.options), q.max_length, value, q.created_at, now.toISOString(), q.owner_comment, source);
    const nid = Number(res.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO apply_question_jobs (question_id, job_id) VALUES (?, ?)').run(nid, jobId);
    db.prepare('DELETE FROM apply_question_jobs WHERE question_id = ? AND job_id = ?').run(id, jobId);
    if (q.job_id === jobId) db.prepare('UPDATE apply_questions SET job_id = ? WHERE id = ?').run(others[0], id);
    return { answered: [nid], released: releaseJobs(db, [jobId]) };
  })();
}

/**
 * The agent could not draft an acceptable answer (twice) or the question is not one it may draft: it goes back to the owner (`open`, the
 * owner's comment kept) and its jobs stay paused as needs_answer. Idempotent; an answered or skipped row is untouched.
 */
export function reopenForOwner(db: Db, id: number): boolean {
  const q = getQuestion(db, id);
  if (!q || (q.status !== 'agent_handle' && q.status !== 'open')) return false;
  db.transaction(() => {
    if (q.status === 'agent_handle') db.prepare("UPDATE apply_questions SET status = 'open', answered_at = NULL WHERE id = ?").run(id);
    for (const j of q.job_ids) {
      db.prepare("UPDATE outreach_queue SET apply_status = ?, apply_note = ?, updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') IN ('', 'queued', ?, 'needs_owner')")
        .run(NEEDS_ANSWER, needsAnswerNote(openQuestionsForJob(db, j).length), j, NEEDS_ANSWER);
    }
  })();
  return true;
}

/** Hands every question of a job that was left to the agent back to the owner (the operator escalated the job for its questions). */
export function reopenAgentQuestionsForJob(db: Db, jobId: string): number {
  const rows = agentQuestionsForJob(db, jobId);
  for (const q of rows) reopenForOwner(db, q.id);
  return rows.length;
}

/** Saves a comment on a question without changing its status. */
export function setOwnerComment(db: Db, id: number, comment: string | null): void {
  db.prepare('UPDATE apply_questions SET owner_comment = ? WHERE id = ?').run(cleanComment(comment), id);
}

export interface Guidance { label: string; host: string; comment: string; status: QuestionStatus }

/**
 * Prior owner comments for the same normalized label (same host first, newest first). Read model for the later drafting task: the
 * comments are guidance, never an answer. Similar = same normalized label, or one label contains the other (both at least 12 chars).
 */
export function ownerGuidanceFor(db: Db, label: string, host?: string, limit = 5): Guidance[] {
  const norm = normLabel(label);
  if (!norm) return [];
  let rows: Raw[];
  try {
    rows = db.prepare("SELECT * FROM apply_questions WHERE owner_comment IS NOT NULL AND owner_comment != '' ORDER BY id DESC LIMIT 500").all() as Raw[];
  } catch { return []; }
  const h = host ? hostKey(host) : '';
  const similar = (n: string): boolean => n === norm || (n.length >= 12 && norm.length >= 12 && (n.includes(norm) || norm.includes(n)));
  const hits = rows.filter((r) => similar(r.norm_label));
  hits.sort((a, b) => Number(Boolean(h) && b.host === h) - Number(Boolean(h) && a.host === h) || b.id - a.id);
  return hits.slice(0, Math.max(1, limit)).map((r) => ({ label: r.label, host: r.host, comment: r.owner_comment as string, status: r.status as QuestionStatus }));
}

/** A value the system could derive from the resume for this label, shown as a prefilled hint. Never applied automatically. */
export function suggestedAnswer(label: string, resume: Record<string, unknown> | null, now: Date = new Date()): string | null {
  if (!resume) return null;
  const l = cleanLabel(label).toLowerCase();
  const d = deriveFromResume(resume, now);
  if (/years?.*(experience|work)|experience.*years?|how many years/.test(l) && d.years_experience !== null) return String(d.years_experience);
  if (/(current|present).*(location|city)|where are you (based|located)|current city/.test(l) && d.current_location) return d.current_location;
  if (/\b(skills|tech stack|technologies)\b/.test(l) && d.skills) return d.skills;
  return null;
}
