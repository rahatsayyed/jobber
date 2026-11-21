// src/heal/notice.ts
// One short Telegram line (HTML built with src/platform/tgHtml.ts, everything escaped) per heal state change, sent to the `alerts` topic
// from code. A notice never throws and never blocks a heal: a missing Telegram setup just returns.
import { E, clean, code, headline, html, join, lines, line, type Html } from '../platform/tgHtml.js';

export type NoticeKind = 'started' | 'ready' | 'landed' | 'postponed' | 'rolled_back' | 'gave_up' | 'stable' | 'manual_restart' | 'error';

export interface HealNotice {
  kind: NoticeKind;
  signature: string;
  ledgerId: number;
  /** Short detail (branch, reason, counts). Cleaned and bounded here. */
  detail?: string;
  /** For `ready`: the exact command the owner runs. */
  command?: string;
}

const HEAD: Record<NoticeKind, [string, string]> = {
  started: [E.paused, 'Heal started'],
  ready: [E.you, 'Fix ready'],
  landed: [E.ok, 'Fix landed'],
  postponed: [E.paused, 'Restart postponed'],
  rolled_back: [E.warn, 'Fix rolled back'],
  gave_up: [E.warn, 'Heal gave up'],
  stable: [E.ok, 'Fix stable'],
  manual_restart: [E.you, 'Restart needed'],
  error: [E.fail, 'Heal error'],
};

/** The Telegram HTML text of one notice. */
export function composeNotice(n: HealNotice): string {
  const [emoji, title] = HEAD[n.kind];
  const body: Html[] = [headline(emoji, `${title}: `, code(clean(n.signature, 80)))];
  const d = clean(n.detail ?? '', 220);
  if (d) body.push(line('Detail', d));
  if (n.command) body.push(join(['Run:', code(clean(n.command, 80))]));
  return html(lines([...body, line('Id', code(String(n.ledgerId)))]));
}

/** `ready`, `rolled_back`, `gave_up`, `manual_restart` and `error` ask for the owner (loud); the rest are routine (silent). */
export const isLoud = (k: NoticeKind): boolean => k === 'ready' || k === 'rolled_back' || k === 'gave_up' || k === 'manual_restart' || k === 'error';

export type AlertFn = (text: string, opts?: { silent?: boolean }) => Promise<unknown>;

export async function sendNotice(alert: AlertFn | undefined, n: HealNotice): Promise<void> {
  if (!alert) return;
  try {
    await alert(composeNotice(n), { silent: !isLoud(n.kind) });
  } catch { /* a notice never breaks a heal */ }
}
