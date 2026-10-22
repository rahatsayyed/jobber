// Site sign-up (plan 8G task 6, D11/D12/D13, O-accounts). Runs only when its flag is true, live,
// the site_account ceiling has room, the page is an account step with no block, and the checkbox
// gate passes. The unique password is written atomically BEFORE the create click. Nothing here
// solves a CAPTCHA, enters an MFA or phone code, or retries a block in the same run.
import type { LiPage } from './launch.js';
import {
  clickControl, clickField, fillGuarded, FIXED_FAIL, HostChanged, haltedWeb, hostBlockedThisRun, hostCoolingDown, hostOfUrl, noteBlock,
  readPage, scrubSecrets, type SiteDeps, type SiteResult,
} from './login.js';
import type { FormModel } from './formModel.js';
import { formatState } from './state.js';
import { generatePassword, getAccount, removeAccount, saveAccount, DEFAULT_ACCOUNTS_PATH } from './accounts.js';
import { verificationMode } from './mailLink.js';
import { loadWebConfig } from './config.js';
import { ceilings, tryConsume } from '../outreach/limits.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';

export { noteBlock, hostCoolingDown, resetSiteBlocks, BLOCK_COOLDOWN_AFTER } from './login.js';

export type SignupPurpose = 'apply' | 'scout';

export type GateResult =
  | { ok: true; model: FormModel }
  | { ok: false; code: 'marketing_checkbox' | 'consent'; model: FormModel };

export function acceptLegalRequired(env: NodeJS.ProcessEnv): boolean {
  return String(env.APPLY_ACCEPT_LEGAL_REQUIRED ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * D12 checkbox gate, shared by sign-up and by any submit/next that leaves a form step.
 * marketing: always unchecked (a pre-checked box is clicked, then re-read and verified; a hidden
 * pre-checked one cannot be unchecked and needs the owner); legal_required: checked only when the
 * box is required; attestation, third_party_sharing, a required box of any other class:
 * needs_owner. Never trusts a click: every state is re-read.
 */
export async function enforceCheckboxGate(page: LiPage, opts: { acceptLegal: boolean }): Promise<GateResult> {
  let { model } = await readPage(page);
  const all = () => model.fields.filter((f) => f.type === 'checkbox');
  const boxes = () => all().filter((f) => !f.hidden);
  for (const f of all()) {
    if (f.hidden && f.consentClass === 'marketing' && f.checked) return { ok: false, code: 'marketing_checkbox', model };
  }
  for (const f of boxes()) {
    if (f.consentClass === 'attestation' || f.consentClass === 'third_party_sharing') return { ok: false, code: 'consent', model };
    if (f.consentClass === 'marketing' && f.required) return { ok: false, code: 'marketing_checkbox', model };
    if (f.consentClass === 'legal_required' && !opts.acceptLegal) return { ok: false, code: 'consent', model };
    if (f.consentClass === 'other' && f.required && !f.checked) return { ok: false, code: 'consent', model };
  }
  let clicked = false;
  for (const f of boxes()) {
    if (f.consentClass === 'marketing' && f.checked) { await clickField(page, f.id); clicked = true; }
    else if (f.consentClass === 'legal_required' && f.required && !f.checked) { await clickField(page, f.id); clicked = true; }
  }
  if (clicked) ({ model } = await readPage(page));
  for (const f of boxes()) {
    if (f.consentClass === 'marketing' && f.checked) return { ok: false, code: 'marketing_checkbox', model };
    if (f.consentClass === 'legal_required' && f.required && !f.checked) return { ok: false, code: 'consent', model };
  }
  return { ok: true, model };
}

const VERIFY_RE = /verify your (e-?mail|account)|check your (e-?mail|inbox)|confirmation (e-?mail|link)|we(?:'ve| have) sent (you )?(an )?e-?mail/i;
const POLICY_RE = /password.{0,80}(must|requires?|at least|characters|uppercase|special|complex|too (weak|short))|(must|requires?|at least).{0,80}password/i;

// The host is always read from the open page; a caller-supplied host is ignored.
export async function siteSignup(input: { host?: string; purpose: SignupPurpose }, deps: SiteDeps): Promise<SiteResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const cfg = loadWebConfig(env);
  const path = deps.accountsPath ?? DEFAULT_ACCOUNTS_PATH;
  let saved = false;
  let clicked = false;
  let host = '';
  const email = (deps.profileEmail ?? '').trim();
  let password = '';
  const scrub = (r: SiteResult): SiteResult => scrubSecrets(r, [email, password]);
  // A credential stored for an attempt whose create click never happened is dropped again.
  const unsave = (): void => { if (saved && !clicked && host) { try { removeAccount(host, path); } catch { /* ignore */ } } };
  try {
    const flag = input.purpose === 'apply' ? env.APPLY_ALLOW_ACCOUNT_CREATION : env.SCOUT_ALLOW_SIGNUP;
    if (String(flag ?? '').trim() !== 'true') return { status: 'refused', code: 'signup_disabled', reason: 'account creation is switched off' };
    const page0 = deps.runtime.page();
    if (!page0) return { status: 'refused', code: 'no_session', reason: 'open a page first' };
    host = hostOfUrl(page0.url());
    if (!host) return { status: 'refused', code: 'no_session', reason: 'open a page first' };
    const h = haltedWeb(deps.db);
    if (h) return { status: 'refused', code: 'halted', reason: h };
    if (isDryRun(env)) {
      recordDryRun(deps.db, { runId: null, action: 'site_signup', platform: 'web', payload: { host, purpose: input.purpose } }, now(), env);
      return { status: 'dry_run', code: 'dry_run' };
    }
    if (hostBlockedThisRun(host)) return { status: 'refused', code: 'blocked_this_run', reason: 'a block was seen on this host in this run' };
    if (hostCoolingDown(host)) return { status: 'refused', code: 'host_cooldown', reason: 'host blocked twice this run' };
    const ocfg = loadOutreachConfig(env);
    if (!ceilings(deps.db, ocfg, now()).site_account.ok) return { status: 'refused', code: 'rate_limited', reason: 'site_account ceiling reached' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 'needs_owner', code: 'no_profile_email', reason: 'profile email missing' };
    if (getAccount(host, path)) return { status: 'refused', code: 'account_exists', reason: 'an account is already stored for this host' };

    return scrub(await deps.runtime.serial(async (): Promise<SiteResult> => {
      const page = deps.runtime.page();
      if (!page) return { status: 'refused', code: 'no_session', reason: 'open a page first' };
      const first = await readPage(page);
      if (first.model.block) { noteBlock(host); deps.escalate?.('block', `${first.model.block} on ${host}`); return { status: 'blocked', code: first.model.block, state: formatState(first.model) }; }
      if (first.model.stepKind !== 'account') return { status: 'refused', code: 'not_account_page', state: formatState(first.model) };
      const vis = first.model.fields.filter((f) => !f.hidden);
      const emailF = vis.find((f) => f.role === 'email');
      const pwF = vis.find((f) => f.role === 'password');
      const pw2F = vis.find((f) => f.role === 'password_confirm');
      const create = first.model.controls.find((c) => c.kind === 'create_account');
      if (!emailF || !pwF || !create) return { status: 'refused', code: 'unsupported_form', state: formatState(first.model) };
      const extra = vis.filter((f) => f.required && !f.filled && f.type !== 'checkbox' && f !== emailF && f !== pwF && f !== pw2F);
      if (extra.length > 0) return { status: 'needs_owner', code: 'unsupported_field', reason: 'the account form asks for more than email and password', state: formatState(first.model) };

      const gate = await enforceCheckboxGate(page, { acceptLegal: acceptLegalRequired(env) });
      if (!gate.ok) {
        deps.escalate?.('needs_owner', `${gate.code} on ${host}`);
        return { status: 'needs_owner', code: gate.code, state: formatState(gate.model) };
      }
      if (!tryConsume(deps.db, 'site_account', ocfg, now())) return { status: 'refused', code: 'rate_limited', reason: 'site_account ceiling reached' };

      password = generatePassword(false);
      // Credential first, atomically, then the click.
      saveAccount(host, { email, password, created_at: now().toISOString(), source: 'agent', verified: false }, path);
      saved = true;
      try {
        await fillGuarded(page, host, emailF.id, email);
        await fillGuarded(page, host, pwF.id, password);
        if (pw2F) await fillGuarded(page, host, pw2F.id, password);
      } catch (e) {
        if (e instanceof HostChanged) { unsave(); return { status: 'refused', code: 'host_changed', reason: 'the page moved to another host; nothing more was typed' }; }
        throw e;
      }
      // Last look immediately before the create click: block check and the whole checkbox gate again
      // on this final snapshot (a page can change after the fills).
      const pre = await enforceCheckboxGate(page, { acceptLegal: acceptLegalRequired(env) });
      if (pre.model.block) {
        unsave(); noteBlock(host); deps.escalate?.('block', `${pre.model.block} on ${host}`);
        return { status: 'blocked', code: pre.model.block, state: formatState(pre.model) };
      }
      if (!pre.ok) {
        unsave(); deps.escalate?.('needs_owner', `${pre.code} on ${host}`);
        return { status: 'needs_owner', code: pre.code, state: formatState(pre.model) };
      }
      const createNow = pre.model.controls.find((c) => c.kind === 'create_account');
      if (!createNow) { unsave(); return { status: 'refused', code: 'unsupported_form', state: formatState(pre.model) }; }
      clicked = true;
      await clickControl(page, createNow.id);
      await page.waitForTimeout(cfg.settleMs).catch(() => undefined);
      let after = await readPage(page);

      if (!after.model.block && after.model.stepKind === 'account' && after.model.notices.some((n) => POLICY_RE.test(n))) {
        // One stricter retry after a password policy notice; the new password is stored before the click
        // and the earlier one is restored if the retry cannot go ahead.
        const prev = password;
        password = generatePassword(true);
        saveAccount(host, { email, password, created_at: now().toISOString(), source: 'agent', verified: false }, path);
        const restore = (): void => { try { saveAccount(host, { email, password: prev, created_at: now().toISOString(), source: 'agent', verified: false }, path); password = prev; } catch { /* ignore */ } };
        const again = after.model;
        const e2 = again.fields.find((f) => !f.hidden && f.role === 'email');
        const p1 = again.fields.find((f) => !f.hidden && f.role === 'password');
        const p2 = again.fields.find((f) => !f.hidden && f.role === 'password_confirm');
        if (!e2 || !p1) { restore(); return { status: 'failed', code: 'create_failed', reason: 'the account form changed', state: formatState(again) }; }
        // Any throw in the retry puts the earlier credential back before it propagates, so the store
        // never keeps a password the site has not accepted.
        try {
          await fillGuarded(page, host, e2.id, email);
          await fillGuarded(page, host, p1.id, password);
          if (p2) await fillGuarded(page, host, p2.id, password);
          const g2 = await enforceCheckboxGate(page, { acceptLegal: acceptLegalRequired(env) });
          if (g2.model.block) { restore(); noteBlock(host); deps.escalate?.('block', `${g2.model.block} on ${host}`); return { status: 'blocked', code: g2.model.block, state: formatState(g2.model) }; }
          const c3 = g2.model.controls.find((c) => c.kind === 'create_account');
          if (!g2.ok || !c3) { restore(); return { status: 'needs_owner', code: g2.ok ? 'unsupported_form' : g2.code, state: formatState(g2.model) }; }
          await clickControl(page, c3.id);
          await page.waitForTimeout(cfg.settleMs).catch(() => undefined);
          after = await readPage(page);
        } catch (e) {
          restore();
          if (e instanceof HostChanged) return { status: 'refused', code: 'host_changed', reason: 'the page moved to another host; nothing more was typed' };
          throw e;
        }
      }

      if (after.model.block) {
        noteBlock(host);
        deps.escalate?.('block', `${after.model.block} on ${host}`);
        return { status: 'blocked', code: after.model.block, state: formatState(after.model) };
      }
      if (VERIFY_RE.test(`${after.raw.title}\n${after.raw.text}`)) {
        const mode = verificationMode(env);
        deps.escalate?.('verification', `verify the new account on ${host} (${mode})`);
        return { status: 'needs_verification', code: 'verify_email', mode, state: formatState(after.model) };
      }
      if (after.model.stepKind === 'account') return { status: 'failed', code: 'create_failed', reason: 'the account form is still showing', state: formatState(after.model) };
      return { status: 'ok', code: 'created', state: formatState(after.model) };
    }));
  } catch {
    unsave();
    console.error(`[webcore] site_signup failed${saved && clicked ? ' (credential was stored)' : ''}`);
    return { status: 'failed', code: 'error', reason: FIXED_FAIL };
  }
}
