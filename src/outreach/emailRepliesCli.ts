// src/outreach/emailRepliesCli.ts
// Owner commands for the automatic EMAIL replies (scripts/email-replies.ts): list, show, skip, resolve. Nothing here sends mail.
// The reply text is code-built from the owner's own facts, but the subject and the address come from a third party: every field is cleaned.
import type BetterSqlite3 from 'better-sqlite3';
import { cleanUntrusted } from '../manual/report.js';
import { EMAIL_REPLY_STATUSES, type EmailReplyStatus } from './emailRepliesSchema.js';
import { emailRepliesSentToday, getEmailReply, listEmailReplies, resolveStuckEmailReply, skipEmailReply, type EmailReplyRow } from './emailReplies.js';

type Db = BetterSqlite3.Database;

export const EMAIL_REPLIES_USAGE = 'usage: npm run email-replies -- list [all|drafted|approved|sending|sent|failed|cancelled] | show <id> | skip <id> | resolve <id> sent|cancelled';

function block(r: EmailReplyRow, full: boolean): string[] {
  const head = `#${r.id} ${r.status.toUpperCase()} to ${cleanUntrusted(r.to_addr, 120)} [${r.kind}] ${cleanUntrusted(r.subject, 100)}${r.note ? ` (${cleanUntrusted(r.note, 100)})` : ''}`;
  return full ? [head, ...r.body.split('\n').map((l) => `    ${cleanUntrusted(l, 300)}`)] : [head, `    "${cleanUntrusted(r.body, 200)}"`];
}

/** Lines for the /limits screen: automatic replies sent today. */
export function emailReplyLimitLine(db: Db): string {
  return `automatic email replies sent today: ${emailRepliesSentToday(db)}`;
}

/** Runs one command. Never throws; code 0 is success, 2 a usage error, 1 a refused change. */
export function runEmailRepliesCli(db: Db, argv: string[]): { code: number; lines: string[] } {
  const [cmd, arg, arg2] = argv;
  if (cmd === 'list' || cmd === undefined) {
    const want = arg === undefined ? undefined : arg === 'all' ? EMAIL_REPLY_STATUSES : (EMAIL_REPLY_STATUSES as readonly string[]).includes(arg) ? [arg as EmailReplyStatus] : null;
    if (want === null) return { code: 2, lines: [EMAIL_REPLIES_USAGE] };
    const rows = listEmailReplies(db, want, 100);
    if (!rows.length) return { code: 0, lines: ['No automatic email replies.'] };
    return { code: 0, lines: [...rows.flatMap((r) => block(r, false)), '', 'Cancel one before it goes out with: npm run email-replies -- skip <id>'] };
  }
  if (cmd === 'show' || cmd === 'skip' || cmd === 'resolve') {
    if (arg === undefined || !/^\d{1,9}$/.test(arg)) return { code: 2, lines: [EMAIL_REPLIES_USAGE] };
    const id = Number(arg);
    if (cmd === 'show') {
      const r = getEmailReply(db, id);
      return r ? { code: 0, lines: block(r, true) } : { code: 1, lines: [`reply #${id} not found`] };
    }
    if (cmd === 'skip') {
      const r = skipEmailReply(db, id);
      return r.ok ? { code: 0, lines: [`reply #${id} cancelled: it will not be sent`] } : { code: 1, lines: [`reply #${id} not changed: ${r.reason}`] };
    }
    if (arg2 !== 'sent' && arg2 !== 'cancelled') return { code: 2, lines: [EMAIL_REPLIES_USAGE] };
    const r = resolveStuckEmailReply(db, id, arg2);
    return r.ok ? { code: 0, lines: [`reply #${id} marked ${arg2}`] } : { code: 1, lines: [`reply #${id} not changed: ${r.reason}`] };
  }
  return { code: 2, lines: [EMAIL_REPLIES_USAGE] };
}
