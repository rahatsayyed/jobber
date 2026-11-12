// src/outreach/emailEscalations.ts
// An email reply that needs the OWNER (needs_you = 1) must be on the web dashboard Inbox as well as in Telegram. Until now only the LinkedIn, Naukri
// and Wellfound operators wrote `escalations` rows, so such a mail was announced once on Telegram and then lost. This writes ONE escalation per
// mail (platform `email`, one card per Gmail thread; the dashboard Inbox already has an "email" platform lane and the severity model in
// src/status/severity.ts rates a human reply CRITICAL). Code only, zero LLM; the mail text is cleaned and screened by addEscalation.
import type BetterSqlite3 from 'better-sqlite3';
import { addrOf } from '../lib/verifiedAddress.js';
import { addEscalation } from './service.js';
import { OWNER_REASON_TEXT, type OwnerKind } from './emailReplyClass.js';
import { parseAutoClass } from './emailReplies.js';

type Db = BetterSqlite3.Database;

interface Row {
  message_id: string; job_id: string | null; thread_id: string | null; from_addr: string | null; subject: string | null; excerpt: string | null;
  classification: string | null; auto_class: string | null; auto_note: string | null; reply_date: string | null; company: string | null; title: string | null;
}

/** The company the mail is about: the matched job's company, else the sender domain's first label (never invented text). */
export function senderCompany(company: string | null | undefined, fromAddr: string | null | undefined): string {
  const c = String(company ?? '').trim();
  if (c) return c;
  const dom = (addrOf(fromAddr) ?? '').split('@')[1] ?? '';
  const first = dom.split('.')[0] ?? '';
  return first ? first[0].toUpperCase() + first.slice(1) : 'Unknown company';
}

/** `Agent42 Labs (hello@agent42labs.com)`: the company and the sender, the way every owner-facing line starts. */
export function whoLine(company: string | null | undefined, fromAddr: string | null | undefined): string {
  const addr = addrOf(fromAddr) ?? String(fromAddr ?? '').trim();
  return `${senderCompany(company, fromAddr)}${addr ? ` (${addr})` : ''}`;
}

/** The plain-words reason a mail needs the owner, built from the stored verdict (closed code lists only, never mail text). */
export function whyNeedsOwner(autoClass: string | null | undefined, autoNote: string | null | undefined, classification: string | null | undefined): string {
  const ac = parseAutoClass(autoClass);
  if (ac && ac.verdict === 'owner' && ac.owner.length > 0) return `this mail ${ac.owner.map((k: OwnerKind) => OWNER_REASON_TEXT[k]).join(' and ')}`;
  const note = String(autoNote ?? '').replace(/^needs you:\s*/i, '').trim();
  if (note) return note;
  if (classification === 'interview') return 'this mail is about an interview';
  if (classification === 'offer') return 'this mail is about an offer';
  return 'this mail needs a human reading';
}

const REF_OK = /^[A-Za-z0-9_:./-]{1,120}$/;

/**
 * One escalation per processed mail that needs the owner and has none yet (esc_id), in the dashboard Inbox group "Replies and needs you". Never
 * throws. Returns how many were stored. A thread that already has an open card gets that card updated (addEscalation merges per thread).
 */
export function escalateOwnerReplies(db: Db, now: Date): number {
  let n = 0;
  try {
    const rows = db.prepare(
      `SELECT p.message_id, p.job_id, p.thread_id, p.from_addr, p.subject, p.excerpt, p.classification, p.auto_class, p.auto_note, p.reply_date, j.company, j.title
       FROM processed_messages p LEFT JOIN jobs j ON j.id = p.job_id
       WHERE p.needs_you = 1 AND p.esc_id IS NULL ORDER BY p.processed_at, p.rowid LIMIT 60`,
    ).all() as Row[];
    const mark = db.prepare('UPDATE processed_messages SET esc_id = ? WHERE message_id = ?');
    for (const r of rows) {
      const ref = r.thread_id && REF_OK.test(r.thread_id) ? r.thread_id : `mail-${r.message_id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100)}`;
      const why = whyNeedsOwner(r.auto_class, r.auto_note, r.classification);
      const parsed = r.reply_date ? Date.parse(`${r.reply_date.replace(' ', 'T')}Z`) : NaN;
      const id = addEscalation(db, {
        runId: null, platform: 'email', threadRef: ref, reason: 'reply_needed',
        detail: `Email reply from ${whoLine(r.company, r.from_addr)}: ${why}. Answer it yourself in Gmail; the agent will not.`,
        sender: whoLine(r.company, r.from_addr), senderHeadline: r.title ?? undefined,
        excerpt: r.excerpt ?? undefined, messageAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined,
      }, now);
      mark.run(id, r.message_id);
      n++;
    }
  } catch {
    // never breaks the reply check
  }
  return n;
}
