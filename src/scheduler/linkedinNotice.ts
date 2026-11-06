// src/scheduler/linkedinNotice.ts
// Telegram notices (topic `inbox`) for the LinkedIn inbox read: each new inbound thread and each reply draft that was auto-approved and will be
// sent by the drip lane. Drafts are announced right after the inbox read, BEFORE the lane can send them (one action per tick, 8 to 20 minutes
// apart), with the `npm run replies -- skip <id>` hint. Owner-only asks (salary, interview time, personal data, references, link or phone) get
// the 🔔 `needs you` flag and are never drafted (replyDrafts.ts). Third-party text is cleaned (secrets redacted), bounded and escaped (tgHtml).
// Escalations announced here are remembered, so the 15-minute escalation digest does not announce them a second time.
import type BetterSqlite3 from 'better-sqlite3';
import { BLANK, E, b, clean, code, excerpt, headline, html, i as ital, join, line, lines, type Html } from '../platform/tgHtml.js';
import { ownerOnlyAskText, ownerOnlyCodes } from '../outreach/ownerOnly.js';
import { getState, setState } from './runLog.js';
import { notifyTg, type HasTg } from './dripNotice.js';

type Db = BetterSqlite3.Database;

export const KEY_INBOUND_ID = 'li_notice_inbound_id';
export const KEY_DRAFT_ID = 'li_notice_draft_id';
export const KEY_ANNOUNCED_ESC = 'li_notice_escalations';

/** Escalation ids this notice already announced (the digest skips them). */
export function announcedEscalations(db: Db): Set<number> {
  try {
    const v = JSON.parse(getState(db, KEY_ANNOUNCED_ESC) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);
  } catch {
    return new Set();
  }
}

interface InRow { id: number; thread_ref: string; klass: string; person_id: number | null; name: string | null }
interface EscRow { id: number; reason: string; ask_kind: string | null; message_excerpt: string | null; sender_name: string | null }
interface DraftRow { id: number; body: string; attach_resume: number; person_id: number; name: string | null; escalation_id: number }

export interface InboundView { name: string | null; klass: string; excerpt: string; needsYou: boolean; reasons: string[]; escalationId: number | null }

function maxId(db: Db, table: string): number {
  try { return (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m; } catch { return 0; }
}

/** First time the lane runs the notice: only rows from now on are announced (no flood of old threads). */
function lastSeen(db: Db, key: string, table: string, now: Date): number {
  const v = getState(db, key);
  if (v !== null && /^\d+$/.test(v)) return Number(v);
  const m = maxId(db, table);
  setState(db, key, String(m), now);
  return m;
}

export function formatInboundBlock(v: InboundView): Html {
  return lines([
    join([v.needsYou ? E.you : '•', b('LinkedIn message'), clean(v.name, 60) || 'unknown person'], ' '),
    line('Type', clean(v.klass, 30)),
    v.excerpt ? ital(`"${excerpt(v.excerpt, 200)}"`) : '',
    v.needsYou ? join([b('needs you'), ': answer on LinkedIn yourself, the agent never answers this', v.reasons.length ? ` (${v.reasons.join(', ')})` : ''], '') : '',
  ]);
}

export function formatDraftBlock(dr: { id: number; name: string | null; body: string; attach: boolean }): Html {
  return lines([
    join([E.ok, b('Reply will be sent'), clean(dr.name, 60) || 'unknown person'], ' '),
    ital(`"${clean(dr.body, 400)}"`),
    dr.attach ? 'The tailored resume is attached by code.' : '',
    join(['To stop it: ', code(`npm run replies -- skip ${dr.id}`)], ''),
  ]);
}

/** Announces new inbound threads and new approved drafts. Never throws. Returns how many items were announced. */
export async function notifyLinkedinInbox(d: HasTg & { db: Db; now: () => Date }): Promise<number> {
  try {
    const db = d.db;
    const now = d.now();
    const lastIn = lastSeen(db, KEY_INBOUND_ID, 'inbound_messages', now);
    const lastDr = lastSeen(db, KEY_DRAFT_ID, 'reply_drafts', now);
    const ins = db.prepare(
      `SELECT m.id, m.thread_ref, m.klass, m.person_id, p.name FROM inbound_messages m LEFT JOIN people p ON p.id = m.person_id
       WHERE m.platform = 'linkedin' AND m.id > ? ORDER BY m.id LIMIT 40`,
    ).all(lastIn) as InRow[];
    const drafts = db.prepare(
      `SELECT r.id, r.body, r.attach_resume, r.person_id, r.escalation_id, p.name FROM reply_drafts r LEFT JOIN people p ON p.id = r.person_id
       WHERE r.id > ? AND r.status = 'approved' ORDER BY r.id LIMIT 20`,
    ).all(lastDr) as DraftRow[];
    const announced = announcedEscalations(db);
    const escOf = db.prepare(
      "SELECT id, reason, ask_kind, message_excerpt, sender_name FROM escalations WHERE platform = 'linkedin' AND thread_ref = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
    );
    const blocks: Html[] = [];
    let needs = 0;
    for (const m of ins) {
      if (m.klass === 'noise') continue;
      const e = escOf.get(m.thread_ref) as EscRow | undefined;
      const text = e?.message_excerpt ?? '';
      const reasons = ownerOnlyCodes('', text);
      const needsYou = !!e && (ownerOnlyAskText(`${e.reason} ${e.ask_kind ?? ''}`) || m.klass === 'interview' || reasons.length > 0 || /^\s*\[(blocked|unscreened)/i.test(e.reason));
      if (needsYou) needs++;
      if (e) announced.add(e.id);
      blocks.push(formatInboundBlock({ name: m.name ?? e?.sender_name ?? null, klass: m.klass, excerpt: text, needsYou, reasons, escalationId: e?.id ?? null }));
    }
    for (const dr of drafts) blocks.push(formatDraftBlock({ id: dr.id, name: dr.name, body: dr.body, attach: dr.attach_resume === 1 }));
    // remember before the send: a failing Telegram must not repeat the same notice every inbox read
    if (ins.length) setState(db, KEY_INBOUND_ID, String(ins[ins.length - 1].id), now);
    if (drafts.length) setState(db, KEY_DRAFT_ID, String(drafts[drafts.length - 1].id), now);
    setState(db, KEY_ANNOUNCED_ESC, JSON.stringify([...announced].slice(-300)), now);
    if (blocks.length === 0) return 0;
    const head = headline(needs ? E.you : E.ok, `LinkedIn inbox: ${ins.length} new, ${drafts.length} repl${drafts.length === 1 ? 'y' : 'ies'} queued`, needs ? `(${needs} need${needs === 1 ? 's' : ''} you)` : undefined);
    const parts: Array<Html | string> = [head];
    let used = head.s.length;
    for (const blk of blocks) {
      if (used + blk.s.length > 3500) { parts.push(BLANK, ital('... more in /escalations')); break; }
      parts.push(BLANK, blk);
      used += blk.s.length + 2;
    }
    await notifyTg(d, 'inbox', html(lines(parts)));
    return blocks.length;
  } catch {
    return 0;
  }
}
