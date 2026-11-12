// src/status/escalations.ts
// Plain-text lines for the owner's open escalations, shared by `status escalations` (/escalations) and the Telegram digest.
// Every field is untrusted model or third-party text: cleanUntrusted makes it one bounded line without angle brackets or control characters.
import { cleanUntrusted } from '../manual/report.js';
import type { EscCounts, EscItem } from '../outreach/escalations.js';
import { SEVERITY_LABELS, SEVERITY_ORDER, severityCounts, severityOf, severitySummary, sortBySeverity } from './severity.js';

export const STATUS_MAX_ITEMS = 30;

export function ageText(iso: string, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(min)) return '?';
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 1440)}d ago`;
}

/** One escalation as a single line: `#id xN platform reason | person (company) | job | age`. */
export function itemLine(i: EscItem, now: Date): string {
  const who = i.senderName
    ? `${cleanUntrusted(i.senderName, 60)}${i.senderHeadline ? ` (${cleanUntrusted(i.senderHeadline, 60)})` : ''}`
    : null;
  // Platform problems and flagged rows also show the reason code; real replies show the plain label only.
  const label = i.group === 'human' ? i.label : `${i.label}: ${cleanUntrusted(i.reason, 70)}`;
  const parts = [
    `#${i.id}${i.updates > 1 ? ` x${i.updates}` : ''} ${i.platform ?? '-'} ${label}`,
    who, i.jobTitle ? cleanUntrusted(i.jobTitle, 70) : null, ageText(i.last_at, now),
  ];
  return parts.filter(Boolean).join(' | ');
}

/** Item line plus an indented detail line and, for a merged item, the ids the owner can mark handled together. */
export function itemBlock(i: EscItem, now: Date, detailMax = 140): string[] {
  const out = [itemLine(i, now)];
  // The raw flagged text (rawText) is never shown here.
  if (i.excerpt) out.push(`    "${cleanUntrusted(i.excerpt, detailMax)}"`);
  else if (i.detail) out.push(`    ${cleanUntrusted(i.detail, detailMax)}`);
  // A reply card says who acts: nobody, the agent (its own reply is drafted or sent) or you. The line is built in code (src/outreach/escalations.ts).
  if (i.group === 'human' && i.platform !== 'apply' && i.todo) out.push(`    next: ${i.todo}`);
  // A paused application: the exact questions, each with the command that answers it (--always keeps the answer for every later form).
  for (const q of i.questions.slice(0, 8)) {
    const opts = q.options.length ? ` [${q.options.slice(0, 6).map((o) => cleanUntrusted(o, 30)).join(' | ')}]` : '';
    const lim = q.maxLength ? ` max ${q.maxLength} chars` : '';
    out.push(`    question #${q.id} (${q.kind}${q.jobIds.length > 1 ? `, ${q.jobIds.length} jobs` : ''}): "${cleanUntrusted(q.label, 140)}"${opts}${lim}`);
    if (q.jobTitle) out.push(`      job: ${cleanUntrusted(q.jobTitle, 100)}${q.applyUrl ? ` | ${q.applyUrl}` : ''}`);
    out.push(`      answer in the dashboard Inbox tab, or: npm run answers -- answer ${q.id} "<text>" [--always] [--comment "..."]`);
    if (q.agentCommand) out.push(`      or let the agent write it: ${q.agentCommand}`);
  }
  if (i.questions.length > 8) out.push(`    ... and ${i.questions.length - 8} more: npm run answers -- list`);
  if (i.assistCommand) out.push(`    run: ${i.assistCommand}`);
  if (i.count > 1) out.push(`    ids ${[...i.ids].sort((a, b) => a - b).join(',')}`);
  return out;
}

export function renderEscalations(items: EscItem[], counts: EscCounts, now: Date, extraLines: string[] = []): string {
  if (!items.length) {
    return [`No open escalations.${counts.snoozed ? ` (${counts.snoozed} snoozed)` : ''}`, ...extraLines].join('\n');
  }
  const lines = [`Escalations: ${counts.open} open${counts.snoozed ? `, ${counts.snoozed} snoozed (hidden)` : ''}. The agent replies by itself to safe asks (see the "next:" line); where a card asks you, answer on the platform itself. Mark items handled in the dashboard Inbox tab.`];
  const nq = items.reduce((n, i) => n + i.questions.length, 0);
  if (nq > 0) lines.push(`${nq} question${nq === 1 ? '' : 's'} need your answer (applications are paused until you answer): npm run answers -- list`);
  // The same ranking as the dashboard and the Telegram digest (src/status/severity.ts): severity, then the one waiting longest first.
  lines.push(`${severitySummary(severityCounts(items))}. CRITICAL = needs you now, ACTION = you can unblock work, INFO = noise and counts.`);
  const ranked = sortBySeverity(items);
  let shown = 0;
  for (const sev of SEVERITY_ORDER) {
    const inSev = ranked.filter((i) => severityOf(i).severity === sev);
    if (!inSev.length) continue;
    lines.push('', `== ${SEVERITY_LABELS[sev]} (${inSev.length}) ==`);
    for (const i of inSev) {
      if (shown >= STATUS_MAX_ITEMS) break;
      lines.push(...itemBlock(i, now), `    ${severityOf(i).hint}`);
      shown += 1;
    }
  }
  if (items.length > shown) lines.push('', `... and ${items.length - shown} more (see the dashboard Inbox tab)`);
  if (extraLines.length) lines.push('', ...extraLines);
  return lines.join('\n');
}
