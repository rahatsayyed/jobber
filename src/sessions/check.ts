// Read-only session checks behind `npm run linkedin:check` and `npm run naukri:check`.
// Load one logged-in page headless with the saved session and report one line: `OK session valid` or
// `FAIL <reason>`. No clicks, no sends, no halts written and the session file is never re-saved.
// Cookie values are never read into a result; only cookie NAMES are looked at.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { dbPath } from '../dbPath.js';
import { haltReason } from '../outreach/limits.js';
import { launchRealChrome, LINKEDIN_CONTEXT_OPTIONS, HEADLESS_CONTEXT_OPTIONS } from '../linkedin/browser.js';
import { acquireLock, checkSessionFile, DEFAULT_LOCK_PATH, DEFAULT_SESSION_PATH } from '../linkedin/session.js';
import { SNAPSHOT_SRC } from '../linkedin/snapshot.js';
import { detectBlock } from '../linkedin/state.js';
import type { LiBrowser, LiLauncher, RawSnapshot } from '../linkedin/types.js';

export interface CheckOutcome { ok: boolean; line: string }

export interface CheckDeps {
  launcher?: LiLauncher;
  sessionPath?: string;
  lockPath?: string;
  now?: () => Date;
  /** Active halt reason for the platform, or null. Defaults to a read-only look at the database. */
  halted?: () => string | null;
  settleMs?: number;
  maxAgeDays?: number;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NAUKRI_SESSION_PATH = path.join(ROOT, 'secrets', 'naukri-state.json');
export const LINKEDIN_FEED_URL = 'https://www.linkedin.com/feed/';
export const NAUKRI_HOME_URL = 'https://www.naukri.com/mnjuser/homepage';

const ok = (): CheckOutcome => ({ ok: true, line: 'OK session valid' });
const fail = (reason: string): CheckOutcome => ({ ok: false, line: `FAIL ${reason}` });

/** Read-only halt lookup: opens an existing database readonly, never creates or migrates one. */
export function readOnlyHalt(platform: 'linkedin' | 'naukri'): () => string | null {
  return () => {
    const p = dbPath();
    if (p === ':memory:' || !existsSync(p)) return null;
    let db: Database.Database | undefined;
    try {
      db = new Database(p, { readonly: true, fileMustExist: true });
      return haltReason(db, platform);
    } catch {
      return null;
    } finally {
      db?.close();
    }
  };
}

function linkedinFileReason(reason: string | undefined): string {
  if (!reason) return 'session_invalid';
  if (reason.includes('missing')) return 'session_missing';
  if (reason.startsWith('session older')) return 'session_stale';
  return 'session_invalid';
}

function naukriFileProblem(p: string, now: Date, maxAgeDays: number): string | null {
  let st;
  try { st = lstatSync(p); } catch { return 'session_missing'; }
  if (!st.isFile() || st.size === 0 || st.size > 2 * 1024 * 1024) return 'session_invalid';
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return 'session_invalid';
  let cookies: unknown;
  try { cookies = (JSON.parse(readFileSync(p, 'utf8')) as { cookies?: unknown }).cookies; } catch { return 'session_invalid'; }
  const hasAuth = Array.isArray(cookies) && cookies.some((c) => {
    const n = (c as { name?: unknown } | null)?.name;
    return typeof n === 'string' && n.toLowerCase().startsWith('nauk');
  });
  if (!hasAuth) return 'session_invalid';
  if ((now.getTime() - st.mtimeMs) / 86_400_000 > maxAgeDays) return 'session_stale';
  return null;
}

async function launch(launcher: LiLauncher | undefined): Promise<LiBrowser | null> {
  try { return await launchRealChrome({ launcher }); } catch { return null; }
}

export async function checkLinkedinSession(deps: CheckDeps = {}): Promise<CheckOutcome> {
  const sessionPath = deps.sessionPath ?? DEFAULT_SESSION_PATH;
  const chk = checkSessionFile(sessionPath, { now: (deps.now ?? (() => new Date()))(), maxAgeDays: deps.maxAgeDays });
  if (!chk.ok) return fail(linkedinFileReason(chk.reason));
  if (deps.halted?.()) return fail('halted');
  const lock = acquireLock(deps.lockPath ?? DEFAULT_LOCK_PATH);
  if (!lock.ok) return fail('session_locked');
  const browser = await launch(deps.launcher);
  if (!browser) { lock.handle.release(); return fail('chrome_unavailable'); }
  try {
    const context = await browser.newContext({ ...LINKEDIN_CONTEXT_OPTIONS, storageState: sessionPath });
    const page = await context.newPage();
    await page.goto(LINKEDIN_FEED_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(deps.settleMs ?? 2500);
    const snap = await page.evaluate<RawSnapshot>(SNAPSHOT_SRC);
    const block = detectBlock(snap);
    if (block === 'captcha') return fail('captcha');
    if (block === 'checkpoint') return fail('checkpoint');
    if (block === 'restriction') return fail('blocked');
    if (block === 'session_expired') return fail('logged_out');
    let pathname = '';
    try { pathname = new URL(snap.url).pathname; } catch { /* leave empty */ }
    return pathname.startsWith('/feed') ? ok() : fail('unexpected_page');
  } catch {
    return fail('page_load_failed');
  } finally {
    await browser.close().catch(() => undefined);
    lock.handle.release();
  }
}

const NAUKRI_PROBE = String.raw`(function () {
  var t = document.body ? String(document.body.innerText || '').slice(0, 300) : '';
  return { url: String(location.href || ''), title: String(document.title || '').slice(0, 200),
    hasPassword: !!document.querySelector('input[type=password]'), head: t };
})()`;

interface NaukriProbe { url: string; title: string; hasPassword: boolean; head: string }

export async function checkNaukriSession(deps: CheckDeps = {}): Promise<CheckOutcome> {
  const sessionPath = deps.sessionPath ?? NAUKRI_SESSION_PATH;
  const problem = naukriFileProblem(sessionPath, (deps.now ?? (() => new Date()))(), deps.maxAgeDays ?? 45);
  if (problem) return fail(problem);
  if (deps.halted?.()) return fail('halted');
  const browser = await launch(deps.launcher);
  if (!browser) return fail('chrome_unavailable');
  try {
    const context = await browser.newContext({ ...HEADLESS_CONTEXT_OPTIONS, storageState: sessionPath });
    const page = await context.newPage();
    await page.goto(NAUKRI_HOME_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(deps.settleMs ?? 2500);
    const p = await page.evaluate<NaukriProbe>(NAUKRI_PROBE);
    const text = `${p.title}\n${p.head}`;
    if (/access denied/i.test(text)) return fail('blocked');
    if (/captcha|verify (that )?you('| a)re (a )?human/i.test(text)) return fail('captcha');
    if (p.url.includes('/nlogin') || p.hasPassword) return fail('logged_out');
    return p.url.includes('/mnjuser/') ? ok() : fail('unexpected_page');
  } catch {
    return fail('page_load_failed');
  } finally {
    await browser.close().catch(() => undefined);
  }
}
