// src/scheduler/escalationDigest.ts
// The owner's Telegram digest of new escalations: composed by code (zero LLM calls), Telegram HTML (src/platform/tgHtml.ts), at most one message per 15 minutes.
// "New" means an open, not snoozed row with an id above the last one reported (scheduler_state `esc_digest_last_id`). The digest never
// carries any way to answer a third party: the owner replies on the platform and marks the row handled in the dashboard Inbox tab.
import type BetterSqlite3 from 'better-sqlite3';
import { GROUP_ORDER, listEscalations, type EscItem } from '../outreach/escalations.js';
import { inQuietHours, type QuietConfig } from '../outreach/quiet.js';
import { buildManualQueue, manualApplyLine } from '../manual/manualApply.js';
import { telegramNotifier } from '../platform/notify.js';
import { ageText } from '../status/escalations.js';
import { BLANK, E, b, clean, code, excerpt, headline, html, i as ital, join, line, lines, link, type Html } from '../platform/tgHtml.js';
import { getState, setState } from './runLog.js';
import { announcedEscalations } from './linkedinNotice.js';

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

/** One escalation as a short HTML block: bold id, platform and reason, then who and job, a quote in italics, the next step. */
function itemHtml(it: EscItem, now: Date): Html {
  const who = it.senderName ? `${clean(it.senderName, 60)}${it.senderHeadline ? ` (${clean(it.senderHeadline, 60)})` : ''}` : '';
  const label = it.group === 'human' ? it.label : `${it.label}: ${clean(it.reason, 70)}`;
  const head = join(['•', b(`#${it.id}${it.updates > 1 ? ` x${it.updates}` : ''}`), clean(it.platform ?? '-', 20), clean(label, 120)]);
  const sub = [who, it.jobTitle ? clean(it.jobTitle, 70) : '', ageText(it.last_at, now)].filter(Boolean).join(' · ');
  const quote = it.excerpt ? excerpt(it.excerpt, 120) : it.detail ? excerpt(it.detail, 120) : '';
  const ind = (...p: Array<Html | string>): Html => join(['   ', ...p], '');
  return lines([
    head,
    sub && ind(sub),
    quote && ind(ital(`"${quote}"`)),
    it.group === 'human' && it.platform !== 'apply' && it.todo && ind(ital(`next: ${clean(it.todo, 140)}`)),
    it.assistCommand && ind('run: ', code(clean(it.assistCommand, 140))),
    it.questions.length > 0 && ind(ital(`${it.questions.length} question${it.questions.length === 1 ? '' : 's'} need your answer`), ': ', code('npm run answers -- list')),
    it.count > 1 && ind('ids ', code([...it.ids].sort((x, y) => x - y).join(','))),
  ]);
}

/** The digest as Telegram HTML (at most MAX_CHARS; items that do not fit are summarised as "and N more"). */
function compose(fresh: EscItem[], rowCount: number, url: string | null, now: Date, manualLine: string | null = null): string {
  const rows = (g: EscItem['group']): number => fresh.filter((x) => x.group === g).reduce((n, x) => n + x.count, 0);
  const head = lines([
    headline(E.you, `${rowCount} new escalation${rowCount === 1 ? '' : 's'} need a look`),
    ital(`${rows('human')} reply/needs you, ${rows('platform')} platform, ${rows('noise')} flagged`),
  ]);
  const shown: EscItem[] = [];
  for (const g of GROUP_ORDER) if (g !== 'noise') shown.push(...fresh.filter((x) => x.group === g));
  const tail = lines([
    manualLine ? clean(manualLine, 300) : '',
    join(['Full list:', code('/escalations')]),
    url ? line('Dashboard Inbox', link(url, url)) : '',
  ]);
  const blocks: Html[] = [];
  let used = head.s.length + tail.s.length + 60;
  for (const it of shown) {
    if (blocks.length >= TOP_LINES) break;
    const block = itemHtml(it, now);
    if (used + block.s.length + 2 > MAX_CHARS) break;
    blocks.push(block);
    used += block.s.length + 2;
  }
  const hidden = fresh.length - blocks.length;
  return html(lines([head, BLANK, ...blocks, hidden > 0 ? ital(`... and ${hidden} more`) : '', BLANK, tail]));
}

/** The manual-apply nudge, or null when nothing waits or the tables are unreadable (the digest must never fail on it). */
function manualLineOf(db: Db, env: NodeJS.ProcessEnv): string | null {
  try { return manualApplyLine(buildManualQueue(db, env)); } catch { return null; }
}

export async function runEscalationDigest(
  db: Db,
  d: { send: (text: string) => Promise<{ ok: boolean }>; now: Date; url: string | null; env?: NodeJS.ProcessEnv },
): Promise<DigestResult> {
  const lastAt = Date.parse(getState(db, KEY_LAST_AT) ?? '');
  if (Number.isFinite(lastAt) && d.now.getTime() - lastAt < ESCALATION_DIGEST_GAP_MS) return { sent: false, reason: 'too_soon' };
  const lastId = Number(getState(db, KEY_LAST_ID) ?? 0) || 0;
  // Escalations the LinkedIn inbox notice already announced (linkedinNotice.ts) are not announced again.
  const done = announcedEscalations(db);
  const fresh = listEscalations(db, { now: d.now, status: 'open' }).items.filter((i) => i.ids.some((id) => id > lastId && !done.has(id)));
  if (!fresh.length) return { sent: false, reason: 'nothing_new' };
  if (fresh.every((i) => i.group === 'noise')) return { sent: false, reason: 'only_flagged' };
  const rowCount = fresh.reduce((n, i) => n + i.ids.filter((id) => id > lastId && !done.has(id)).length, 0);
  // Recorded before the send so a failing Telegram is retried at most once per gap.
  setState(db, KEY_LAST_AT, d.now.toISOString(), d.now);
  const sent = await d.send(compose(fresh, rowCount, d.url, d.now, manualLineOf(db, d.env ?? process.env)));
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
      await runEscalationDigest(db, { send: (t) => tg.send(t, { topic: 'inbox', html: true, silent: false }), now: now(), url: dashboardInboxUrl(env) });
    } catch {
      // the digest is a convenience: a failure must never stop the scheduler
    }
  };
}
