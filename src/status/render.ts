// src/status/render.ts
import type { Snapshot } from './snapshot.js';
import type { LimitKey } from '../outreach/limits.js';

export interface WindowInfo {
  name: string;
  command: string;
  active: boolean;
}

const PERIOD: Record<LimitKey, string> = {
  linkedin_invite: 'day',
  linkedin_message: 'day',
  naukri_apply: 'day',
  naukri_message: 'day',
  wellfound_apply: 'day',
  wellfound_message: 'day',
  wellfound_discover: 'day',
  apply_attempt: 'day',
  site_account: 'day',
  linkedin_discover: 'day',
};

/** ISO instant to `YYYY-MM-DD HH:MM IST` (Asia/Kolkata); unparseable input is returned as is. */
export function formatIst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')} IST`;
}

function degradedLine(s: Snapshot): string[] {
  return s.degraded.length ? [`degraded: ${s.degraded.join(', ')}`] : [];
}

function haltLines(s: Snapshot): string[] {
  if (!s.halts.length) return ['no halts'];
  return s.halts.map((h) => `HALT ${h.platform}: ${h.reason} (since ${formatIst(h.setAt)})`);
}

export function renderLimits(s: Snapshot): string {
  const lines: string[] = [];
  for (const key of Object.keys(PERIOD) as LimitKey[]) {
    const c = s.ceilings[key];
    lines.push(`${key} ${c.used}/${c.limit} per ${PERIOD[key]}${c.ok ? '' : ' FULL'}`);
  }
  for (const d of s.dailyCounters) lines.push(`${d.key} ${d.count} today`);
  lines.push(...haltLines(s), ...degradedLine(s));
  return lines.join('\n');
}

export function renderWorking(s: Snapshot): string {
  const lines: string[] = [];
  if (!s.queue.length) lines.push('queue: empty');
  else for (const q of s.queue) lines.push(`queue ${q.status}: ${q.count}`);
  lines.push(s.lastSend ? `last send: ${s.lastSend.kind} ${formatIst(s.lastSend.at)}` : 'no sends yet');
  const f = s.funnel;
  lines.push(
    `discovered ${f.discovered} -> matched ${f.matched} -> contacted ${f.contacted} -> replied ${f.replied} -> interview ${f.interview} -> offer ${f.offer}`,
  );
  lines.push(...degradedLine(s));
  return lines.join('\n');
}

export function renderHealth(s: Snapshot, windows: WindowInfo[]): string {
  const lines: string[] = [];
  if (!windows.length) lines.push('tmux: no windows');
  else for (const w of windows) lines.push(`window ${w.name}: ${w.command || '-'}${w.active ? ' (active)' : ''}`);
  lines.push(...haltLines(s), ...degradedLine(s));
  lines.push('doctor: run npm run doctor');
  return lines.join('\n');
}
