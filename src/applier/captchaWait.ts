// Owner-solve wait for a CAPTCHA (owner decision 2026-11-08, Safety rule 17). When a page read shows a captcha, CODE (never the model, and
// no tool the model can call) waits up to APPLY_CAPTCHA_WAIT_SEC seconds so the OWNER can solve it by hand in the open browser, re-reads
// the page and goes on only if the captcha is gone. The agent never clicks, types into or solves it. Nothing else is waited for:
// MFA, phone or email verification, bot walls and login walls are parked at once as before.
import type BetterSqlite3 from 'better-sqlite3';
import { detectBlock } from '../webcore/blocks.js';
import { extractFormModel, type FormModel, type RawFormSnapshot } from '../webcore/formModel.js';
import { readPage } from '../webcore/login.js';
import type { LiPage } from '../linkedin/types.js';
import { telegramNotifier } from '../platform/notify.js';
import { E, clean, headline, html, i as ital, line, lines } from '../platform/tgHtml.js';
import { isDryRun } from '../safety/dryRun.js';
import { getState, setState } from '../scheduler/runLog.js';
import type { AssistNotifier } from './assistPing.js';

type Db = BetterSqlite3.Database;

export const CAPTCHA_WAIT_DEFAULT_SEC = 25;
export const CAPTCHA_WAIT_MAX_SEC = 60;
export const CAPTCHA_POLL_MS = 3000;
/** One "solve it now" notice per host per 5 minutes (scheduler_state key `captcha_wait_ping:<host>`). */
export const CAPTCHA_NOTICE_GAP_MS = 5 * 60_000;

/** APPLY_CAPTCHA_WAIT_SEC: whole seconds, clamp 0..60, blank or invalid -> 25, 0 = off. */
export function captchaWaitSec(env: NodeJS.ProcessEnv): number {
  const raw = (env.APPLY_CAPTCHA_WAIT_SEC ?? '').trim();
  if (!/^\d+$/.test(raw)) return CAPTCHA_WAIT_DEFAULT_SEC;
  return Math.min(CAPTCHA_WAIT_MAX_SEC, Math.max(0, Number(raw)));
}

export type CaptchaWaitResult = 'cleared' | 'still_there' | 'page_changed';
export interface PageSnap { raw: RawFormSnapshot; model: FormModel }

/**
 * Is the captcha gone in this fresh snapshot? Returns the snapshot to go on with, or null.
 * Gone = no block at all (so no widget and no captcha wording). A response token that is now filled counts only when the page
 * has no other block once the widget is ignored; the returned snapshot then has the widget flag dropped.
 */
export function clearedSnapshot(s: PageSnap): PageSnap | null {
  if (s.model.block === null) return s;
  if (s.model.block === 'captcha' && s.raw.captchaWidget && s.raw.captchaSolved) {
    const raw: RawFormSnapshot = { ...s.raw, captchaWidget: false };
    if (detectBlock(raw) === null) return { raw, model: extractFormModel(raw) };
  }
  return null;
}

export interface WaitOpts {
  /** A FRESH page read each call. */
  snapshot: () => Promise<PageSnap>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  waitSec: number;
  /** Host of the apply page the captcha was seen on. */
  host: string;
  /** True when the kill switch or a halt turned on: stop waiting. */
  abort?: () => boolean;
  /** Receives the snapshot to continue with when the result is 'cleared'. */
  onCleared?: (s: PageSnap) => void;
}

/** Polls a fresh snapshot every 3 seconds up to the limit. Never throws. */
export async function waitForCaptchaCleared(o: WaitOpts): Promise<CaptchaWaitResult> {
  const deadline = o.now() + Math.max(0, o.waitSec) * 1000;
  while (o.now() < deadline) {
    await o.sleep(Math.max(0, Math.min(CAPTCHA_POLL_MS, deadline - o.now())));
    if (o.abort?.()) return 'still_there';
    let snap: PageSnap;
    try { snap = await o.snapshot(); } catch { return 'still_there'; }
    if (snap.model.host !== o.host) return 'page_changed';
    const ok = clearedSnapshot(snap);
    if (ok) { o.onCleared?.(ok); return 'cleared'; }
  }
  return 'still_there';
}

/** The `assist` topic sender (same topic as the apply:assist ping). */
export function captchaTelegram(env: NodeJS.ProcessEnv): AssistNotifier {
  const tg = telegramNotifier(env);
  return { send: (text) => tg.send(text, { topic: 'assist', html: true, silent: false }) };
}

/** One notice when the wait starts: host and job title only (escaped), no page text. Throttled per host; none in a dry run. */
export async function noticeCaptchaWait(
  db: Db,
  p: { host: string; jobId: string; waitSec: number; notifier: AssistNotifier; now: Date; env: NodeJS.ProcessEnv },
): Promise<'sent' | 'deduped' | 'dry_run' | 'send_failed'> {
  if (isDryRun(p.env)) return 'dry_run';
  const key = `captcha_wait_ping:${p.host.toLowerCase().slice(0, 200)}`;
  const last = Date.parse(getState(db, key) ?? '');
  if (Number.isFinite(last) && p.now.getTime() - last < CAPTCHA_NOTICE_GAP_MS) return 'deduped';
  const job = db.prepare('SELECT title FROM jobs WHERE id = ?').get(p.jobId) as { title: string | null } | undefined;
  const text = html(lines([
    headline(E.you, `Solve the captcha on ${clean(p.host, 80)}`),
    line('Job', clean(job?.title ?? '', 80) || clean(p.jobId, 100)),
    line('Time', `${p.waitSec} seconds`),
    ital('Solve it in the open browser now. Jobber looks at the page again after that.'),
  ]));
  try {
    const res = await p.notifier.send(text);
    if (!res.ok) return 'send_failed';
  } catch {
    return 'send_failed';
  }
  setState(db, key, p.now.toISOString(), p.now);
  return 'sent';
}

export interface CaptchaReadCtx {
  env: NodeJS.ProcessEnv;
  jobId: string;
  /** Kill switch or halt is on. */
  stopped: () => boolean;
  /** Sends the one notice; a failure is swallowed. */
  notify: (host: string, waitSec: number) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * readPage, plus the owner-solve wait. Without a captcha, with APPLY_CAPTCHA_WAIT_SEC=0, in a dry run or while stopped, this IS readPage
 * (byte-identical behaviour). With a captcha it waits; on 'cleared' it returns the fresh read, otherwise the ORIGINAL read, so the caller
 * parks the job exactly as before.
 */
export async function readPageWaitingForCaptcha(page: LiPage, c: CaptchaReadCtx): Promise<PageSnap> {
  const first = await readPage(page);
  if (first.model.block !== 'captcha') return first;
  const sec = captchaWaitSec(c.env);
  if (sec <= 0 || isDryRun(c.env) || c.stopped()) return first;
  try { await c.notify(first.model.host, sec); } catch { /* the wait itself still happens */ }
  let cleared: PageSnap | null = null;
  const res = await waitForCaptchaCleared({
    snapshot: () => readPage(page),
    sleep: c.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: c.now ?? Date.now,
    waitSec: sec,
    host: first.model.host,
    abort: c.stopped,
    onCleared: (s) => { cleared = s; },
  });
  return res === 'cleared' && cleared ? cleared : first;
}
