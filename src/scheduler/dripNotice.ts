// src/scheduler/dripNotice.ts
// Code-sent Telegram notices of the wakes and the drip lanes (zero LLM). Every notice is Telegram HTML built with src/platform/tgHtml.ts:
// a bold headline with a status emoji, then label/value lines. Third-party text (company, job title, person name, subject) is cleaned
// (control characters removed, secret shapes redacted, bounded) and always escaped by the builders. Email addresses are shown in full:
// the Telegram chat is owner-only (private chat, numeric ALLOWED_USERS). Logs and debug files are not touched by this.
// A notice never throws and never waits longer than NOTICE_TIMEOUT_MS: a lane or a wake must not depend on Telegram.
import {
  E, b, bullets, clean, code, headline, html, i, join, line, lines, link, section, type Html,
} from '../platform/tgHtml.js';
import type { TopicName } from '../telegram/topics.js';
import type { WakeCounts } from './stream.js';

export interface PostOpts { html?: boolean }
export type TgPost = (topic: TopicName, text: string, opts?: PostOpts) => Promise<unknown>;
export interface HasTg { tg?: TgPost }

export const NOTICE_TIMEOUT_MS = 10_000;

/** Send one notice (HTML text from the builders below). Failures and slow sends are ignored. */
export async function notifyTg(d: HasTg, topic: TopicName, text: string, timeoutMs: number = NOTICE_TIMEOUT_MS): Promise<void> {
  const post = d.tg;
  if (!post) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => post(topic, text, { html: true })).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
    ]);
  } catch {
    // never fatal
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Third-party text for one value: one line, bounded, secret shapes redacted (the builders escape it). Kept for older callers. */
export function tidy(v: unknown, max = 80): string {
  return clean(v, max).replace(/[*_`\[\]]/g, '');
}

/** A full address as a mailto link; anything that is not address shaped is shown as plain cleaned text. */
function addr(a: string | null | undefined): Html | string {
  const t = clean(a, 120);
  if (!t) return '';
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(t) ? link(t, `mailto:${t}`) : t;
}

export interface MailNotice {
  kind: 'cold' | 'followup';
  company: string | null;
  title: string | null;
  address: string | null;
  subject?: string | null;
  dry: boolean;
}

export function formatMailNotice(n: MailNotice): string {
  const what = n.kind === 'followup' ? 'Follow-up' : 'Cold email';
  const job = join([clean(n.company, 60) && b(clean(n.company, 60)), clean(n.title, 80)], ' · ');
  return html(lines([
    n.dry ? headline(E.paused, `Dry run: ${what} not sent`) : headline(E.ok, `${what} sent`),
    line('To', addr(n.address)),
    line('Job', job.s ? job : 'unknown job'),
    line('Subject', clean(n.subject, 120) ? i(clean(n.subject, 120)) : ''),
    line('Result', n.dry ? i('nothing was sent (dry run)') : 'sent'),
  ]));
}

export function formatQuarantineNotice(rowId: number, jobId: string, why: string): string {
  return html(lines([
    headline(E.you, 'Mail held: check Gmail Sent'),
    line('Row', code(String(rowId))),
    line('Job', code(clean(jobId, 60))),
    line('Why', clean(why, 100)),
    i('The run ended without a recorded send. Check Gmail Sent before releasing the row.'),
  ]));
}

export interface LinkedinNotice {
  kind: string;
  name?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  profileUrl?: string | null;
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
  const label = LI_LABEL[n.kind] ?? clean(n.kind, 20);
  const nm = clean(n.name, 60);
  const person = nm ? (n.profileUrl ? link(nm, n.profileUrl) : nm) : '';
  const head = n.ok
    ? n.dry ? headline(E.paused, `Dry run: LinkedIn ${label} not sent`) : headline(E.ok, `LinkedIn ${label}`)
    : headline(E.warn, `LinkedIn ${label} did not end cleanly`);
  return html(lines([
    head,
    line('Person', person),
    line('Company', clean(n.company, 60)),
    line('Job', clean(n.jobTitle, 80)),
    line('Result', n.ok ? (n.dry ? i('nothing was sent (dry run)') : 'done') : clean(n.reason, 80) || 'failed'),
    n.ok ? '' : i('Check LinkedIn before this is repeated.'),
  ]));
}

export function formatDripFailure(lane: 'mail' | 'linkedin', what: string, reason: string | null | undefined): string {
  return html(lines([
    headline(E.fail, `${lane === 'mail' ? 'Mail' : 'LinkedIn'} drip run failed`),
    line('Item', code(clean(what, 40))),
    line('Reason', clean(reason, 100) || 'no reason recorded'),
  ]));
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
  /** Extra non-zero groups (all optional; a zero or missing value is not shown). */
  sources?: { ran: number; fetched: number; fresh: number; errors: number; fallbacks: number } | null;
  scored?: number | null;
  matched?: number | null;
  prepared?: number | null;
  emailsQueued?: number | null;
  connectsQueued?: number | null;
  appliesQueued?: number | null;
  followups?: number | null;
}

export const shortId = (id: string): string => id.slice(0, 8);

function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m}m ${Math.round(sec % 60)}s` : `${Math.round(sec)}s`;
}

const pos = (n: number | null | undefined): n is number => typeof n === 'number' && n > 0;

/** Topic and text (HTML) for a finished wake, or null when it should stay silent. */
export function wakeNotice(n: WakeNotice): { topic: TopicName; text: string } | null {
  const id = code(shortId(n.runId));
  const dryTag = n.dry ? i('dry run') : '';
  if (n.status === 'skipped') {
    const skip = (n.reason ?? '').split(':')[0] ?? '';
    if (!NOTIFY_SKIPS.has(skip)) return null;
    return {
      topic: 'wakes',
      text: html(lines([
        headline(E.paused, 'Wake skipped'),
        line('Run', id), line('Trigger', n.trigger), line('Reason', code(skip)), dryTag,
      ])),
    };
  }
  if (ALERT_STATUSES.has(n.status)) {
    return {
      topic: 'alerts',
      text: html(lines([
        headline(E.fail, `Wake ${n.status.replace(/_/g, ' ')}`),
        line('Run', id), line('Trigger', n.trigger), line('Reason', clean(n.reason, 160) || 'no reason recorded'), dryTag,
      ])),
    };
  }
  const ok = n.status === 'ok';
  const dur = duration(n.durationSec);
  const out: Array<Html | string> = [
    headline(ok ? E.ok : E.warn, `Wake ${n.status.replace(/_/g, ' ')}`),
    join([line('Run', id), line('Trigger', n.trigger), dur && line('Time', dur), dryTag], '  '),
  ];
  const s = n.sources;
  if (s && s.ran > 0) {
    out.push(section('Sources', [bullets([
      `${s.ran} ran, fetched ${s.fetched}, new ${s.fresh}`,
      s.errors > 0 && `errors ${s.errors}`,
      s.fallbacks > 0 && `fallback ${s.fallbacks}`,
    ])]));
  }
  const matches = [pos(n.newJobs) && `new jobs ${n.newJobs}`, pos(n.scored) && `scored ${n.scored}`, pos(n.matched) && `matched ${n.matched}`];
  if (matches.some(Boolean)) out.push(section('Matches', [bullets(matches)]));
  if (pos(n.prepared)) out.push(section('Prepared', [bullets([`${n.prepared} job${n.prepared === 1 ? '' : 's'} ready for outreach`])]));
  if (pos(n.emailsQueued)) out.push(section('Emails queued', [bullets([`${n.emailsQueued} (the mail drip sends them)`])]));
  if (pos(n.connectsQueued)) out.push(section('Connects', [bullets([`${n.connectsQueued} queued`])]));
  if (pos(n.appliesQueued)) out.push(section('Applies', [bullets([`${n.appliesQueued} queued`])]));
  if (pos(n.followups)) out.push(section('Follow-ups', [bullets([`${n.followups} drafted`])]));
  if (pos(n.queued) && !pos(n.emailsQueued) && !pos(n.connectsQueued) && !pos(n.appliesQueued)) {
    out.push(section('Outreach', [bullets([`queued ${n.queued}`])]));
  }
  if (n.counts) {
    const c = n.counts;
    out.push(section('Operators', [bullets([`done ${c.done}, skipped ${c.skipped}`])]));
    const problems = [c.escalated > 0 && `escalated ${c.escalated}`, c.stopped > 0 && `stopped ${c.stopped}`, s && s.errors > 0 && `source errors ${s.errors}`];
    if (problems.some(Boolean)) out.push(section('Problems', [bullets(problems)]));
  } else if (s && s.errors > 0) {
    out.push(section('Problems', [bullets([`source errors ${s.errors}`])]));
  }
  return { topic: 'wakes', text: html(lines(out)) };
}
