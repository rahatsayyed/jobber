// src/outreach/replyDraftsCli.ts
// Owner commands for LinkedIn reply drafts (scripts/replies.ts): list, approve, skip. Approve and skip only change the draft's status;
// nothing here sends anything. Draft text, names and companies come from model/third-party text: every field is cleaned to one bounded line.
import type BetterSqlite3 from 'better-sqlite3';
import { cleanUntrusted } from '../manual/report.js';
import {
  approveReplyDraft, getReplyDraft, listReplyDrafts, skipReplyDraft, DRAFT_STATUSES, type DraftStatus, type DraftView,
} from './replyDrafts.js';

type Db = BetterSqlite3.Database;

export const REPLIES_USAGE = 'usage: npm run replies -- list [all|drafted|approved|sent|failed|skipped] | approve <id> | skip <id>';

function draftBlock(d: DraftView): string[] {
  const who = `${cleanUntrusted(d.person_name, 60) || 'unknown person'}${d.company ? ` (${cleanUntrusted(d.company, 60)})` : ''}`;
  const flags = [d.attach_resume ? 'attaches the tailored resume' : null, d.stale ? 'STALE: a newer message arrived, skip it' : null, !d.escalation_open && d.status !== 'sent' ? 'escalation already handled' : null]
    .filter(Boolean).join('; ');
  return [
    `#${d.id} ${d.status.toUpperCase()} to ${who} (escalation #${d.escalation_id})${flags ? ` [${flags}]` : ''}`,
    `    "${cleanUntrusted(d.body, 600)}"`,
  ];
}

/** Lines for the /escalations screen: drafts waiting for the owner and approved ones waiting to go out. Empty when there are none. */
export function renderReplyDraftLines(db: Db): string[] {
  let rows: DraftView[] = [];
  try {
    rows = listReplyDrafts(db, ['drafted', 'approved'], 20);
  } catch {
    return [];
  }
  if (!rows.length) return [];
  const out = ['', `== Reply drafts (${rows.length}) ==`, 'Safe replies go out by themselves at the lane\'s next free turn; cancel one with: npm run replies -- skip <id>.'];
  for (const d of rows) out.push(...draftBlock(d));
  return out;
}

/** Runs one command. Never throws; code 0 is success, 2 a usage error, 1 a refused change. */
export function runRepliesCli(db: Db, argv: string[], now: Date): { code: number; lines: string[] } {
  const [cmd, arg] = argv;
  if (cmd === 'list' || cmd === undefined) {
    const want = arg === undefined || arg === 'all' ? undefined : (DRAFT_STATUSES as readonly string[]).includes(arg) ? [arg as DraftStatus] : null;
    if (want === null) return { code: 2, lines: [REPLIES_USAGE] };
    const rows = listReplyDrafts(db, want ?? (['drafted', 'approved', 'failed'] as DraftStatus[]), 100);
    if (!rows.length) return { code: 0, lines: ['No reply drafts.'] };
    return { code: 0, lines: rows.flatMap((d) => draftBlock(d)) };
  }
  if (cmd === 'approve' || cmd === 'skip') {
    if (arg === undefined || !/^\d{1,9}$/.test(arg)) return { code: 2, lines: [REPLIES_USAGE] };
    const id = Number(arg);
    const r = cmd === 'approve' ? approveReplyDraft(db, id, now) : skipReplyDraft(db, id);
    if (!r.ok) return { code: 1, lines: [`draft #${id} not changed: ${r.reason}`] };
    const d = getReplyDraft(db, id);
    return { code: 0, lines: [`draft #${id} ${cmd === 'approve' ? 'approved: the LinkedIn drip lane sends it at its next free turn' : 'skipped'}${d && cmd === 'approve' && d.attach_resume ? ' (with the tailored resume attached)' : ''}`] };
  }
  return { code: 2, lines: [REPLIES_USAGE] };
}
