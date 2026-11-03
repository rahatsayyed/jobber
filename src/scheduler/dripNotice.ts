// src/scheduler/dripNotice.ts
// Code-sent Telegram notices of the wakes and the drip lanes (zero LLM). Text is markdown for src/telegram/format.ts, which HTML-escapes
// everything. Third-party text (company, job title, person name) is also stripped of markdown marks here so it can not change the layout.
// A notice never throws and never waits longer than NOTICE_TIMEOUT_MS: a lane or a wake must not depend on Telegram.
import type { TopicName } from '../telegram/topics.js';
import type { WakeCounts } from './stream.js';

export type TgPost = (topic: TopicName, markdown: string) => Promise<unknown>;
export interface HasTg { tg?: TgPost }

export const NOTICE_TIMEOUT_MS = 10_000;

/** Send one notice. Failures and slow sends are ignored. */
export async function notifyTg(d: HasTg, topic: TopicName, markdown: string, timeoutMs: number = NOTICE_TIMEOUT_MS): Promise<void> {
  const post = d.tg;
  if (!post) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => post(topic, markdown)).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
    ]);
  } catch {
    // never fatal
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Third-party text for one line: one line, no markdown marks, bounded. The format layer escapes the rest. */
export function tidy(v: unknown, max = 80): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[*_`\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}~` : s;
}

/** j***@domain: first character of the local part, the domain in full. Not an address: a placeholder. */
export function maskAddress(addr: string | null | undefined): string {
  const a = String(addr ?? '').trim();
  const at = a.lastIndexOf('@');
  if (at < 1) return '***';
  const local = a.slice(0, at);
  const domain = a.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, '').slice(0, 80);
  return `${tidy(local.slice(0, 1), 1) || '*'}***@${domain || '***'}`;
}

export interface MailNotice {
  kind: 'cold' | 'followup';
  company: string | null;
  title: string | null;
  address: string | null;
  dry: boolean;
}

export function formatMailNotice(n: MailNotice): string {
  const what = n.kind === 'followup' ? 'follow-up' : 'cold email';
  const who = [tidy(n.company, 60), tidy(n.title, 80)].filter(Boolean).join(', ') || 'unknown job';
  const to = maskAddress(n.address);
  return n.dry
    ? `dry run: would send ${what} to ${who} (${to}); nothing was sent`
    : `Mail sent: ${what} to ${who} (${to})`;
}

export function formatQuarantineNotice(rowId: number, jobId: string, why: string): string {
  return `Mail drip: row ${rowId} (job ${tidy(jobId, 60)}) is held, the run ended without a recorded send (${tidy(why, 80)}). Check Gmail Sent before releasing it.`;
}

export interface LinkedinNotice {
  kind: string;
  name?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  dry: boolean;
  ok: boolean;
  reason?: string | null;
}

const LI_LABEL: Record<string, string> = {
  invite: 'invite', dm: 'DM', reply: 'reply', accept_recent: 'accept check', accept_check: 'accept check', inbox: 'inbox read', easy_apply: 'Easy Apply',
};

/** Kinds that get a notice at all (a job description read is background work). */
export function linkedinNoticeKind(kind: string): boolean {
  return kind in LI_LABEL;
}

export function formatLinkedinNotice(n: LinkedinNotice): string {
  const label = LI_LABEL[n.kind] ?? tidy(n.kind, 20);
  const who = [tidy(n.name, 60), tidy(n.company, 60)].filter(Boolean).join(', ');
  const tail = who ? `: ${who}` : '';
  if (!n.ok) return `LinkedIn ${label} run did not end cleanly${tail} (${tidy(n.reason, 80) || 'failed'}). Check LinkedIn before this is repeated.`;
  return n.dry ? `dry run: LinkedIn ${label}${tail}; nothing was sent` : `LinkedIn ${label}${tail}`;
}

export function formatDripFailure(lane: 'mail' | 'linkedin', what: string, reason: string | null | undefined): string {
  return `${lane === 'mail' ? 'Mail' : 'LinkedIn'} drip run failed (${tidy(what, 40)}): ${tidy(reason, 100) || 'no reason recorded'}`;
}

// ---- wakes ----

/** Skip reasons that are worth one message. quiet_hours and nothing_due are normal and stay silent. */
export const NOTIFY_SKIPS: ReadonlySet<string> = new Set(['killed', 'halted', 'ceilings_exhausted']);
/** Run statuses that go to `alerts` instead of `wakes`. */
export const ALERT_STATUSES: ReadonlySet<string> = new Set(['failed', 'crashed', 'budget_exceeded', 'usage_limit', 'incomplete']);

export interface WakeNotice {
  runId: string;
  trigger: string;
  status: string;
  reason?: string | null;
  durationSec?: number | null;
  counts?: WakeCounts | null;
  newJobs?: number | null;
  queued?: number | null;
  dry?: boolean;
}

export const shortId = (id: string): string => id.slice(0, 8);

function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m}m ${Math.round(sec % 60)}s` : `${Math.round(sec)}s`;
}

/** Topic and text for a finished wake, or null when it should stay silent. */
export function wakeNotice(n: WakeNotice): { topic: TopicName; text: string } | null {
  const id = shortId(n.runId);
  if (n.status === 'skipped') {
    const code = (n.reason ?? '').split(':')[0] ?? '';
    if (!NOTIFY_SKIPS.has(code)) return null;
    return { topic: 'wakes', text: `Wake ${id} skipped (${n.trigger}): ${code}${n.dry ? ' [dry run]' : ''}` };
  }
  if (ALERT_STATUSES.has(n.status)) {
    return { topic: 'alerts', text: `Wake ${id} ${n.status} (${n.trigger}): ${tidy(n.reason, 160) || 'no reason recorded'}${n.dry ? ' [dry run]' : ''}` };
  }
  const parts = [`Wake ${id} ${n.status} (${n.trigger})`];
  const dur = duration(n.durationSec);
  if (dur) parts.push(dur);
  if (n.dry) parts.push('dry run');
  const lines = [parts.join(', ')];
  if (n.counts) {
    const c = n.counts;
    lines.push(`operators: done ${c.done}, skipped ${c.skipped}, escalated ${c.escalated}, stopped ${c.stopped}`);
  }
  const extra: string[] = [];
  if (typeof n.newJobs === 'number') extra.push(`new jobs ${n.newJobs}`);
  if (typeof n.queued === 'number') extra.push(`queued outreach ${n.queued}`);
  if (extra.length) lines.push(extra.join(', '));
  return { topic: 'wakes', text: lines.join('\n') };
}
