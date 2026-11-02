// Read model of the questions an application form asked that nothing reliable could answer, grouped by job: what the dashboard Inbox,
// `npm run answers -- list`, the /escalations text and the Telegram digest show. Read-only (works on the dashboard's read-only handle).
// Every text field is untrusted page or job text: cleaned and capped here, rendered as plain text by every consumer.
import type BetterSqlite3 from 'better-sqlite3';
import { cleanText } from '../dash/clean.js';
import { agentHandleAllowed, cleanLabel, suggestedAnswer, type QuestionKind, type QuestionStatus } from './questions.js';

type Db = BetterSqlite3.Database;

export interface InboxQuestion {
  id: number; label: string; kind: QuestionKind; options: string[]; maxlength: number | null; status: QuestionStatus;
  answer: string | null; owner_comment: string | null; suggested: string | null;
  /** True when the owner may leave this question to the agent (free-text motivational questions only). */
  agent_allowed: boolean;
  /** Number of jobs that met this question. */
  job_count: number;
}

export interface InboxJobGroup {
  job_id: string; title: string; company: string; apply_url: string | null; host: string;
  resume_pdf: string | null; ats_note: string | null; apply_status: string | null;
  questions: InboxQuestion[];
}

const JOBS_MAX = 100;
const QUESTIONS_PER_JOB_MAX = 40;

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function cols(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

/** Only an https link is offered as a link; anything else is shown as nothing. */
function safeUrl(u: unknown): string | null {
  const t = cleanText(String(u ?? ''), 500);
  return /^https:\/\/[^\s]+$/i.test(t) ? t : null;
}

export interface GroupOpts {
  /** `open` (default): jobs with at least one open question. `all`: also jobs whose questions are all done (newest first). */
  status?: 'open' | 'all';
  resume?: Record<string, unknown> | null;
  now?: Date;
}

export function groupedQuestions(db: Db, opts: GroupOpts = {}): InboxJobGroup[] {
  if (!hasTable(db, 'apply_questions') || !hasTable(db, 'apply_question_jobs')) return [];
  const qcols = cols(db, 'apply_questions');
  const commentCol = qcols.has('owner_comment') ? 'q.owner_comment' : 'NULL';
  const statusFilter = opts.status === 'all' ? '1 = 1' : "q.status IN ('open', 'agent_handle')";
  const rows = db.prepare(
    `SELECT q.id, q.host, q.label, q.kind, q.options, q.max_length, q.status, q.answer, ${commentCol} AS owner_comment, j.job_id AS jid
       FROM apply_questions q JOIN apply_question_jobs j ON j.question_id = q.id WHERE ${statusFilter} ORDER BY q.id`,
  ).all() as { id: number; host: string; label: string; kind: string; options: string | null; max_length: number | null; status: string; answer: string | null; owner_comment: string | null; jid: string }[];
  const counts = new Map<number, number>();
  for (const r of db.prepare('SELECT question_id AS id, COUNT(*) AS n FROM apply_question_jobs GROUP BY question_id').all() as { id: number; n: number }[]) counts.set(r.id, r.n);

  const jobCols = hasTable(db, 'jobs') ? cols(db, 'jobs') : new Set<string>();
  const queueCols = hasTable(db, 'outreach_queue') ? cols(db, 'outreach_queue') : new Set<string>();
  const byJob = new Map<string, InboxJobGroup>();
  const now = opts.now ?? new Date();
  for (const r of rows) {
    let g = byJob.get(r.jid);
    if (!g) {
      const job = jobCols.size
        ? db.prepare(`SELECT title, company, apply_url${jobCols.has('external_apply_url') ? ', external_apply_url' : ''} FROM jobs WHERE id = ?`).get(r.jid) as { title?: string; company?: string; apply_url?: string; external_apply_url?: string } | undefined
        : undefined;
      const queue = queueCols.size
        ? db.prepare(`SELECT resume_pdf_path, apply_status${queueCols.has('ats_note') ? ', ats_note' : ''} FROM outreach_queue WHERE job_id = ? ORDER BY id DESC LIMIT 1`).get(r.jid) as { resume_pdf_path?: string | null; apply_status?: string | null; ats_note?: string | null } | undefined
        : undefined;
      g = {
        job_id: cleanText(String(r.jid), 200), title: cleanText(job?.title ?? '(unknown job)', 200), company: cleanText(job?.company ?? '', 150),
        apply_url: safeUrl(job?.external_apply_url || job?.apply_url), host: cleanText(r.host, 200),
        resume_pdf: queue?.resume_pdf_path ? cleanText(queue.resume_pdf_path, 300) : null,
        ats_note: queue?.ats_note ? cleanText(queue.ats_note, 300) : null,
        apply_status: queue?.apply_status ?? null, questions: [],
      };
      byJob.set(r.jid, g);
    }
    if (g.questions.length >= QUESTIONS_PER_JOB_MAX) continue;
    let options: string[] = [];
    try { const p = JSON.parse(r.options ?? '[]'); if (Array.isArray(p)) options = p.filter((x): x is string => typeof x === 'string').map((x) => cleanText(x, 80)); } catch { /* none */ }
    const kind = (['text', 'select', 'radio', 'checkbox'] as const).includes(r.kind as QuestionKind) ? (r.kind as QuestionKind) : 'text';
    const label = cleanLabel(r.label);
    g.questions.push({
      id: r.id, label, kind, options, maxlength: r.max_length, status: r.status as QuestionStatus,
      answer: r.answer === null ? null : cleanText(r.answer, 2000), owner_comment: r.owner_comment ? cleanText(r.owner_comment, 1000) : null,
      suggested: r.status === 'open' ? suggestedAnswer(label, opts.resume ?? null, now) : null,
      agent_allowed: agentHandleAllowed(label, kind), job_count: counts.get(r.id) ?? 1,
    });
  }
  const groups = [...byJob.values()].filter((g) => opts.status === 'all' || g.questions.some((q) => q.status === 'open'));
  return groups.slice(0, JOBS_MAX);
}

/** Open questions (not counting agent_handle) and the jobs they belong to. */
export function questionCounts(db: Db): { questions: number; jobs: number } {
  if (!hasTable(db, 'apply_questions') || !hasTable(db, 'apply_question_jobs')) return { questions: 0, jobs: 0 };
  const q = db.prepare("SELECT COUNT(*) AS n FROM apply_questions WHERE status = 'open'").get() as { n: number };
  const j = db.prepare("SELECT COUNT(DISTINCT j.job_id) AS n FROM apply_questions q JOIN apply_question_jobs j ON j.question_id = q.id WHERE q.status = 'open'").get() as { n: number };
  return { questions: q.n, jobs: j.n };
}

/** The two ways to respond, as text (Telegram, CLI, /escalations). */
export function respondHint(q: Pick<InboxQuestion, 'id' | 'agent_allowed'>): string[] {
  const out = [`answer: npm run answers -- answer ${q.id} "<text>" [--always] [--comment "..."]  (or the dashboard Inbox tab)`];
  if (q.agent_allowed) out.push(`let the agent write it: npm run answers -- agent ${q.id} [--comment "..."]`);
  return out;
}

/** Plain-text lines for one job group: job, link, every question with kind, options, limit and the ways to respond. */
export function renderJobGroup(g: InboxJobGroup, clean: (s: string, max: number) => string = (s, m) => cleanText(s, m)): string[] {
  const lines = [`Job ${g.job_id}: ${clean(g.title, 90)}${g.company ? ` at ${clean(g.company, 60)}` : ''}${g.apply_url ? ` | ${g.apply_url}` : ''}`];
  for (const q of g.questions) {
    const opts = q.options.length ? ` options: ${q.options.slice(0, 8).map((o) => clean(o, 30)).join(' | ')}` : '';
    const lim = q.maxlength ? ` max ${q.maxlength} chars` : '';
    lines.push(`  #${q.id} [${q.status}] (${q.kind}${q.job_count > 1 ? `, ${q.job_count} jobs` : ''}): "${clean(q.label, 160)}"${opts}${lim}`);
    if (q.suggested) lines.push(`      suggested from your resume: ${clean(q.suggested, 100)}`);
    if (q.owner_comment) lines.push(`      your comment: ${clean(q.owner_comment, 120)}`);
    if (q.status === 'open') for (const h of respondHint(q)) lines.push(`      ${h}`);
    else if (q.status === 'agent_handle') lines.push('      waiting for the agent to draft (answer it yourself any time with: npm run answers -- answer ' + q.id + ' "<text>")');
  }
  return lines;
}
