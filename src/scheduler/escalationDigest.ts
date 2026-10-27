// src/scheduler/escalationDigest.ts
// The owner's Telegram digest of new escalations: composed by code (zero LLM calls), plain text, at most one message per 15 minutes.
// "New" means an open, not snoozed row with an id above the last one reported (scheduler_state `esc_digest_last_id`). The digest never
// carries any way to answer a third party: the owner replies on the platform and marks the row handled in the dashboard Inbox tab.
import type BetterSqlite3 from 'better-sqlite3';
import { GROUP_ORDER, listEscalations, type EscItem } from '../outreach/escalations.js';
import { inQuietHours, type QuietConfig } from '../outreach/quiet.js';
import { telegramNotifier } from '../platform/notify.js';
import { itemBlock } from '../status/escalations.js';
import { getState, setState } from './runLog.js';

type Db = BetterSqlite3.Database;

export const ESCALATION_DIGEST_GAP_MS = 15 * 60_000;
const MAX_CHARS = 3500;
const TOP_LINES = 5;
const KEY_LAST_AT = 'esc_digest_last_at';
const KEY_LAST_ID = 'esc_digest_last_id';

/** Where the dashboard Inbox lives: the origin of the OIDC redirect when one is set, else the local dashboard port. */
export function dashboardInboxUrl(env: NodeJS.ProcessEnv): string {
  try {
    const u = new URL(String(env.WEB_OIDC_REDIRECT_URI ?? ''));
    if (u.protocol === 'https:' || u.protocol === 'http:') return `${u.origin}/#/inbox`;
  } catch {
    // no usable redirect URI: fall back to the local port
  }
  const port = /^\d{4,5}$/.test(String(env.WEB_PORT ?? '').trim()) ? String(env.WEB_PORT).trim() : '8787';
  return `http://127.0.0.1:${port}/#/inbox`;
}

export type DigestResult =
  | { sent: true; count: number }
  | { sent: false; reason: 'nothing_new' | 'only_flagged' | 'too_soon' | 'send_failed' };

function compose(fresh: EscItem[], rowCount: number, url: string | null, now: Date): string {
  const rows = (g: EscItem['group']): number => fresh.filter((i) => i.group === g).reduce((n, i) => n + i.count, 0);
  const lines = [
    `Jobber: ${rowCount} new escalation${rowCount === 1 ? '' : 's'} need a look`,
    `${rows('human')} reply/needs you, ${rows('platform')} platform, ${rows('noise')} flagged`,
    '',
  ];
  const shown: EscItem[] = [];
  for (const g of GROUP_ORDER) if (g !== 'noise') shown.push(...fresh.filter((i) => i.group === g));
  const tail = ['', 'Full list: /escalations'];
  if (url) tail.push(`Dashboard Inbox: ${url}`);
  let used = lines.join('\n').length + tail.join('\n').length + 40;
  let n = 0;
  for (const i of shown) {
    if (n >= TOP_LINES) break;
    const block = itemBlock(i, now, 120).join('\n');
    if (used + block.length + 1 > MAX_CHARS) break;
    lines.push(block);
    used += block.length + 1;
    n += 1;
  }
  const hidden = fresh.length - n;
  if (hidden > 0) lines.push(`... and ${hidden} more`);
  return [...lines, ...tail].join('\n');
}

export async function runEscalationDigest(
  db: Db,
  d: { send: (text: string) => Promise<{ ok: boolean }>; now: Date; url: string | null },
): Promise<DigestResult> {
  const lastAt = Date.parse(getState(db, KEY_LAST_AT) ?? '');
  if (Number.isFinite(lastAt) && d.now.getTime() - lastAt < ESCALATION_DIGEST_GAP_MS) return { sent: false, reason: 'too_soon' };
  const lastId = Number(getState(db, KEY_LAST_ID) ?? 0) || 0;
  const fresh = listEscalations(db, { now: d.now, status: 'open' }).items.filter((i) => i.ids.some((id) => id > lastId));
  if (!fresh.length) return { sent: false, reason: 'nothing_new' };
  if (fresh.every((i) => i.group === 'noise')) return { sent: false, reason: 'only_flagged' };
  const rowCount = fresh.reduce((n, i) => n + i.ids.filter((id) => id > lastId).length, 0);
  // Recorded before the send so a failing Telegram is retried at most once per gap.
  setState(db, KEY_LAST_AT, d.now.toISOString(), d.now);
  const sent = await d.send(compose(fresh, rowCount, d.url, d.now));
  if (!sent.ok) return { sent: false, reason: 'send_failed' };
  setState(db, KEY_LAST_ID, String(Math.max(...fresh.flatMap((i) => i.ids))), d.now);
  return { sent: true, count: rowCount };
}

/** The daemon's tick: outside quiet hours, send the digest through the owner's Telegram. Never throws. */
export function escalationDigestTick(db: Db, env: NodeJS.ProcessEnv, quiet: QuietConfig, now: () => Date): () => Promise<void> {
  const tg = telegramNotifier(env);
  return async () => {
    try {
      if (inQuietHours(now(), quiet)) return;
      await runEscalationDigest(db, { send: (t) => tg.send(t), now: now(), url: dashboardInboxUrl(env) });
    } catch {
      // the digest is a convenience: a failure must never stop the scheduler
    }
  };
}
