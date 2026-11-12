// src/outreach/escalations.ts
// The owner's Inbox: open escalations grouped, de-duplicated for display and joined to the person, company and job when known.
// Read functions work on the dashboard's read-only handle (an old database without `snoozed_until` or `inbound_messages` still works).
// The two writes (resolve, snooze) are the only changes the owner can make; nothing here sends anything to a third party.
// Escalation text is untrusted model and third-party text: it is cleaned here (cleanText) and rendered as plain text everywhere.
import BetterSqlite3 from 'better-sqlite3';
import { cleanText } from '../dash/clean.js';
import { migrateSchedulerTables } from '../scheduler/runLog.js';
import { agentHandleAllowed, QUESTION_KINDS, type QuestionKind } from '../apply/questions.js';
import { jobIdOfEscalation, parseApplyDetail } from './applyEscalations.js';
import { buildManualQueue } from '../manual/manualApply.js';
import { validateManualUrl } from '../manual/url.js';
import { severityOf, type Severity } from '../status/severity.js';

type Db = BetterSqlite3.Database;

export type EscGroup = 'human' | 'platform' | 'noise';
export type EscStatus = 'open' | 'snoozed' | 'resolved' | 'all';

export const GROUP_ORDER: EscGroup[] = ['human', 'platform', 'noise'];
export const GROUP_LABELS: Record<EscGroup, string> = {
  human: 'Replies and needs you',
  platform: 'Platform and tool problems',
  noise: 'Flagged (blocked or unscreened)',
};

const MAX_ROWS = 500;
const MAX_IDS = 200;
const REASON_MAX = 300;
const DETAIL_MAX = 600;
const EXCERPT_MAX = 1500;
const RAW_MAX = 1500;
export const NOTE_MAX = 500;

const NOISE_RE = /^\s*\[(blocked|unscreened)\b|injection[_ ]suspect/i;
// Reason words that mean the tool or the page broke (checked before the human words, so "reply form drift" stays a tool problem).
const PROBLEM_RE = /drift|limit|quota|dialog|menu|refs?\b|unclickable|unreadable|unreachable|mismatch|halt|cannot|not found|failed|streak|missing|not_actionable|no_button|exhausted|in_progress|refused/i;
const HUMAN_RE = /reply[_ ]needed|inquiry|recruiter|referral|salary|compensation|interview|slot|inbound|question|asks?\b|wants to|needs[_ ]owner|documents|personal[_ ]data|references|link[_ ]or[_ ]phone/i;
const THREAD_URL_RE = /^[A-Za-z0-9_=-]{1,120}$/;

export interface Classified { group: EscGroup; flag: string | null }

/** Priority for the owner: real people and apply rows first, platform and tool problems second, blocked or injection-suspect noise last. */
export function classifyEscalation(platform: string | null, reason: string, detail: string | null): Classified {
  const r = String(reason ?? '');
  const blocked = /^\s*\[blocked:\s*([^\]]*)\]/i.exec(r);
  const inputFlags = /\[input flags:\s*([^\]]*)\]/i.exec(r)?.[1]?.trim();
  const flag = blocked
    ? `blocked: ${blocked[1].trim()}`
    : /^\s*\[unscreened\]/i.test(r)
      ? 'unscreened'
      : inputFlags ? `input flags: ${inputFlags}` : null;
  if (NOISE_RE.test(r)) return { group: 'noise', flag: flag ?? 'injection suspected' };
  if (PROBLEM_RE.test(r)) return { group: 'platform', flag };
  if (platform === 'apply' || HUMAN_RE.test(r) || HUMAN_RE.test(String(detail ?? ''))) return { group: 'human', flag };
  return { group: 'platform', flag };
}

/** The LinkedIn messaging thread for a stored thread_ref. Other platforms: no URL is known, so none is invented. */
export function linkedinThreadUrl(platform: string | null, threadRef: string | null): string | null {
  if (platform !== 'linkedin' || !threadRef || !THREAD_URL_RE.test(threadRef)) return null;
  // LinkedIn thread ids are "2-" plus url-safe base64 WITH '=' padding; the stored ref has no '=' (the ref charset excludes it),
  // and an unpadded id shows "this conversation failed to load".
  const dash = threadRef.indexOf('-');
  const tail = dash >= 0 ? threadRef.slice(dash + 1) : '';
  const padded = tail !== '' && tail.length % 4 !== 0 ? `${threadRef}${'='.repeat(4 - (tail.length % 4))}` : threadRef;
  return `https://www.linkedin.com/messaging/thread/${padded}/`;
}

export const ASK_KINDS = ['recruiter_inquiry', 'interview_slot', 'salary', 'question', 'reply', 'other'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

const SALARY_RE = /salary|ctc|compensation|expected pay|\bpay\b|\$\s?\d+\s*(\/|per)\s*(hr|hour)|per hour|hourly rate/i;
const SLOT_RE = /interview|schedul|time slot|\bslot\b|availab|calendar|\bcall\b/i;
const INQUIRY_RE = /recruiter|opportunit|\brole\b|hiring|position|open to|inquiry|job/i;

/** The closed ask enum, derived in code (never by the model): reason words first, then the stored inbound class, then keywords in the text. */
export function deriveAskKind(i: { klass?: string | null; reason: string; detail?: string | null; excerpt?: string | null }): AskKind {
  const reason = String(i.reason ?? '');
  if (SALARY_RE.test(reason)) return 'salary';
  if (/interview[_ ]?(time|slot)|\bslot\b|schedul/i.test(reason)) return 'interview_slot';
  if (i.klass === 'interview') return 'interview_slot';
  if (i.klass === 'recruiter_inquiry') return 'recruiter_inquiry';
  if (i.klass === 'reply') return 'reply';
  if (PROBLEM_RE.test(reason)) return 'other';
  if (/inquiry/i.test(`${reason} ${i.detail ?? ''}`)) return 'recruiter_inquiry';
  if (/reply[_ ]needed/i.test(reason)) return 'reply';
  const text = `${reason}\n${i.detail ?? ''}\n${i.excerpt ?? ''}`;
  if (SALARY_RE.test(text)) return 'salary';
  if (SLOT_RE.test(text)) return 'interview_slot';
  if (INQUIRY_RE.test(text)) return 'recruiter_inquiry';
  if (/\?|question/i.test(text)) return 'question';
  return 'other';
}

const ASK_LABELS: Record<AskKind, string> = {
  recruiter_inquiry: 'Recruiter inquiry', interview_slot: 'Interview slot', salary: 'Asks for salary', question: 'Has a question', reply: 'Wants a reply', other: 'Needs a look',
};

/** The short plain-words reason the dashboard and Telegram show instead of the raw code. */
export function reasonLabel(group: EscGroup, askKind: AskKind): string {
  if (group === 'noise') return 'Flagged by the injection screen';
  if (group === 'platform') return 'Platform problem';
  return ASK_LABELS[askKind];
}

/** Who acts on a reply card: nobody (information or thanks), the agent (a reply is drafted or sent by code) or the owner. */
export type TodoKind = 'info' | 'agent' | 'owner';
/** The state of the agent's own reply for a conversation (reply_drafts, read-only here). */
export interface ReplyDraftState { status: string; attachResume: boolean }
export interface TodoContext { excerpt?: string | null; detail?: string | null; draft?: ReplyDraftState | null }

// What the agent never answers: pay, interview times, personal data (phone, address, ids ...) and links. These stay with the owner.
const PERSONAL_RE = /\b(phone|mobile|whatsapp|contact number|address|date of birth|dob|passport|aadhaar|aadhar|pan card|ssn|national id|personal (data|details|information))\b/i;
const LINK_RE = /\b(links?|urls?|portfolio|github|website|linkedin profile|profile link)\b/i;
const DOCS_RE = /\b(resume|resumé|cv|curriculum vitae)\b/i;
// Words of a message that asks for something. A message without a question mark or any of these is information or thanks.
const REQUEST_RE = /\?|\b(please|can you|could you|would you|will you|send|share|let me know|tell me|kindly|interested|available|availability|when|what|how|do you|are you)\b/i;

/** The owner-only topic named by the closed reason code the operator stored (salary, interview_time, personal_data, link_or_phone, references), or null. */
export function reasonTopic(reason: string): 'salary' | 'interview time' | 'personal data' | 'links' | null {
  const r = String(reason ?? '');
  if (/salary|compensation/i.test(r)) return 'salary';
  if (/interview[_ ]?(time|slot)/i.test(r)) return 'interview time';
  if (/personal[_ ]data|references/i.test(r)) return 'personal data';
  if (/link[_ ]or[_ ]phone/i.test(r)) return 'links';
  return null;
}

/** The owner-only topic of a message, or null. Salary and interview ask kinds come from deriveAskKind; the rest is read from the message text. */
export function ownerOnlyTopic(askKind: AskKind, text: string): 'salary' | 'interview time' | 'personal data' | 'links' | null {
  if (askKind === 'salary' || SALARY_RE.test(text)) return 'salary';
  if (askKind === 'interview_slot') return 'interview time';
  if (PERSONAL_RE.test(text)) return 'personal data';
  if (LINK_RE.test(text) && REQUEST_RE.test(text)) return 'links';
  return null;
}

function draftTodo(d: ReplyDraftState, P: string): { text: string; kind: TodoKind } {
  const withCv = d.attachResume ? ' with your resume' : '';
  switch (d.status) {
    case 'sent': return { text: `Sent: the agent replied${withCv}. No action needed.`, kind: 'agent' };
    case 'approved': return { text: `The agent will send a reply${withCv}.`, kind: 'agent' };
    case 'drafted': return { text: `The agent drafted a reply${withCv} and will send it soon.`, kind: 'agent' };
    case 'failed': return { text: `The agent's reply could not be sent. Open the conversation on ${P} and answer yourself.`, kind: 'owner' };
    default: return { text: `The agent decided not to reply. Open the conversation on ${P} and answer yourself if you want to.`, kind: 'owner' };
  }
}

/** The plain line on what the owner should do (or that nothing is needed) and who acts. Closed text built in code; message text only selects the line. */
export function todoFor(group: EscGroup, askKind: AskKind, platform: string | null, reason: string, ctx: TodoContext = {}): { text: string; kind: TodoKind } {
  const r = String(reason ?? '');
  if (group === 'noise') return { text: 'The text looked like it was aimed at an AI, so it is hidden by default. Open the thread yourself if it matters.', kind: 'owner' };
  if (group === 'human') {
    if (platform === 'apply') return { text: 'An application needs you (captcha, login or a question). Finish it by hand or ignore it.', kind: 'owner' };
    const P = platform ? platform[0].toUpperCase() + platform.slice(1) : 'the platform';
    const text = `${ctx.excerpt ?? ''}\n${ctx.detail ?? ''}`;
    const topic = reasonTopic(r) ?? ownerOnlyTopic(askKind, text);
    if (topic) return { text: `Open the conversation on ${P} and answer yourself: it asks about ${topic}.`, kind: 'owner' };
    if (ctx.draft) return draftTodo(ctx.draft, P);
    if (/documents/i.test(r) || (DOCS_RE.test(text) && REQUEST_RE.test(text))) return { text: 'The agent will send a reply with your resume.', kind: 'agent' };
    if (ctx.excerpt && (askKind === 'reply' || askKind === 'other') && !REQUEST_RE.test(ctx.excerpt)) {
      return { text: 'No action needed unless you want to answer yourself. The agent has read it.', kind: 'info' };
    }
    return { text: `Open the conversation on ${P} and answer yourself if you want to. The agent has not drafted a reply.`, kind: 'owner' };
  }
  if (/note[_ ]?(limit|quota)|quota[_ ]exhausted/i.test(r)) return { text: 'LinkedIn note quota used: invites now go without a note; nothing to do.', kind: 'info' };
  if (/layout/i.test(r)) return { text: 'The page layout changed and the agent skipped that step. Nothing to do unless it keeps coming back.', kind: 'info' };
  if (/mismatch|employer/i.test(r)) return { text: 'The person did not match the record, so they were skipped. Nothing to do.', kind: 'info' };
  if (/dialog|menu|refs?\b|unclickable|unreadable|not_actionable|no_button|click/i.test(r)) return { text: 'LinkedIn showed a screen the agent could not use. Nothing was sent; nothing to do.', kind: 'info' };
  return { text: 'A tool had a problem and skipped the step. Usually nothing to do; run /health if it keeps coming back.', kind: 'info' };
}

/** The same line as a plain string (Telegram, /escalations, the digest). */
export function whatToDo(group: EscGroup, askKind: AskKind, platform: string | null, reason: string, ctx: TodoContext = {}): string {
  return todoFor(group, askKind, platform, reason, ctx).text;
}

export interface EscItem {
  /** Newest row id of the group (what the owner quotes). */
  id: number;
  /** Every row id the display merged; actions apply to all of them. */
  ids: number[];
  count: number;
  platform: string | null;
  reason: string;
  detail: string | null;
  group: EscGroup;
  flag: string | null;
  created_at: string;
  first_at: string;
  threadRef: string | null;
  threadUrl: string | null;
  personId: number | null;
  personName: string | null;
  personCompany: string | null;
  jobTitle: string | null;
  resolved_at: string | null;
  snoozed_until: string | null;
  /** Sender as shown in the thread (stored), else the person record. */
  senderName: string | null;
  senderHeadline: string | null;
  /** Latest inbound message text. Untrusted; cleaned and capped, plain text only. Null on old rows. */
  excerpt: string | null;
  messageAt: string | null;
  askKind: AskKind;
  /** Plain-words reason and what-to-do line, built in code. */
  label: string;
  todo: string;
  /** Who acts on the card: nobody (info), the agent (a reply is drafted or sent by code) or the owner. */
  todoKind: TodoKind;
  /** The agent's own reply for this conversation (reply_drafts, read-only), when one exists. */
  replyDraft: ReplyDraftState | null;
  /** apply:* cards: the job the card is about (title, company, host, safe https link, question labels). Null for every other card. */
  applyJob: ApplyJobView | null;
  /** Total times the conversation was reported (sum over merged rows). */
  updates: number;
  /** Newest activity (last update or creation). */
  last_at: string;
  /** Text the input screen blocked, for the collapsed owner-only toggle. Never returned by an MCP tool. */
  rawText: string | null;
  /** The owner's note when the item was marked handled from the dashboard. Plain text. */
  resolvedNote: string | null;
  /** The job the person was last contacted about (for the panel link), when known. */
  jobId: string | null;
  /** apply:needs_answer cards: the open questions of that host, with the exact command to answer each. Empty for every other card. */
  questions: OpenQuestionView[];
  /** apply:needs_human cards: the exact command that opens the job's page for the owner, else null. */
  assistCommand: string | null;
  /** How much it matters (src/status/severity.ts, the one model) and a one-line why and what to do. */
  severity: Severity;
  hint: string;
}

/** The job an apply:* card is about. Every field but `host` can be null for an old row that stored no job (then only the host is shown). */
export interface ApplyJobView {
  jobId: string | null; title: string | null; company: string | null; host: string | null;
  /** An https link to the job or apply page, validated like the manual apply open_url; else null. */
  url: string | null;
  /** Labels of the questions this job waits on (apply:question cards). */
  questions: string[];
}

/** One open apply_questions row as the dashboard and Telegram show it. All text is cleaned. */
export interface OpenQuestionView {
  id: number; label: string; kind: string; options: string[]; host: string; jobIds: string[];
  answerCommand: string;
  /** Command that leaves the question to the agent; null when the question is factual (never allowed). */
  agentCommand: string | null;
  maxLength: number | null;
  /** The first job that met the question (title at company, https apply link), when known. */
  jobTitle: string | null; applyUrl: string | null;
}

export interface EscCounts { open: number; snoozed: number; resolved: number }

const QUESTION_ROWS_MAX = 25;

/** Open questions (all hosts when `host` is empty) with the command that answers each. Read-only; works on the dashboard's handle. */
export function openQuestionViews(db: Db, host?: string): OpenQuestionView[] {
  if (!hasTable(db, 'apply_questions')) return [];
  const rows = (host
    ? db.prepare("SELECT id, host, label, kind, options, max_length FROM apply_questions WHERE status = 'open' AND host = ? ORDER BY id LIMIT ?").all(host.toLowerCase(), QUESTION_ROWS_MAX)
    : db.prepare("SELECT id, host, label, kind, options, max_length FROM apply_questions WHERE status = 'open' ORDER BY id LIMIT ?").all(QUESTION_ROWS_MAX)) as
    { id: number; host: string; label: string; kind: string; options: string | null; max_length: number | null }[];
  return rows.map((r) => {
    let options: string[] = [];
    try { const p = JSON.parse(r.options ?? '[]'); if (Array.isArray(p)) options = p.filter((x): x is string => typeof x === 'string').map((x) => cleanText(x, 80)); } catch { /* none */ }
    const jobIds = hasTable(db, 'apply_question_jobs')
      ? (db.prepare('SELECT job_id FROM apply_question_jobs WHERE question_id = ? ORDER BY rowid LIMIT 20').all(r.id) as { job_id: string }[]).map((x) => cleanText(x.job_id, 200))
      : [];
    let jobTitle: string | null = null;
    let applyUrl: string | null = null;
    if (jobIds[0] && hasTable(db, 'jobs')) {
      const j = db.prepare('SELECT title, company, apply_url FROM jobs WHERE id = ?').get(jobIds[0]) as { title: string | null; company: string | null; apply_url: string | null } | undefined;
      if (j) {
        jobTitle = `${cleanText(j.title ?? '', 120)}${j.company ? ` at ${cleanText(j.company, 80)}` : ''}`.trim() || null;
        const u = cleanText(j.apply_url ?? '', 500);
        applyUrl = /^https:\/\/\S+$/i.test(u) ? u : null;
      }
    }
    const label = cleanText(r.label, 300);
    const kind: QuestionKind = (QUESTION_KINDS as readonly string[]).includes(r.kind) ? (r.kind as QuestionKind) : 'text';
    return {
      id: r.id, label, kind: r.kind, options, host: cleanText(r.host, 200), jobIds,
      answerCommand: `npm run answers -- answer ${r.id} "<your answer>" [--always] [--comment "..."]`,
      agentCommand: agentHandleAllowed(label, kind) ? `npm run answers -- agent ${r.id} [--comment "..."]` : null,
      maxLength: r.max_length, jobTitle, applyUrl,
    };
  });
}

interface Raw {
  id: number; platform: string | null; person_id: number | null; thread_ref: string | null; reason: string; detail: string | null;
  created_at: string; resolved_at: string | null; snoozed_until: string | null;
  pid: number | null; pname: string | null; pcompany: string | null; pheadline: string | null; job_title: string | null; job_company: string | null;
  sender_name: string | null; sender_headline: string | null; message_excerpt: string | null; message_at: string | null; ask_kind: string | null;
  seen_count: number | null; updated_at: string | null; raw_text: string | null; klass: string | null; resolved_note: string | null;
  job_id: string | number | null;
}

const NEW_COLS = ['sender_name', 'sender_headline', 'message_excerpt', 'message_at', 'ask_kind', 'seen_count', 'updated_at', 'raw_text', 'resolved_note'] as const;

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function hasSnooze(db: Db): boolean {
  return (db.prepare('PRAGMA table_info(escalations)').all() as { name: string }[]).some((c) => c.name === 'snoozed_until');
}

function statusWhere(status: EscStatus, snz: string): string {
  if (status === 'open') return `e.resolved_at IS NULL AND (${snz} IS NULL OR ${snz} <= @now)`;
  if (status === 'snoozed') return `e.resolved_at IS NULL AND ${snz} IS NOT NULL AND ${snz} > @now`;
  if (status === 'resolved') return 'e.resolved_at IS NOT NULL';
  return '1 = 1';
}

export function countEscalations(db: Db, now: Date): EscCounts {
  if (!hasTable(db, 'escalations')) return { open: 0, snoozed: 0, resolved: 0 };
  const snz = hasSnooze(db) ? 'e.snoozed_until' : 'NULL';
  const n = (s: EscStatus): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM escalations e WHERE ${statusWhere(s, snz)}`).get({ now: now.toISOString() }) as { c: number }).c;
  return { open: n('open'), snoozed: n('snoozed'), resolved: n('resolved') };
}

export function listEscalations(
  db: Db,
  opts: { now: Date; status?: EscStatus; platform?: string; group?: EscGroup; limit?: number; dedupeApply?: { env: NodeJS.ProcessEnv } },
): { items: EscItem[]; counts: EscCounts; hiddenDuplicates: number } {
  const counts = countEscalations(db, opts.now);
  if (!hasTable(db, 'escalations')) return { items: [], counts, hiddenDuplicates: 0 };
  const status = opts.status ?? 'open';
  const snz = hasSnooze(db) ? 'e.snoozed_until' : 'NULL';
  const inbound = hasTable(db, 'inbound_messages')
    ? '(SELECT im.person_id FROM inbound_messages im WHERE im.platform = e.platform AND im.thread_ref = e.thread_ref AND im.person_id IS NOT NULL ORDER BY im.id DESC LIMIT 1)'
    : 'NULL';
  const people = hasTable(db, 'people');
  const touchJob = people && hasTable(db, 'touches') && hasTable(db, 'jobs');
  const pidExpr = `COALESCE(e.person_id, ${inbound})`;
  const where = [statusWhere(status, snz)];
  const params: Record<string, unknown> = { now: opts.now.toISOString(), lim: MAX_ROWS };
  if (opts.platform) {
    where.push('e.platform = @platform');
    params.platform = opts.platform;
  }
  const have = new Set((db.prepare('PRAGMA table_info(escalations)').all() as { name: string }[]).map((c) => c.name));
  const nc = NEW_COLS.map((c) => `${have.has(c) ? `e.${c}` : 'NULL'} AS ${c}`).join(', ');
  const klass = hasTable(db, 'inbound_messages')
    ? '(SELECT im.klass FROM inbound_messages im WHERE im.platform = e.platform AND im.thread_ref = e.thread_ref ORDER BY im.id DESC LIMIT 1)'
    : 'NULL';
  const sql = `SELECT e.id, e.platform, e.person_id, e.thread_ref, e.reason, e.detail, e.created_at, e.resolved_at, ${snz} AS snoozed_until, ${nc},
      ${klass} AS klass,
      ${people ? `(SELECT p.headline FROM people p WHERE p.id = ${pidExpr})` : 'NULL'} AS pheadline,
      ${pidExpr} AS pid,
      ${people ? `(SELECT p.name FROM people p WHERE p.id = ${pidExpr})` : 'NULL'} AS pname,
      ${people ? `(SELECT p.company FROM people p WHERE p.id = ${pidExpr})` : 'NULL'} AS pcompany,
      ${touchJob ? `(SELECT j.title FROM touches t JOIN jobs j ON j.id = t.job_id WHERE t.person_id = ${pidExpr} ORDER BY t.id DESC LIMIT 1)` : 'NULL'} AS job_title,
      ${touchJob ? `(SELECT j.id FROM touches t JOIN jobs j ON j.id = t.job_id WHERE t.person_id = ${pidExpr} ORDER BY t.id DESC LIMIT 1)` : 'NULL'} AS job_id,
      ${touchJob ? `(SELECT j.company FROM touches t JOIN jobs j ON j.id = t.job_id WHERE t.person_id = ${pidExpr} ORDER BY t.id DESC LIMIT 1)` : 'NULL'} AS job_company
    FROM escalations e WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT @lim`;
  const rows = db.prepare(sql).all(params) as Raw[];

  const merged = new Map<string, EscItem>();
  for (const r of rows) {
    const reason = cleanText(r.reason, REASON_MAX);
    const detail = r.detail === null ? null : cleanText(r.detail, DETAIL_MAX);
    // One conversation is one card: rows of the same platform and thread merge whatever their wording. Rows without a thread merge when identical.
    const key = r.thread_ref ? [r.platform, r.thread_ref].join('\u0001') : [r.platform, reason, r.pid, detail].join('\u0001');
    const seen = Math.max(1, r.seen_count ?? 1);
    const excerpt = r.message_excerpt === null ? null : cleanText(r.message_excerpt, EXCERPT_MAX);
    const sender = r.sender_name ? cleanText(r.sender_name, 200) : r.pname === null ? null : cleanText(r.pname, 200);
    const headline = r.sender_headline ? cleanText(r.sender_headline, 300) : r.pheadline ? cleanText(r.pheadline, 300) : r.pcompany ? cleanText(r.pcompany, 200) : null;
    const raw = r.raw_text ? cleanText(r.raw_text, RAW_MAX) : null;
    const hit = merged.get(key);
    if (hit) {
      // Older rows only fill what the newest row lacks.
      hit.ids.push(r.id);
      hit.count += 1;
      hit.updates += seen;
      if (r.created_at < hit.first_at) hit.first_at = r.created_at;
      hit.excerpt ??= excerpt;
      hit.messageAt ??= r.message_at;
      hit.senderName ??= sender;
      hit.senderHeadline ??= headline;
      hit.rawText ??= raw;
      continue;
    }
    const c = classifyEscalation(r.platform, reason, detail);
    const askKind = (ASK_KINDS as readonly string[]).includes(r.ask_kind ?? '')
      ? (r.ask_kind as AskKind)
      : deriveAskKind({ klass: r.klass, reason, detail, excerpt });
    merged.set(key, {
      senderName: sender, senderHeadline: headline, excerpt, messageAt: r.message_at, askKind,
      label: reasonLabel(c.group, askKind), todo: '', todoKind: 'owner', replyDraft: null, applyJob: null,
      updates: seen, last_at: r.updated_at ?? r.created_at, rawText: raw,
      resolvedNote: r.resolved_note ? cleanText(r.resolved_note, NOTE_MAX) : null, jobId: r.job_id === null || r.job_id === undefined ? null : String(r.job_id),
      id: r.id, ids: [r.id], count: 1, platform: r.platform, reason, detail, group: c.group, flag: c.flag,
      created_at: r.created_at, first_at: r.created_at, threadRef: r.thread_ref, threadUrl: linkedinThreadUrl(r.platform, r.thread_ref),
      personId: r.pid, personName: r.pname === null ? null : cleanText(r.pname, 200), personCompany: r.pcompany === null ? null : cleanText(r.pcompany, 200),
      jobTitle: r.job_title === null ? null : `${cleanText(r.job_title, 200)}${r.job_company ? ` at ${cleanText(r.job_company, 100)}` : ''}`,
      resolved_at: r.resolved_at, snoozed_until: r.snoozed_until, questions: [], assistCommand: null, severity: 'info', hint: '',
    });
  }
  // The agent's own reply for a conversation (reply_drafts, read-only) decides the line of a reply card.
  const draftStmt = hasTable(db, 'reply_drafts') ? db.prepare('SELECT status, attach_resume FROM reply_drafts WHERE escalation_id = ? ORDER BY id DESC LIMIT 1') : null;
  for (const it of merged.values()) {
    if (draftStmt && it.group === 'human' && it.platform !== 'apply') {
      for (const id of it.ids) {
        const d = draftStmt.get(id) as { status: string; attach_resume: number } | undefined;
        if (d) { it.replyDraft = { status: d.status, attachResume: d.attach_resume === 1 }; break; }
      }
    }
    const t = todoFor(it.group, it.askKind, it.platform, it.reason, { excerpt: it.excerpt, detail: it.detail, draft: it.replyDraft });
    it.todo = t.text; it.todoKind = t.kind;
  }
  // Apply cards carry the job they are about (title, company, host, safe link, question labels).
  for (const it of merged.values()) {
    if (it.platform === 'apply') it.applyJob = applyJobView(db, it);
  }
  // Apply cards that wait for a person get plain wording and the exact command (built here from stored rows, never from the model).
  for (const it of merged.values()) {
    if (it.platform !== 'apply') continue;
    if (/^apply:needs_answer/.test(it.reason)) {
      const host = (it.threadRef ?? '').replace(/^answers:/, '');
      it.questions = hasTable(db, 'apply_questions') ? openQuestionViews(db, host) : [];
      it.label = 'Needs your answer';
      it.todo = 'The application is paused. Answer each question in the Inbox tab (or with the command shown), or leave a free-text one to the agent; --always keeps an answer for every later form.';
      it.askKind = 'question';
    } else if (/^apply:needs_human/.test(it.reason)) {
      const m = /npm run apply:assist -- (\S+)/.exec(it.detail ?? '');
      it.assistCommand = m ? `npm run apply:assist -- ${m[1].replace(/[^\w.:@-]/g, '')}` : null;
      it.label = 'Needs you: log in or human check';
      it.todo = 'A login, CAPTCHA or MFA step on this site needs a person. Run the command: it opens the page in Chrome for you, then the job retries.';
    }
  }
  for (const it of merged.values()) {
    const s = severityOf(it);
    it.severity = s.severity; it.hint = s.hint;
  }
  // Display-side dedupe (nothing is deleted): an open apply card whose job is already shown in "Apply by hand" or "Needs your answer" is not a
  // separate card, and the "needs your answer" host cards are that group itself.
  let hidden = 0;
  const covered = opts.dedupeApply ? coveredApplyJobs(db, opts.dedupeApply.env) : null;
  const shown = [...merged.values()].filter((i) => {
    if (!covered || i.platform !== 'apply' || i.resolved_at) return true;
    const drop = /^apply:needs_answer/.test(i.reason) || (i.applyJob?.jobId != null && covered.has(i.applyJob.jobId));
    if (drop) hidden += 1;
    return !drop;
  });
  // Within a group: newest activity first.
  const items = shown
    .filter((i) => !opts.group || i.group === opts.group)
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0) || b.id - a.id);
  return { items: opts.limit ? items.slice(0, opts.limit) : items, counts, hiddenDuplicates: hidden };
}

/** Job ids already shown elsewhere in the Inbox: the Apply by hand list and the jobs that wait for an answer. Empty on an old database. */
export function coveredApplyJobs(db: Db, env: NodeJS.ProcessEnv): Set<string> {
  const out = new Set<string>();
  try { for (const i of buildManualQueue(db, env).items) out.add(i.job_id); } catch { /* an old database: nothing covered by hand */ }
  try {
    if (hasTable(db, 'outreach_queue')) for (const r of db.prepare("SELECT DISTINCT job_id FROM outreach_queue WHERE apply_status = 'needs_answer'").all() as { job_id: string }[]) out.add(String(r.job_id));
    if (hasTable(db, 'apply_questions') && hasTable(db, 'apply_question_jobs')) {
      for (const r of db.prepare("SELECT DISTINCT j.job_id AS job_id FROM apply_questions q JOIN apply_question_jobs j ON j.question_id = q.id WHERE q.status IN ('open', 'agent_handle')").all() as { job_id: string }[]) out.add(String(r.job_id));
    }
  } catch { /* none */ }
  return out;
}

/** Title, company, host, a safe https link and the open question labels of the job an apply card is about. Old rows without a job id match by url, else show the host only. */
function applyJobView(db: Db, it: EscItem): ApplyJobView {
  const p = parseApplyDetail(it.detail, it.threadRef);
  const refHost = /^(?:answers|assist):(.+)$/.exec(it.threadRef ?? '')?.[1] ?? null;
  const view: ApplyJobView = { jobId: null, title: null, company: null, host: cleanHost(p.host ?? refHost), url: null, questions: [] };
  let jobId: string | null = null;
  try { jobId = jobIdOfEscalation(db, it.detail, it.threadRef); } catch { jobId = null; }
  if (!jobId) return view;
  view.jobId = cleanText(jobId, 200);
  try {
    if (hasTable(db, 'jobs')) {
      const hasExt = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).some((c) => c.name === 'external_apply_url');
      const j = db.prepare(`SELECT title, company, apply_url, url${hasExt ? ', external_apply_url' : ''} FROM jobs WHERE id = ?`).get(jobId) as
        { title: string | null; company: string | null; apply_url: string | null; url: string | null; external_apply_url?: string | null } | undefined;
      if (j) {
        view.title = j.title ? cleanText(j.title, 160) : null;
        view.company = j.company ? cleanText(j.company, 100) : null;
        for (const cand of [j.external_apply_url, j.apply_url, j.url]) {
          const v = validateManualUrl(String(cand ?? '').trim());
          if (v.ok) { view.url = v.url; if (!view.host) view.host = cleanHost(new URL(v.url).hostname); break; }
        }
      }
    }
    if (/^apply:(question|needs_answer)/.test(it.reason) && hasTable(db, 'apply_questions') && hasTable(db, 'apply_question_jobs')) {
      view.questions = (db.prepare("SELECT q.label AS label FROM apply_questions q JOIN apply_question_jobs j ON j.question_id = q.id WHERE j.job_id = ? AND q.status IN ('open', 'agent_handle') ORDER BY q.id LIMIT 10").all(jobId) as { label: string }[])
        .map((r) => cleanText(r.label, 200));
    }
  } catch { /* the job fields stay empty */ }
  return view;
}

function cleanHost(h: string | null): string | null {
  const t = cleanText(h ?? '', 120).toLowerCase().replace(/^www\./, '');
  return t && t !== 'unknown' ? t : null;
}

function cleanIds(ids: number[]): number[] {
  return [...new Set(ids)].filter((i) => Number.isInteger(i) && i > 0).slice(0, MAX_IDS);
}

function hasColumn(db: Db, name: string): boolean {
  return (db.prepare('PRAGMA table_info(escalations)').all() as { name: string }[]).some((c) => c.name === name);
}

/**
 * Marks open escalations handled. Returns how many rows changed (an already resolved row is left alone). The optional owner note is stored
 * as plain text next to the row (cleaned and capped); a database without the column ignores it.
 */
export function resolveEscalations(db: Db, ids: number[], now: Date, note?: string | null): number {
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const clean = note ? cleanText(note, NOTE_MAX) || null : null;
  if (clean !== null && hasColumn(db, 'resolved_note')) {
    const withNote = db.prepare('UPDATE escalations SET resolved_at = ?, resolved_note = ? WHERE id = ? AND resolved_at IS NULL');
    return db.transaction(() => list.reduce((n, id) => n + withNote.run(now.toISOString(), clean, id).changes, 0))();
  }
  const stmt = db.prepare('UPDATE escalations SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(now.toISOString(), id).changes, 0))();
}

/** Puts handled escalations back in the open list (clears the handled time, the note and any snooze). Open rows are left alone. */
export function reopenEscalations(db: Db, ids: number[]): number {
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const sets = ['resolved_at = NULL', ...(hasColumn(db, 'resolved_note') ? ['resolved_note = NULL'] : []), ...(hasSnooze(db) ? ['snoozed_until = NULL'] : [])];
  const stmt = db.prepare(`UPDATE escalations SET ${sets.join(', ')} WHERE id = ? AND resolved_at IS NOT NULL`);
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(id).changes, 0))();
}

/** How many cards the open list shows (rows of one conversation merge into one card); this is what the sidebar badge counts. */
export function countOpenCards(db: Db, now: Date, env?: NodeJS.ProcessEnv): number {
  // With `env` the badge counts each job once: apply cards of a job shown in "Apply by hand" or "Needs your answer" are not cards.
  return listEscalations(db, { now, status: 'open', ...(env ? { dedupeApply: { env } } : {}) }).items.length;
}

/** Hides open escalations until `until`. A resolved row is never snoozed. */
export function snoozeEscalations(db: Db, ids: number[], until: Date, now: Date): number {
  const list = cleanIds(ids);
  if (!list.length || until.getTime() <= now.getTime()) return 0;
  const stmt = db.prepare('UPDATE escalations SET snoozed_until = ? WHERE id = ? AND resolved_at IS NULL');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(until.toISOString(), id).changes, 0))();
}

/** The dashboard's narrow write: one short-lived connection (its own handle is read-only), migrated so `snoozed_until` exists. */
export function withEscalationWriter<T>(path: string, fn: (db: Db) => T): T {
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    migrateSchedulerTables(db);
    return fn(db);
  } finally {
    db.close();
  }
}
