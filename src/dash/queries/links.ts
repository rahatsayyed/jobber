// src/dash/queries/links.ts
// Read-only cross links between jobs, sent mail and people for the dashboard detail panels. Every list is bounded (MAX_LINKS).
// Join keys (real columns, see src/db.ts and src/outreach/schema.ts):
//   job -> mail:        outreach_queue.job_id = jobs.id (cold email; sent when email_sent_at is set), followups.job_id = jobs.id
//   mail -> job:        the same job_id; an orphan (no jobs row) keeps the bare job_id
//   mail -> contact:    contacts.email = outreach_queue.email_to (case-insensitive)
//   job -> contact:     contacts.company = jobs.company (case-insensitive, trimmed), plus the queue row addresses of the job
//   job -> LinkedIn:    touches.job_id (person via touches.person_id), connections.job_id, outreach_queue.connect_profile_url and
//                       jobs.poster_url; a profile URL maps to people.profile_key through normalizeProfileKey (exact key, not a substring)
//   person -> job:      the same four paths backwards
// Message bodies are never returned here (only the mail panel's own detail query does, redacted by cleanRow).
import type BetterSqlite3 from 'better-sqlite3';
import { tableExists } from '../readDb.js';
import { cleanRow, cleanText } from '../clean.js';
import { normalizeProfileKey } from '../../outreach/people.js';

type Db = BetterSqlite3.Database;
type Row = Record<string, unknown>;

export const MAX_LINKS = 50;

export interface JobBrief { id: string; title: string; company: string; status: string | null; score: number | null; excluded_reason: string | null }
export interface PersonLink {
  /** `<people.id>` for a LinkedIn/Naukri person, `c<contacts.id>` for an email contact, null when there is no row to open. */
  ref: string | null; name: string | null; role: string | null; channel: string; email: string | null;
  status: string | null; verified: boolean | null; note: string | null;
}
export interface MailLink {
  /** `<outreach_queue.id>` for the cold email (only once sent), `f<followups.id>` for a follow-up, the Gmail message id for an inbound reply. */
  ref: string | null; kind: 'cold' | 'followup' | 'feedback' | 'reply'; n: number | null; job_id: string; label: string; status: string | null;
  /** Recipient of an outbound mail. For an inbound reply this is null and `from` holds the sender. */
  to: string | null; from: string | null; subject: string | null;
  /** Outbound: when it was sent. Inbound: when the reply was received. */
  sent_at: string | null; created_at: string | null; current?: boolean;
}
export interface EscalationLink { id: number; reason: string; platform: string | null; created_at: string | null; resolved: boolean; person_ref: string | null }
/** One entry in a person's conversation. `open` is the panel the row opens (null: nothing to open); `inbox_id` links an inbox item. */
export interface TimelineItem {
  at: string | null; type: 'touch' | 'connection' | 'inbound' | 'escalation' | 'email' | 'followup' | 'reply';
  direction: 'out' | 'in'; title: string; status: string | null; preview: string | null;
  job: { id: string; title: string; company: string } | null;
  open: { kind: 'job' | 'mail' | 'person' | 'reply'; id: string } | null; inbox_id: number | null;
}
export interface OtherTouch { kind: string; status: string; at: string | null; platform: string; person_ref: string | null; person_name: string | null }

export interface JobLinks { people: PersonLink[]; mails: MailLink[]; other: OtherTouch[]; escalations: EscalationLink[] }
export interface MailLinks { job: JobBrief | null; job_id: string | null; contact: PersonLink | null; timeline: MailLink[]; parent: MailLink | null }
export interface PersonLinks { jobs: (JobBrief & { via: string[] })[]; mails: MailLink[] }

const L = { short: 64, name: 200, text: 500, long: 1000 };

const clean = (s: unknown, n: number): string | null => (typeof s === 'string' && s !== '' ? cleanText(s, n) : null);
const all = (db: Db, sql: string, ...params: unknown[]): Row[] => db.prepare(sql).all(...params) as Row[];
const lc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

// ---------------------------------------------------------------- pure helpers (tested directly)

/** Label of a mail in a timeline: the cold email, follow-up 1..3, or the feedback request (the 4th message of the sequence). */
export function mailStageLabel(kind: MailLink['kind'], n: number | null): string {
  if (kind === 'cold') return 'Cold email';
  if (kind === 'feedback') return 'Feedback request';
  return `Follow-up ${n ?? '?'}`;
}
/** Milliseconds for a stored time: SQLite `YYYY-MM-DD HH:MM:SS` is UTC, ISO and RFC 2822 parse as they are. Unparseable or empty gives 0. */
export function tsOf(s: string | null | undefined): number {
  if (!s) return 0;
  const t = /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
}
const mailTime = (m: MailLink): number => tsOf(m.sent_at ?? m.created_at);
/** Only ids that are safe in a URL query and a panel ref can be opened. */
const REPLY_REF_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const replyRef = (id: unknown): string | null => (typeof id === 'string' && REPLY_REF_RE.test(id) ? id : null);

/**
 * The message a mail answers or follows: a cold email has none; follow-up n follows follow-up n-1 (the cold email for the first one);
 * an inbound reply answers the newest sent mail that is not later than the reply (else the cold email). Pure.
 */
export function threadParent(list: readonly MailLink[], target: MailLink): MailLink | null {
  if (target.kind === 'cold') return null;
  const cold = list.find((m) => m.kind === 'cold' && m.ref !== null) ?? null;
  if (target.kind === 'reply') {
    const t = mailTime(target);
    const sent = list.filter((m) => m.kind !== 'reply' && m.sent_at !== null && mailTime(m) <= t && m.ref !== target.ref);
    sent.sort((a, b) => mailTime(a) - mailTime(b));
    return sent[sent.length - 1] ?? cold;
  }
  const n = target.n ?? 0;
  const prev = list.filter((m) => (m.kind === 'followup' || m.kind === 'feedback') && (m.n ?? 0) < n).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  return prev[prev.length - 1] ?? cold;
}

export const followupKind =(n: number): 'followup' | 'feedback' => (n >= 4 ? 'feedback' : 'followup');

/** `12` -> person 12, `c4` -> contact 4, anything else null. */
export function parsePersonRef(raw: string): { kind: 'person' | 'contact'; id: number } | null {
  const m = /^(c?)(\d{1,12})$/.exec(raw);
  if (!m) return null;
  const id = Number(m[2]);
  return id > 0 ? { kind: m[1] ? 'contact' : 'person', id } : null;
}
/** `12` -> cold email (queue id) 12, `f5` -> follow-up 5. */
export function parseMailRef(raw: string): { kind: 'cold' | 'followup'; id: number } | null {
  const m = /^(f?)(\d{1,12})$/.exec(raw);
  if (!m) return null;
  const id = Number(m[2]);
  return id > 0 ? { kind: m[1] ? 'followup' : 'cold', id } : null;
}

function keyOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try { const k = normalizeProfileKey(url); return k || null; } catch { return null; }
}

// ---------------------------------------------------------------- briefs

function jobBrief(r: Row): JobBrief {
  const c = cleanRow({ id: r.id, title: r.title ?? '', company: r.company ?? '', status: r.status ?? null, excluded_reason: r.excluded_reason ?? null },
    { id: 200, title: 300, company: 200, status: 64, excluded_reason: 500 }) as Row;
  return { id: String(c.id), title: String(c.title), company: String(c.company), status: (c.status as string | null) ?? null,
    score: typeof r.score === 'number' ? r.score : null, excluded_reason: (c.excluded_reason as string | null) ?? null };
}

export function briefForJob(db: Db, jobId: string): JobBrief | null {
  if (!tableExists(db, 'jobs')) return null;
  const r = all(db, 'SELECT id, title, company, status, score, excluded_reason FROM jobs WHERE id = ?', jobId)[0];
  return r ? jobBrief(r) : null;
}

function personLinkFromPerson(r: Row, extra: { status?: string | null; note?: string | null }): PersonLink {
  return {
    ref: String(r.id), name: clean(r.name, L.name), role: clean(r.headline, 300) ?? clean(r.category, L.short),
    channel: clean(r.platform, 32) ?? 'linkedin', email: null, status: extra.status ?? null, verified: null, note: extra.note ?? null,
  };
}
function personLinkFromContact(r: Row, status: string | null): PersonLink {
  return {
    ref: `c${r.id}`, name: null, role: clean(r.type, L.short), channel: 'email', email: clean(r.email, 320),
    status, verified: r.verified === null || r.verified === undefined ? null : Number(r.verified) === 1, note: clean(r.company, L.name),
  };
}

// ---------------------------------------------------------------- mails

function mailLinksForJob(db: Db, jobId: string, limit: number): MailLink[] {
  const out: MailLink[] = [];
  if (tableExists(db, 'outreach_queue')) {
    for (const q of all(db, `SELECT id, email_to, email_subject, email_status, email_sent_at, status, created_at FROM outreach_queue
        WHERE job_id = ? AND (email_to IS NOT NULL OR email_subject IS NOT NULL) ORDER BY id DESC LIMIT ?`, jobId, limit)) {
      const sent = q.email_sent_at !== null && q.email_sent_at !== undefined;
      out.push({
        ref: sent ? String(q.id) : null, kind: 'cold', n: null, job_id: jobId, label: mailStageLabel('cold', null),
        status: clean(q.email_status, 32) ?? clean(q.status, 32), to: clean(q.email_to, 320), from: null, subject: clean(q.email_subject, L.text),
        sent_at: clean(q.email_sent_at, L.short), created_at: clean(q.created_at, L.short),
      });
    }
  }
  if (tableExists(db, 'followups')) {
    const to = out.find((m) => m.to)?.to ?? null;
    for (const f of all(db, 'SELECT id, n, status, subject, created_at, sent_at FROM followups WHERE job_id = ? ORDER BY n, id LIMIT ?', jobId, limit)) {
      const n = Number(f.n);
      const kind = followupKind(n);
      out.push({
        ref: `f${f.id}`, kind, n, job_id: jobId, label: mailStageLabel(kind, n), status: clean(f.status, 32), to, from: null, subject: clean(f.subject, L.text),
        sent_at: clean(f.sent_at, L.short), created_at: clean(f.created_at, L.short),
      });
    }
  }
  return out.slice(0, limit);
}

export function replyLabel(classification: string | null): string {
  if (classification === 'bounce') return 'Bounce';
  if (classification === 'auto_ack') return 'Automatic reply';
  if (classification === 'noise') return 'Other mail';
  return 'Reply';
}

/** Inbound mail of a job (processed_messages.job_id), newest first, as thread entries. Reply bodies are not stored, so none is returned. */
function replyLinksForJob(db: Db, jobId: string, limit: number): MailLink[] {
  if (!tableExists(db, 'processed_messages')) return [];
  return all(db, `SELECT message_id, classification, from_addr, subject, reply_date, processed_at FROM processed_messages
      WHERE job_id = ? ORDER BY rowid DESC LIMIT ?`, jobId, limit).map((m): MailLink => ({
    ref: replyRef(m.message_id), kind: 'reply', n: null, job_id: jobId, label: replyLabel(clean(m.classification, 32)),
    status: clean(m.classification, 32), to: null, from: clean(m.from_addr, 320), subject: clean(m.subject, L.text),
    sent_at: clean(m.reply_date ?? m.processed_at, L.short), created_at: clean(m.processed_at, L.short),
  }));
}

/** The whole mail thread of one job in time order (oldest first): cold email(s), follow-ups and inbound replies. Bounded. */
export function threadForJob(db: Db, jobId: string, limit = MAX_LINKS): MailLink[] {
  const list = [...mailLinksForJob(db, jobId, limit), ...replyLinksForJob(db, jobId, limit)];
  list.sort((a, b) => mailTime(a) - mailTime(b));
  return list.slice(-limit);
}

function mailsForJobs(db: Db, jobIds: string[]): MailLink[] {
  const out: MailLink[] = [];
  for (const id of jobIds) {
    if (out.length >= MAX_LINKS) break;
    out.push(...mailLinksForJob(db, id, MAX_LINKS - out.length));
  }
  return out.slice(0, MAX_LINKS);
}

// ---------------------------------------------------------------- job -> people, mails, other outreach

export function jobLinks(db: Db, jobId: string): JobLinks {
  const people = new Map<string, PersonLink>();
  const other: OtherTouch[] = [];
  const hasPeople = tableExists(db, 'people');

  const touchedPersons = new Set<number>();
  if (hasPeople && tableExists(db, 'touches')) {
    for (const t of all(db, `SELECT t.id, t.person_id, t.kind, t.status, t.created_at, t.sent_at, p.platform, p.name, p.headline, p.category
        FROM touches t JOIN people p ON p.id = t.person_id WHERE t.job_id = ? ORDER BY t.id DESC LIMIT ?`, jobId, MAX_LINKS)) {
      const key = `p${t.person_id}`;
      touchedPersons.add(Number(t.person_id));
      if (!people.has(key)) people.set(key, personLinkFromPerson({ ...t, id: t.person_id }, { status: clean(t.status, 32) }));
      other.push({ kind: clean(t.kind, L.short) ?? '', status: clean(t.status, 32) ?? '', at: clean(t.sent_at ?? t.created_at, L.short),
        platform: clean(t.platform, 32) ?? '', person_ref: String(t.person_id), person_name: clean(t.name, L.name) });
    }
  }

  // LinkedIn profile URLs tied to the job: connection requests, the queued connect target and the hiring-post author.
  const urls: { url: string; headline: string | null; status: string | null; note: string | null; at: string | null }[] = [];
  if (tableExists(db, 'connections')) {
    for (const c of all(db, 'SELECT profile_url, headline, status, sent_at, created_at FROM connections WHERE job_id = ? ORDER BY id DESC LIMIT ?', jobId, MAX_LINKS)) {
      urls.push({ url: String(c.profile_url ?? ''), headline: clean(c.headline, 300), status: clean(c.status, 32), note: null, at: clean(c.sent_at ?? c.created_at, L.short) });
    }
  }
  if (tableExists(db, 'outreach_queue')) {
    for (const q of all(db, `SELECT connect_profile_url, connect_category, connect_status FROM outreach_queue
        WHERE job_id = ? AND connect_profile_url IS NOT NULL AND connect_profile_url != '' ORDER BY id DESC LIMIT ?`, jobId, MAX_LINKS)) {
      urls.push({ url: String(q.connect_profile_url), headline: clean(q.connect_category, L.short), status: clean(q.connect_status, 32), note: null, at: null });
    }
  }
  const job = tableExists(db, 'jobs') ? all(db, 'SELECT company, poster_url FROM jobs WHERE id = ?', jobId)[0] : undefined;
  if (job && typeof job.poster_url === 'string' && job.poster_url !== '') urls.push({ url: job.poster_url, headline: null, status: null, note: 'Hiring post author', at: null });

  const personByKey = (key: string): Row | undefined => (hasPeople ? all(db, "SELECT id, platform, name, headline, category FROM people WHERE platform = 'linkedin' AND profile_key = ?", key)[0] : undefined);
  const stageStmt = hasPeople && tableExists(db, 'contact_state');
  for (const u of urls) {
    if (people.size >= MAX_LINKS) break;
    const key = keyOf(u.url);
    const p = key ? personByKey(key) : undefined;
    if (p) {
      const k = `p${p.id}`;
      const prev = people.get(k);
      if (prev) {
        prev.status = u.status ?? prev.status;
        prev.note = prev.note ?? u.note;
      } else {
        let status = u.status;
        if (!status && stageStmt) status = clean(all(db, 'SELECT stage FROM contact_state WHERE person_id = ?', p.id)[0]?.stage, 32);
        people.set(k, personLinkFromPerson(p, { status, note: u.note }));
      }
      if (!touchedPersons.has(Number(p.id)) && u.at !== null && u.status !== null) {
        other.push({ kind: 'connect', status: u.status, at: u.at, platform: 'linkedin', person_ref: String(p.id), person_name: clean(p.name, L.name) });
        touchedPersons.add(Number(p.id));
      }
    } else if (key) {
      const k = `u${key}`;
      const prev = people.get(k);
      if (prev) { prev.status = u.status ?? prev.status; prev.note = prev.note ?? u.note; } else {
        people.set(k, { ref: null, name: null, role: u.headline, channel: 'linkedin', email: null, status: u.status, verified: null, note: u.note ?? 'Profile not saved in People' });
      }
    }
  }

  // Email contacts: the addresses the cold emails of this job went to, then contacts found for the same company.
  const hasContacts = tableExists(db, 'contacts');
  const byEmail = (email: string): Row | undefined => (hasContacts ? all(db, 'SELECT id, company, email, type, verified FROM contacts WHERE lower(email) = ? ORDER BY id DESC LIMIT 1', email)[0] : undefined);
  const seenEmail = new Set<string>();
  if (tableExists(db, 'outreach_queue')) {
    for (const q of all(db, `SELECT DISTINCT email_to, email_status, status FROM outreach_queue WHERE job_id = ? AND email_to IS NOT NULL AND email_to != '' LIMIT ?`, jobId, MAX_LINKS)) {
      const email = lc(String(q.email_to));
      if (seenEmail.has(email) || people.size >= MAX_LINKS) continue;
      seenEmail.add(email);
      const status = clean(q.email_status, 32) ?? clean(q.status, 32);
      const c = byEmail(email);
      people.set(`e${email}`, c ? personLinkFromContact(c, status)
        : { ref: null, name: null, role: null, channel: 'email', email: clean(q.email_to, 320), status, verified: null, note: 'Address not in the contacts table' });
    }
  }
  if (hasContacts && job && lc(String(job.company ?? '')) !== '') {
    for (const c of all(db, 'SELECT id, company, email, type, verified FROM contacts WHERE lower(trim(company)) = ? ORDER BY id DESC LIMIT ?', lc(String(job.company)), MAX_LINKS)) {
      const email = lc(String(c.email ?? ''));
      if (!email || seenEmail.has(email) || people.size >= MAX_LINKS) continue;
      seenEmail.add(email);
      people.set(`e${email}`, personLinkFromContact(c, null));
    }
  }

  other.sort((a, b) => tsOf(b.at) - tsOf(a.at));

  // Inbox items tied to the job through its people (escalations has no job column; person_id is the join key).
  const escalations: EscalationLink[] = [];
  const personIds = [...people.keys()].filter((k) => k.startsWith('p')).map((k) => Number(k.slice(1))).filter((n) => Number.isInteger(n) && n > 0);
  if (personIds.length && tableExists(db, 'escalations')) {
    const marks = personIds.map(() => '?').join(',');
    for (const e of all(db, `SELECT id, reason, platform, person_id, created_at, resolved_at FROM escalations WHERE person_id IN (${marks}) ORDER BY id DESC LIMIT ?`, ...personIds, MAX_LINKS)) {
      escalations.push({ id: Number(e.id), reason: clean(e.reason, L.text) ?? '', platform: clean(e.platform, 32), created_at: clean(e.created_at, L.short),
        resolved: e.resolved_at !== null && e.resolved_at !== undefined, person_ref: e.person_id === null ? null : String(e.person_id) });
    }
  }
  return { people: [...people.values()].slice(0, MAX_LINKS), mails: threadForJob(db, jobId, MAX_LINKS), other: other.slice(0, MAX_LINKS), escalations };
}

// ---------------------------------------------------------------- mail -> job, contact, timeline

export function mailLinks(db: Db, ref: { kind: 'cold' | 'followup'; id: number }): MailLinks | null {
  let jobId: string | null = null;
  if (ref.kind === 'cold') {
    if (!tableExists(db, 'outreach_queue')) return null;
    const q = all(db, 'SELECT job_id FROM outreach_queue WHERE id = ? AND email_sent_at IS NOT NULL', ref.id)[0];
    if (!q) return null;
    jobId = q.job_id === null ? null : String(q.job_id);
  } else {
    if (!tableExists(db, 'followups')) return null;
    const f = all(db, 'SELECT job_id FROM followups WHERE id = ?', ref.id)[0];
    if (!f) return null;
    jobId = f.job_id === null ? null : String(f.job_id);
  }
  if (jobId === null) return { job: null, job_id: null, contact: null, timeline: [], parent: null };
  const timeline = threadForJob(db, jobId, MAX_LINKS);
  // The cold row of this job that was sent is the one the mail panel opens; other cold rows (unsent) are not part of the timeline.
  const cold = timeline.filter((m) => m.kind === 'cold' && m.ref !== null);
  const want = ref.kind === 'cold' ? String(ref.id) : `f${ref.id}`;
  const coldPick = cold.find((m) => m.ref === want) ?? cold[0];
  // Time order (oldest first); an unsent cold row is not part of the thread.
  const finalList = timeline.filter((m) => m.kind !== 'cold' || m === coldPick);
  for (const m of finalList) m.current = m.kind !== 'reply' && m.ref === want;
  const self = finalList.find((m) => m.current);
  const parent = self ? threadParent(finalList, self) : null;

  const to = (finalList.find((m) => m.to)?.to ?? null);
  let contact: PersonLink | null = null;
  if (to) {
    const c = tableExists(db, 'contacts')
      ? all(db, 'SELECT id, company, email, type, verified FROM contacts WHERE lower(email) = ? ORDER BY id DESC LIMIT 1', lc(to))[0] : undefined;
    contact = c ? personLinkFromContact(c, null)
      : { ref: null, name: null, role: null, channel: 'email', email: to, status: null, verified: null, note: 'Address not in the contacts table' };
  }
  return { job: briefForJob(db, jobId), job_id: jobId, contact, timeline: finalList, parent };
}

// ---------------------------------------------------------------- one inbound reply (panel kind "reply")

export interface ReplyDetail {
  message_id: string; job_id: string | null; classification: string | null; label: string; action: string | null; proposed_outcome: string | null;
  from_addr: string | null; subject: string | null; received_at: string | null; job: JobBrief | null; parent: MailLink | null; timeline: MailLink[];
}
export function replyDetail(db: Db, messageId: string): ReplyDetail | null {
  if (!replyRef(messageId) || !tableExists(db, 'processed_messages')) return null;
  const m = all(db, `SELECT message_id, job_id, classification, action, proposed_outcome, from_addr, subject, reply_date, processed_at
      FROM processed_messages WHERE message_id = ?`, messageId)[0];
  if (!m) return null;
  const jobId = typeof m.job_id === 'string' && m.job_id !== '' ? m.job_id : null;
  const timeline = jobId ? threadForJob(db, jobId, MAX_LINKS) : [];
  for (const t of timeline) t.current = t.kind === 'reply' && t.ref === messageId;
  const self = timeline.find((t) => t.current);
  const cls = clean(m.classification, 32);
  return {
    message_id: messageId, job_id: jobId, classification: cls, label: replyLabel(cls), action: clean(m.action, 64), proposed_outcome: clean(m.proposed_outcome, 32),
    from_addr: clean(m.from_addr, 320), subject: clean(m.subject, L.text), received_at: clean(m.reply_date ?? m.processed_at, L.short),
    job: jobId ? briefForJob(db, jobId) : null, parent: self ? threadParent(timeline, self) : null, timeline,
  };
}

// ---------------------------------------------------------------- person / contact -> jobs, mails

export function personLinks(db: Db, ref: { kind: 'person' | 'contact'; id: number }): PersonLinks | null {
  const via = new Map<string, Set<string>>();
  const tag = (jobId: unknown, how: string): void => {
    if (typeof jobId !== 'string' || jobId === '' || (via.size >= MAX_LINKS && !via.has(jobId))) return;
    const s = via.get(jobId) ?? new Set<string>();
    s.add(how);
    via.set(jobId, s);
  };

  if (ref.kind === 'person') {
    if (!tableExists(db, 'people')) return null;
    const p = all(db, 'SELECT id, platform, profile_key FROM people WHERE id = ?', ref.id)[0];
    if (!p) return null;
    const key = String(p.profile_key);
    if (tableExists(db, 'touches')) for (const t of all(db, 'SELECT DISTINCT job_id FROM touches WHERE person_id = ? AND job_id IS NOT NULL LIMIT ?', ref.id, MAX_LINKS)) tag(t.job_id, 'Message');
    // Prefilter by substring, then keep only exact profile-key matches.
    const like = `%${key.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`;
    if (tableExists(db, 'connections')) {
      for (const c of all(db, "SELECT job_id, profile_url FROM connections WHERE job_id IS NOT NULL AND lower(profile_url) LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 200", like)) {
        if (keyOf(c.profile_url) === key) tag(c.job_id, 'Connection');
      }
    }
    if (tableExists(db, 'outreach_queue')) {
      for (const q of all(db, "SELECT job_id, connect_profile_url FROM outreach_queue WHERE lower(connect_profile_url) LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 200", like)) {
        if (keyOf(q.connect_profile_url) === key) tag(q.job_id, 'Connect target');
      }
    }
    if (tableExists(db, 'jobs')) {
      for (const j of all(db, "SELECT id, poster_url FROM jobs WHERE lower(poster_url) LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT 200", like)) {
        if (keyOf(j.poster_url) === key) tag(j.id, 'Hiring post author');
      }
    }
  } else {
    if (!tableExists(db, 'contacts')) return null;
    const c = all(db, 'SELECT id, company, email FROM contacts WHERE id = ?', ref.id)[0];
    if (!c) return null;
    const email = lc(String(c.email ?? ''));
    if (email && tableExists(db, 'outreach_queue')) {
      for (const q of all(db, 'SELECT DISTINCT job_id FROM outreach_queue WHERE lower(email_to) = ? LIMIT ?', email, MAX_LINKS)) tag(q.job_id, 'Email sent to this address');
    }
    const company = lc(String(c.company ?? ''));
    if (company && tableExists(db, 'jobs')) {
      for (const j of all(db, 'SELECT id FROM jobs WHERE lower(trim(company)) = ? ORDER BY rowid DESC LIMIT ?', company, MAX_LINKS)) tag(j.id, 'Same company');
    }
  }

  const jobs: PersonLinks['jobs'] = [];
  const known: string[] = [];
  for (const [id, how] of via) {
    const b = briefForJob(db, id);
    if (b) { jobs.push({ ...b, via: [...how] }); known.push(id); }
  }
  return { jobs: jobs.slice(0, MAX_LINKS), mails: mailsForJobs(db, known) };
}

// ---------------------------------------------------------------- person / contact -> the whole conversation

/** `connect_note` -> `Connect note`. */
export function kindLabel(kind: string): string {
  const t = kind.replace(/[_-]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Message';
}

/**
 * Everything said to or by one person or email contact, oldest first (the newest MAX_LINKS entries): LinkedIn/Naukri touches (kind, status,
 * body preview), connection requests with their note, inbound-message records (the text itself is never stored, only its class),
 * inbox items of the person, and the cold emails, follow-ups and replies of the jobs they are linked to.
 * Join keys: touches.person_id, connections.profile_url -> people.profile_key (exact key), inbound_messages.person_id, escalations.person_id,
 * and the job list of personLinks for the email side. Every text is cleaned and cut; nothing is HTML.
 */
export function personTimeline(db: Db, ref: { kind: 'person' | 'contact'; id: number }): TimelineItem[] | null {
  const linked = personLinks(db, ref);
  if (!linked) return null;
  const items: TimelineItem[] = [];
  const jobs = new Map<string, TimelineItem['job']>();
  for (const j of linked.jobs) jobs.set(j.id, { id: j.id, title: j.title, company: j.company });
  const jobOf = (id: unknown): TimelineItem['job'] => {
    if (typeof id !== 'string' || id === '') return null;
    if (!jobs.has(id)) { const b = briefForJob(db, id); jobs.set(id, b ? { id: b.id, title: b.title, company: b.company } : null); }
    return jobs.get(id) ?? null;
  };

  if (ref.kind === 'person') {
    const p = all(db, 'SELECT id, platform, profile_key FROM people WHERE id = ?', ref.id)[0];
    const key = String(p.profile_key);
    const platform = clean(p.platform, 32) ?? '';
    const connectJobs = new Set<string>();
    if (tableExists(db, 'touches')) {
      for (const t of all(db, 'SELECT id, job_id, kind, status, body, created_at, sent_at FROM touches WHERE person_id = ? ORDER BY id DESC LIMIT ?', ref.id, MAX_LINKS)) {
        const kind = clean(t.kind, L.short) ?? '';
        if (kind.startsWith('connect') && typeof t.job_id === 'string') connectJobs.add(t.job_id);
        items.push({ at: clean(t.sent_at ?? t.created_at, L.short), type: 'touch', direction: 'out', title: `${kindLabel(kind)}${platform ? ` (${platform})` : ''}`,
          status: clean(t.status, 32), preview: clean(t.body, 300), job: jobOf(t.job_id), open: typeof t.job_id === 'string' && t.job_id ? { kind: 'job', id: t.job_id } : null, inbox_id: null });
      }
    }
    if (tableExists(db, 'connections')) {
      const like = `%${key.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`;
      for (const c of all(db, "SELECT job_id, profile_url, note, status, sent_at, created_at FROM connections WHERE lower(profile_url) LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 100", like)) {
        if (keyOf(c.profile_url) !== key) continue;
        if (typeof c.job_id === 'string' && connectJobs.has(c.job_id)) continue; // already shown as a touch
        items.push({ at: clean(c.sent_at ?? c.created_at, L.short), type: 'connection', direction: 'out', title: 'Connection request', status: clean(c.status, 32),
          preview: clean(c.note, 300), job: jobOf(c.job_id), open: typeof c.job_id === 'string' && c.job_id ? { kind: 'job', id: c.job_id } : null, inbox_id: null });
      }
    }
    if (tableExists(db, 'inbound_messages')) {
      for (const m of all(db, 'SELECT id, platform, klass, escalated, created_at FROM inbound_messages WHERE person_id = ? ORDER BY id DESC LIMIT ?', ref.id, MAX_LINKS)) {
        items.push({ at: clean(m.created_at, L.short), type: 'inbound', direction: 'in', title: `Message received (${clean(m.platform, 32) ?? platform})`,
          status: clean(m.klass, 32), preview: Number(m.escalated) === 1 ? 'Sent to the inbox for you. The message text is not stored here.' : 'The message text is not stored here.', job: null, open: null, inbox_id: null });
      }
    }
    if (tableExists(db, 'escalations')) {
      const cols = new Set((db.prepare('PRAGMA table_info(escalations)').all() as { name: string }[]).map((c) => c.name));
      const excerpt = cols.has('message_excerpt') ? 'message_excerpt' : 'NULL';
      for (const e of all(db, `SELECT id, reason, platform, created_at, resolved_at, ${excerpt} AS excerpt FROM escalations WHERE person_id = ? ORDER BY id DESC LIMIT ?`, ref.id, MAX_LINKS)) {
        items.push({ at: clean(e.created_at, L.short), type: 'escalation', direction: 'in', title: `Inbox item #${e.id}`, status: e.resolved_at ? 'resolved' : 'open',
          preview: clean(e.excerpt, 300) ?? clean(e.reason, 300), job: null, open: null, inbox_id: Number(e.id) });
      }
    }
  }

  // Email side: the cold email, follow-ups and replies of every linked job (bounded).
  // An email contact only owns the threads of jobs mailed to its address (not every job of the same company).
  const mailJobs = ref.kind === 'contact' ? linked.jobs.filter((j) => j.via.includes('Email sent to this address')) : linked.jobs;
  for (const j of mailJobs.slice(0, 20)) {
    for (const m of threadForJob(db, j.id, 20)) {
      const isReply = m.kind === 'reply';
      items.push({
        at: m.sent_at ?? m.created_at, type: isReply ? 'reply' : m.kind === 'cold' ? 'email' : 'followup', direction: isReply ? 'in' : 'out',
        title: `${m.label}${m.to ? ` to ${m.to}` : m.from ? ` from ${m.from}` : ''}`, status: m.status, preview: m.subject, job: jobOf(j.id),
        open: m.ref ? { kind: isReply ? 'reply' : 'mail', id: m.ref } : null, inbox_id: null,
      });
    }
  }
  items.sort((a, b) => tsOf(a.at) - tsOf(b.at));
  return items.slice(-MAX_LINKS);
}

// ---------------------------------------------------------------- detail rows for the two new panel kinds

export interface ContactDetail { id: number; company: string | null; email: string | null; type: string | null; verified: boolean | null; source: string | null; created_at: string | null }
export function contactDetail(db: Db, id: number): ContactDetail | null {
  if (!tableExists(db, 'contacts')) return null;
  const r = all(db, 'SELECT id, company, email, type, verified, source, created_at FROM contacts WHERE id = ?', id)[0];
  if (!r) return null;
  return { id: Number(r.id), company: clean(r.company, L.name), email: clean(r.email, 320), type: clean(r.type, L.short),
    verified: r.verified === null || r.verified === undefined ? null : Number(r.verified) === 1, source: clean(r.source, L.short), created_at: clean(r.created_at, L.short) };
}

export interface FollowupDetail {
  id: number; job_id: string; n: number; kind: 'followup' | 'feedback'; label: string; status: string; subject: string | null; body: string | null;
  to: string | null; created_at: string | null; sent_at: string | null; decided_at: string | null; title: string | null; company: string | null; has_reply: boolean;
}
export function followupDetail(db: Db, id: number): FollowupDetail | null {
  if (!tableExists(db, 'followups')) return null;
  const f = all(db, 'SELECT id, job_id, n, status, subject, body, created_at, sent_at, decided_at FROM followups WHERE id = ?', id)[0];
  if (!f) return null;
  const jobId = String(f.job_id);
  const to = tableExists(db, 'outreach_queue')
    ? all(db, 'SELECT email_to FROM outreach_queue WHERE job_id = ? AND email_to IS NOT NULL ORDER BY id DESC LIMIT 1', jobId)[0]?.email_to : undefined;
  const j = briefForJob(db, jobId);
  const n = Number(f.n);
  const kind = followupKind(n);
  const reply = tableExists(db, 'processed_messages')
    ? all(db, "SELECT 1 AS hit FROM processed_messages WHERE job_id = ? AND coalesce(classification, '') NOT IN ('noise', 'auto_ack', 'bounce') LIMIT 1", jobId).length > 0 : false;
  return {
    id: Number(f.id), job_id: cleanText(jobId, 200), n, kind, label: mailStageLabel(kind, n), status: cleanText(String(f.status ?? ''), 32),
    subject: clean(f.subject, L.text), body: clean(f.body, 20000), to: clean(to, 320), created_at: clean(f.created_at, L.short),
    sent_at: clean(f.sent_at, L.short), decided_at: clean(f.decided_at, L.short), title: j?.title ?? null, company: j?.company ?? null, has_reply: reply,
  };
}
