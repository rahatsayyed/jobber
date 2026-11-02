// src/status/render.ts
import { manualApplyLine } from '../manual/manualApply.js';
import type { Snapshot } from './snapshot.js';
import type { LimitKey } from '../outreach/limits.js';
import { inActiveHours, loadActiveHours } from '../linkedin/activeHours.js';

export interface WindowInfo {
  name: string;
  command: string;
  active: boolean;
}

const PERIOD: Record<LimitKey, string> = {
  linkedin_invite: 'day',
  linkedin_message: 'day',
  linkedin_easy_apply: 'day',
  naukri_apply: 'day',
  naukri_message: 'day',
  wellfound_apply: 'day',
  wellfound_message: 'day',
  wellfound_discover: 'day',
  apply_attempt: 'day',
  site_account: 'day',
  linkedin_discover: 'day',
  external_resolve: 'day',
  linkedin_profile_view: 'day',
  naukri_jd_fetch: 'day',
  linkedin_jd_fetch: 'day',
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

export function renderLimits(s: Snapshot, opts: { env?: NodeJS.ProcessEnv; now?: Date } = {}): string {
  const lines: string[] = [];
  if (opts.env) {
    const h = loadActiveHours(opts.env);
    const hm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const now = opts.now ?? new Date();
    lines.push(`linkedin active hours ${hm(h.startMin)}-${hm(h.endMin)} IST (${inActiveHours(now, h) ? 'open now' : 'closed now, no LinkedIn work'})${h.problem ? ` WARNING: ${h.problem}` : ''}`);
  }
  if (opts.env) {
    lines.push(opts.env.APPLY_LINKEDIN_EASY === 'true'
      ? 'linkedin easy apply: ON (APPLY_LINKEDIN_EASY=true): one application per LinkedIn drip tick, main account'
      : 'linkedin easy apply: off (APPLY_LINKEDIN_EASY): you apply by hand, see npm run apply:manual -- list');
  }
  for (const key of Object.keys(PERIOD) as LimitKey[]) {
    const c = s.ceilings[key];
    lines.push(`${key} ${c.used}/${c.limit} per ${PERIOD[key]}${c.ok ? '' : ' FULL'}`);
  }
  for (const d of s.dailyCounters) lines.push(`${d.key} ${d.count} today`);
  if (s.jd) lines.push(`job descriptions fetched in the last 24 hours: ${s.jd.fetched24h} (fetch ceilings above: naukri_jd_fetch, linkedin_jd_fetch)`);
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
  if (s.jd && (s.jd.waiting > 0 || s.jd.fetched24h > 0 || s.jd.unavailable > 0)) {
    lines.push(`job descriptions: waiting ${s.jd.waiting} (jd_pending ${s.jd.pending}), fetched in 24h ${s.jd.fetched24h}, unavailable ${s.jd.unavailable}; a job is matched only after its description is read`);
  }
  if (s.openQuestions.count > 0) lines.push(`needs your answer: ${s.openQuestions.count} question(s) pause applications (npm run answers -- list)`);
  for (const h of s.needsHuman.hosts) lines.push(`needs you: ${h.jobs} job(s) wait at ${h.host} for a login or human check (${h.command})`);
  const manual = s.manualApply ? manualApplyLine(s.manualApply) : null;
  if (manual) lines.push(manual);
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
