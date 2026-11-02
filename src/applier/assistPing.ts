// The Telegram ping for a job parked as `needs_human` (a login wall, sign-up, CAPTCHA or MFA only a person can pass). Composed in code from
// stored facts (host, job title and company, the exact command): the model writes none of it and nothing from the page is run or followed.
// One ping per host per 6 hours (scheduler_state key `assist_ping:<host>`); none in a dry run. The existing escalation card stays.
// A page screenshot is attached ONLY when the notifier can send an image (the shipped Telegram sender is text only, so it is skipped);
// a failing screenshot never blocks the park or the text.
import type BetterSqlite3 from 'better-sqlite3';
import { cleanUntrusted } from '../manual/report.js';
import { isDryRun } from '../safety/dryRun.js';
import { getState, setState } from '../scheduler/runLog.js';

type Db = BetterSqlite3.Database;

export const ASSIST_PING_GAP_MS = 6 * 3600_000;

export interface AssistNotifier {
  send(text: string): Promise<{ ok: boolean; detail: string }>;
  /** Optional. The shipped sender has none. */
  sendPhoto?(png: Buffer, caption: string): Promise<{ ok: boolean; detail: string }>;
}

export type PingResult = 'sent' | 'deduped' | 'dry_run' | 'send_failed';

export async function pingAssist(
  db: Db,
  p: { host: string; jobId: string; reason: string; notifier: AssistNotifier; now: Date; env: NodeJS.ProcessEnv; screenshot?: () => Promise<Buffer | Uint8Array | null> },
): Promise<PingResult> {
  if (isDryRun(p.env)) return 'dry_run';
  const key = `assist_ping:${p.host.toLowerCase().slice(0, 200)}`;
  const last = Date.parse(getState(db, key) ?? '');
  if (Number.isFinite(last) && p.now.getTime() - last < ASSIST_PING_GAP_MS) return 'deduped';
  const job = db.prepare('SELECT title, company FROM jobs WHERE id = ?').get(p.jobId) as { title: string | null; company: string | null } | undefined;
  const what = [cleanUntrusted(job?.title ?? '', 80), cleanUntrusted(job?.company ?? '', 60)].filter(Boolean).join(' at ') || p.jobId;
  const text = [
    `Jobber needs you on ${cleanUntrusted(p.host, 80)} (${cleanUntrusted(p.reason, 30)}).`,
    `Parked: ${what}. Other jobs on this site wait too.`,
    `Run: npm run apply:assist -- ${cleanUntrusted(p.jobId, 100)}`,
    'It opens the page in Chrome; log in or finish the check by hand, press Enter, and the job retries.',
  ].join('\n');
  let res: { ok: boolean; detail: string };
  try {
    let png: Buffer | Uint8Array | null = null;
    if (p.notifier.sendPhoto && p.screenshot) {
      try { png = await p.screenshot(); } catch { png = null; }
    }
    res = png && p.notifier.sendPhoto ? await p.notifier.sendPhoto(Buffer.from(png), text) : await p.notifier.send(text);
  } catch {
    return 'send_failed';
  }
  if (!res.ok) return 'send_failed';
  setState(db, key, p.now.toISOString(), p.now);
  return 'sent';
}
