// src/status/escalations.ts
// Plain-text lines for the owner's open escalations, shared by `status escalations` (/escalations) and the Telegram digest.
// Every field is untrusted model or third-party text: cleanUntrusted makes it one bounded line without angle brackets or control characters.
import { cleanUntrusted } from '../manual/report.js';
import { GROUP_LABELS, GROUP_ORDER, type EscCounts, type EscItem } from '../outreach/escalations.js';

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
  if (i.count > 1) out.push(`    ids ${[...i.ids].sort((a, b) => a - b).join(',')}`);
  return out;
}

export function renderEscalations(items: EscItem[], counts: EscCounts, now: Date): string {
  if (!items.length) {
    return `No open escalations.${counts.snoozed ? ` (${counts.snoozed} snoozed)` : ''}`;
  }
  const lines = [`Escalations: ${counts.open} open${counts.snoozed ? `, ${counts.snoozed} snoozed (hidden)` : ''}. Answer on the platform itself; mark them handled in the dashboard Inbox tab.`];
  let shown = 0;
  for (const g of GROUP_ORDER) {
    const inGroup = items.filter((i) => i.group === g);
    if (!inGroup.length) continue;
    lines.push('', `== ${GROUP_LABELS[g]} (${inGroup.length}) ==`);
    for (const i of inGroup) {
      if (shown >= STATUS_MAX_ITEMS) break;
      lines.push(...itemBlock(i, now));
      shown += 1;
    }
  }
  if (items.length > shown) lines.push('', `... and ${items.length - shown} more (see the dashboard Inbox tab)`);
  return lines.join('\n');
}
