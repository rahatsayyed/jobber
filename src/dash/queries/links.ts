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
  /** `<outreach_queue.id>` for the cold email (only once sent), `f<followups.id>` for a follow-up. */
  ref: string | null; kind: 'cold' | 'followup' | 'feedback'; n: number | null; job_id: string; label: string; status: string | null;
  to: string | null; subject: string | null; sent_at: string | null; created_at: string | null; current?: boolean;
}
export interface OtherTouch { kind: string; status: string; at: string | null; platform: string; person_ref: string | null; person_name: string | null }

export interface JobLinks { people: PersonLink[]; mails: MailLink[]; other: OtherTouch[] }
export interface MailLinks { job: JobBrief | null; job_id: string | null; contact: PersonLink | null; timeline: MailLink[] }
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
export const followupKind = (n: number): 'followup' | 'feedback' => (n >= 4 ? 'feedback' : 'followup');

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
        status: clean(q.email_status, 32) ?? clean(q.status, 32), to: clean(q.email_to, 320), subject: clean(q.email_subject, L.text),
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
        ref: `f${f.id}`, kind, n, job_id: jobId, label: mailStageLabel(kind, n), status: clean(f.status, 32), to, subject: clean(f.subject, L.text),
        sent_at: clean(f.sent_at, L.short), created_at: clean(f.created_at, L.short),
      });
    }
  }
  return out.slice(0, limit);
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

  other.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return { people: [...people.values()].slice(0, MAX_LINKS), mails: mailLinksForJob(db, jobId, MAX_LINKS), other: other.slice(0, MAX_LINKS) };
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
  if (jobId === null) return { job: null, job_id: null, contact: null, timeline: [] };
  const timeline = mailLinksForJob(db, jobId, MAX_LINKS);
  // The cold row of this job that was sent is the one the mail panel opens; other cold rows (unsent) are not part of the timeline.
  const cold = timeline.filter((m) => m.kind === 'cold' && m.ref !== null);
  const want = ref.kind === 'cold' ? String(ref.id) : `f${ref.id}`;
  const coldPick = cold.find((m) => m.ref === want) ?? cold[0];
  const finalList = [...(coldPick ? [coldPick] : []), ...timeline.filter((m) => m.kind !== 'cold')];
  for (const m of finalList) m.current = m.ref === want;

  const to = (finalList.find((m) => m.to)?.to ?? null);
  let contact: PersonLink | null = null;
  if (to) {
    const c = tableExists(db, 'contacts')
      ? all(db, 'SELECT id, company, email, type, verified FROM contacts WHERE lower(email) = ? ORDER BY id DESC LIMIT 1', lc(to))[0] : undefined;
    contact = c ? personLinkFromContact(c, null)
      : { ref: null, name: null, role: null, channel: 'email', email: to, status: null, verified: null, note: 'Address not in the contacts table' };
  }
  return { job: briefForJob(db, jobId), job_id: jobId, contact, timeline: finalList };
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
