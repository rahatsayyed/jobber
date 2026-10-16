// Site login (plan 8G task 6) and the page-driving helpers shared with sign-up. The password is read
// from the accounts store inside this process, typed into the page and never returned, logged or put
// in an error: every failure text here is fixed and code-authored.
import type BetterSqlite3 from 'better-sqlite3';
import type { WebRuntime } from './runtime.js';
import { extractFormModel, FORM_SNAPSHOT_SCRIPT, type FormModel, type RawFormSnapshot } from './formModel.js';
import { formatState } from './state.js';
import { getAccount, DEFAULT_ACCOUNTS_PATH } from './accounts.js';
import { checkSiteSessionDir, saveSiteStateAtomic, siteSessionPath, DEFAULT_SITE_SESSION_DIR } from './session.js';
import { loadWebConfig } from './config.js';
import { haltReason } from '../outreach/limits.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import type { LiPage } from './launch.js';

export interface SiteDeps {
  runtime: WebRuntime;
  db: BetterSqlite3.Database;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  accountsPath?: string;
  sessionDir?: string;
  /** The profile email used as the account email (from the base resume; supplied by the caller). */
  profileEmail?: string;
  /** Receives needs_owner and block outcomes; the caller writes the Telegram escalation (task 20). Never gets a secret. */
  escalate?: (kind: string, detail: string) => void;
}

export type SiteStatus = 'ok' | 'dry_run' | 'refused' | 'blocked' | 'needs_owner' | 'needs_verification' | 'failed';
export interface SiteResult {
  status: SiteStatus;
  code: string;
  reason?: string;
  /** Compact page state (formatState); contains no input values. */
  state?: string;
  /** needs_verification only. */
  mode?: string;
}

export const FIXED_FAIL = 'page interaction failed';

export async function readPage(page: LiPage): Promise<{ raw: RawFormSnapshot; model: FormModel }> {
  const raw = await page.evaluate<RawFormSnapshot>(FORM_SNAPSHOT_SCRIPT);
  return { raw, model: extractFormModel(raw) };
}

const idx = (id: string): number => {
  const n = Number(id.slice(1)) - 1;
  if (!Number.isInteger(n) || n < 0) throw new Error(FIXED_FAIL);
  return n;
};

/** Types a value into a field by model id. The value never appears in any thrown text. */
export async function fillField(page: LiPage, fieldId: string, value: string): Promise<void> {
  try { await page.locator(`[data-jf="${idx(fieldId)}"]`).first().fill(value, { timeout: 10000 }); } catch { throw new Error(FIXED_FAIL); }
}
export async function clickField(page: LiPage, fieldId: string): Promise<void> {
  try { await page.locator(`[data-jf="${idx(fieldId)}"]`).first().click({ timeout: 10000 }); } catch { throw new Error(FIXED_FAIL); }
}
export async function clickControl(page: LiPage, controlId: string): Promise<void> {
  try { await page.locator(`[data-jc="${idx(controlId)}"]`).first().click({ timeout: 10000 }); } catch { throw new Error(FIXED_FAIL); }
}

export const hostOfUrl = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

export function haltedWeb(db: BetterSqlite3.Database): string | null {
  return haltReason(db, 'web') ?? haltReason(db, 'apply');
}

export async function siteLogin(input: { host?: string }, deps: SiteDeps): Promise<SiteResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const cfg = loadWebConfig(env);
  try {
    const page0 = deps.runtime.page();
    if (!page0) return { status: 'refused', code: 'no_session', reason: 'open a page first' };
    const host = (input.host ?? hostOfUrl(page0.url())).toLowerCase();
    const h = haltedWeb(deps.db);
    if (h) return { status: 'refused', code: 'halted', reason: h };
    const hit = getAccount(host, deps.accountsPath ?? DEFAULT_ACCOUNTS_PATH);
    if (!hit) return { status: 'needs_owner', code: 'no_account', reason: `no stored account for ${host}` };
    if (isDryRun(env, { web: true })) {
      recordDryRun(deps.db, { runId: null, action: 'site_login', platform: 'web', payload: { host } }, now(), env);
      return { status: 'dry_run', code: 'dry_run' };
    }
    return await deps.runtime.serial(async (): Promise<SiteResult> => {
      const page = deps.runtime.page();
      if (!page) return { status: 'refused', code: 'no_session', reason: 'open a page first' };
      const first = await readPage(page);
      if (first.model.block) return { status: 'blocked', code: first.model.block, state: formatState(first.model) };
      if (first.model.stepKind !== 'signin') return { status: 'refused', code: 'not_signin_page', state: formatState(first.model) };
      const vis = first.model.fields.filter((f) => !f.hidden);
      const email = vis.find((f) => f.role === 'email');
      const pw = vis.find((f) => f.role === 'password');
      const btn = first.model.controls.find((c) => c.kind === 'sign_in');
      if (!email || !pw || !btn) return { status: 'refused', code: 'unsupported_form', state: formatState(first.model) };
      await fillField(page, email.id, hit.account.email);
      await fillField(page, pw.id, hit.account.password);
      await clickControl(page, btn.id);
      await page.waitForTimeout(cfg.settleMs).catch(() => undefined);
      const after = await readPage(page);
      if (after.model.block) return { status: 'blocked', code: after.model.block, state: formatState(after.model) };
      if (after.model.stepKind === 'signin') return { status: 'failed', code: 'login_failed', reason: 'still on the sign-in page', state: formatState(after.model) };
      try {
        const dir = deps.sessionDir ?? DEFAULT_SITE_SESSION_DIR;
        if (checkSiteSessionDir(dir).ok) {
          const st = await deps.runtime.context()?.storageState();
          if (st) saveSiteStateAtomic(siteSessionPath(host, dir), st);
        }
      } catch { console.error('[webcore] site_login: session not saved'); }
      return { status: 'ok', code: 'logged_in', state: formatState(after.model) };
    });
  } catch {
    console.error('[webcore] site_login failed');
    return { status: 'failed', code: 'error', reason: FIXED_FAIL };
  }
}
