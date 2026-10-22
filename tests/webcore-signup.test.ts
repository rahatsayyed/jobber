import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANARY = 'Cv9!canaryPASSWORD#7731xx';
const CANARY_STRICT = 'St7!strictCANARY#4412yy';
vi.mock('../src/webcore/accounts.js', async (orig) => {
  const real = await orig<typeof import('../src/webcore/accounts.js')>();
  return { ...real, generatePassword: (strict = false) => (strict ? CANARY_STRICT : CANARY) };
});

import { openDb } from '../src/db.js';
import { recordEvent } from '../src/outreach/limits.js';
import { createWebRuntime, type WebRuntime } from '../src/webcore/runtime.js';
import { loadAccounts, saveAccount } from '../src/webcore/accounts.js';
import { siteLogin } from '../src/webcore/login.js';
import { enforceCheckboxGate, resetSiteBlocks, siteSignup } from '../src/webcore/signup.js';
import { readPage } from '../src/webcore/login.js';
import { createFakeSite, type FakeSite, type FakeSiteOpts } from './helpers/fakeSitePage.js';

const LIVE = { JOBBER_DRY_RUN: 'false', APPLY_ALLOW_ACCOUNT_CREATION: 'true', SCOUT_ALLOW_SIGNUP: 'true' } as NodeJS.ProcessEnv;
const HOST = 'wd.example.test';
const CREATE = 'Create Account';

let dir: string;
let accountsPath: string;
let last: WebRuntime | null = null;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-su-'));
  fs.chmodSync(dir, 0o700);
  accountsPath = path.join(dir, 'site-accounts.json');
  resetSiteBlocks();
});
afterEach(async () => { await last?.close(); last = null; vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

async function setup(opts: Partial<FakeSiteOpts> = {}, env: NodeJS.ProcessEnv = {}) {
  await last?.close();
  const db = openDb(':memory:');
  const site: FakeSite = createFakeSite({ start: 'wd-account.html', transitions: { [CREATE]: [{ fixture: 'wd-verify-email.html' }] }, ...opts });
  const runtime: WebRuntime = createWebRuntime({ db, launcher: site.launcher, lockPath: path.join(dir, 'l.lock'), sessionDir: path.join(dir, 's'), config: { minGapSec: 0, settleMs: 0 } });
  await runtime.open(`https://${HOST}/careers`, { allowedHosts: ['example.test'], jobId: 'j' });
  last = runtime;
  const escalations: Array<[string, string]> = [];
  const e = { ...LIVE, SITE_ACCOUNTS_FILE: accountsPath, ...env };
  const deps = { runtime, db, env: e, accountsPath, sessionDir: path.join(dir, 's'), profileEmail: 'me@example.test', escalate: (k: string, d: string) => { escalations.push([k, d]); } };
  return { db, site, runtime, deps, escalations };
}
const run = (s: Awaited<ReturnType<typeof setup>>, purpose: 'apply' | 'scout' = 'apply') => siteSignup({ host: HOST, purpose }, s.deps);

describe('site_signup refusals', () => {
  it('flag off (either purpose), dry run, ceiling, existing account, non-account page', async () => {
    let s = await setup({}, { APPLY_ALLOW_ACCOUNT_CREATION: 'false' });
    expect(await run(s)).toMatchObject({ status: 'refused', code: 'signup_disabled' });
    s = await setup({}, { SCOUT_ALLOW_SIGNUP: 'nope' });
    expect(await run(s, 'scout')).toMatchObject({ code: 'signup_disabled' });
    expect(s.site.events.filter((e) => e.startsWith('click'))).toEqual([]);

    s = await setup({}, { JOBBER_DRY_RUN: 'true' });
    expect(await run(s)).toMatchObject({ status: 'dry_run' });
    expect((s.db.prepare('SELECT payload FROM dry_run_actions').all() as Array<{ payload: string }>).map((r) => r.payload).join()).not.toContain(CANARY);
    expect(s.site.events.filter((e) => e.startsWith('click') || e.startsWith('fill'))).toEqual([]);
    expect(loadAccounts(accountsPath)).toEqual({ ok: true, accounts: {} });

    s = await setup({}, { SITE_MAX_ACCOUNTS_PER_DAY: '1' });
    recordEvent(s.db, 'site_account', new Date());
    expect(await run(s)).toMatchObject({ status: 'refused', code: 'rate_limited' });

    s = await setup();
    saveAccount(HOST, { email: 'x@example.test', password: 'Existing-pw-123', created_at: 'now', source: 'owner', verified: true }, accountsPath);
    expect(await run(s)).toMatchObject({ code: 'account_exists' });

    fs.rmSync(accountsPath);
    s = await setup({ start: 'wd-landing.html' });
    expect(await run(s)).toMatchObject({ status: 'refused', code: 'not_account_page' });
    expect(loadAccounts(accountsPath)).toMatchObject({ ok: true });
  });
  it('a halted web platform refuses', async () => {
    const s = await setup();
    const { haltPlatform } = await import('../src/outreach/limits.js');
    haltPlatform(s.db, 'web', 'test halt', new Date());
    expect(await run(s)).toMatchObject({ code: 'halted' });
  });
});

describe('site_signup happy path and ordering', () => {
  it('stores the credential before the create click, unchecks marketing first, ends at the verification stop', async () => {
    let atClick: { stored: boolean; password: string } | null = null;
    const s = await setup({
      onClick: (label) => {
        if (label !== CREATE) return;
        const l = loadAccounts(accountsPath);
        const a = l.ok ? l.accounts[HOST] : undefined;
        atClick = { stored: !!a, password: a?.password ?? '' };
      },
    });
    const r = await run(s);
    expect(r).toMatchObject({ status: 'needs_verification', code: 'verify_email', mode: 'owner_assist' });
    expect(atClick).toEqual({ stored: true, password: CANARY });
    const ev = s.site.events;
    const promo = ev.indexOf('click:field:Send me promotional emails');
    const priv = ev.indexOf('click:field:I acknowledge the Privacy Notice');
    const create = ev.indexOf(`click:control:${CREATE}`);
    expect(promo).toBeGreaterThanOrEqual(0);
    expect(priv).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(promo);
    expect(create).toBeGreaterThan(priv);
    expect(ev.filter((e) => e === `click:control:${CREATE}`)).toHaveLength(1);
    const l = loadAccounts(accountsPath);
    expect(l.ok && l.accounts[HOST]).toMatchObject({ email: 'me@example.test', source: 'agent', verified: false });
    expect(s.escalations.map((e) => e[0])).toEqual(['verification']);
  });
  it('gmail mode is reported only when set explicitly with senders', async () => {
    const s = await setup({}, { SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: 'no-reply@wd.example.test' });
    expect(await run(s)).toMatchObject({ mode: 'gmail' });
  });
  it('a password policy notice triggers one stricter retry, stored before the second click', async () => {
    const stored: string[] = [];
    const s = await setup({
      transitions: { [CREATE]: [{ fixture: 'wd-account.html', notices: ['Password must be at least 12 characters'] }, { fixture: 'wd-verify-email.html' }] },
      onClick: (label) => {
        if (label !== CREATE) return;
        const l = loadAccounts(accountsPath);
        stored.push(l.ok ? l.accounts[HOST]?.password ?? '' : '');
      },
    });
    expect(await run(s)).toMatchObject({ status: 'needs_verification' });
    expect(stored).toEqual([CANARY, CANARY_STRICT]);
    const l = loadAccounts(accountsPath);
    expect(l.ok && l.accounts[HOST].password).toBe(CANARY_STRICT);
  });
  it('a form that stays up after create fails without a retry loop', async () => {
    const s = await setup({ transitions: { [CREATE]: [{ fixture: 'wd-account.html', notices: ['Something went wrong'] }] } });
    expect(await run(s)).toMatchObject({ status: 'failed', code: 'create_failed' });
    expect(s.site.events.filter((e) => e === `click:control:${CREATE}`)).toHaveLength(1);
  });
});

describe('checkbox gate (D12)', () => {
  it('a marketing box that re-checks itself ends needs_owner with no create click and nothing stored', async () => {
    const s = await setup({ stickyLabel: /promotional/i });
    expect(await run(s)).toMatchObject({ status: 'needs_owner', code: 'marketing_checkbox' });
    expect(s.site.events).not.toContain(`click:control:${CREATE}`);
    expect(loadAccounts(accountsPath)).toEqual({ ok: true, accounts: {} });
    expect(s.site.fills).toEqual([]);
    expect((s.db.prepare("SELECT COUNT(*) n FROM rate_events WHERE key='site_account'").get() as { n: number }).n).toBe(0);
  });
  const form = (boxes: string) => `<html><body><h1>Create Account</h1><form>
<label for="em">Email Address *</label><input id="em" type="email" required>
<label for="pw">Password *</label><input id="pw" type="password" required>
<label for="pw2">Verify New Password *</label><input id="pw2" type="password" required>${boxes}
<button type="submit">Create Account</button></form></body></html>`;
  it('a legal box is checked only when required; an optional terms box and an unchecked marketing box are left alone', async () => {
    const s = await setup({ start: form('<label><input id="a" type="checkbox"> I agree to the terms of use</label><label><input id="b" type="checkbox" required> I acknowledge the Privacy Notice</label><label><input id="c" type="checkbox"> Email me job alerts</label>') });
    expect(await run(s)).toMatchObject({ status: 'needs_verification' });
    expect(s.site.events.filter((e) => e.startsWith('click:field'))).toEqual(['click:field:I acknowledge the Privacy Notice']);
  });
  it('attestation, third-party sharing and a required unclassified box need the owner', async () => {
    for (const box of [
      '<label><input type="checkbox" required> I certify the information is true and complete</label>',
      '<label><input type="checkbox"> I agree you may share my data with partners and third parties</label>',
      '<label><input type="checkbox" required> I am over eighteen and live in the region</label>',
    ]) {
      const s = await setup({ start: form(box) });
      expect(await run(s)).toMatchObject({ status: 'needs_owner', code: 'consent' });
      expect(s.site.events).not.toContain(`click:control:${CREATE}`);
    }
  });
  it('a required marketing box cannot be satisfied and needs the owner; APPLY_ACCEPT_LEGAL_REQUIRED=false leaves legal boxes to the owner', async () => {
    let s = await setup({ start: form('<label><input type="checkbox" required> Subscribe to our newsletter</label>') });
    expect(await run(s)).toMatchObject({ code: 'marketing_checkbox' });
    s = await setup({}, { APPLY_ACCEPT_LEGAL_REQUIRED: 'false' });
    expect(await run(s)).toMatchObject({ code: 'consent' });
  });
  it('enforceCheckboxGate is reusable before a next or submit and verifies by re-reading', async () => {
    const s = await setup();
    const page = s.runtime.page()!;
    const g = await enforceCheckboxGate(page, { acceptLegal: true });
    expect(g.ok).toBe(true);
    const { model } = await readPage(page);
    expect(model.fields.find((f) => f.consentClass === 'marketing')?.checked).toBe(false);
    expect(model.fields.find((f) => f.consentClass === 'legal_required')?.checked).toBe(true);
  });
});

describe('blocks', () => {
  it('a CAPTCHA wall stops, escalates, and a second block puts the host on cooldown', async () => {
    let s = await setup({ start: 'captcha-wall.html' });
    expect(await run(s)).toMatchObject({ status: 'blocked', code: 'captcha' });
    expect(s.escalations[0][0]).toBe('block');
    expect(s.site.events.filter((e) => e.startsWith('click') || e.startsWith('fill'))).toEqual([]);
    s = await setup({ start: 'mfa-code.html' });
    expect(await run(s)).toMatchObject({ status: 'refused', code: 'blocked_this_run' });
    s = await setup();
    // any block makes the host off limits for the rest of the run
    expect(await run(s)).toMatchObject({ status: 'refused', code: 'blocked_this_run' });
    expect(s.site.events.filter((e) => e.startsWith('click') || e.startsWith('fill'))).toEqual([]);
  });
  it('site_login notes blocks too, and refuses without typing once the host is cooling down', async () => {
    saveAccount(HOST, { email: 'me@example.test', password: CANARY, created_at: 'now', source: 'agent', verified: true }, accountsPath);
    let s = await setup({ start: 'captcha-wall.html' });
    expect(await siteLogin({}, s.deps)).toMatchObject({ status: 'blocked' });
    s = await setup({ start: 'mfa-code.html' });
    expect(await siteLogin({}, s.deps)).toMatchObject({ status: 'blocked' });
    s = await setup({ start: 'wd-signin.html' });
    expect(await siteLogin({}, s.deps)).toMatchObject({ status: 'refused', code: 'host_cooldown' });
    expect(s.site.fills).toEqual([]);
  });
});

describe('host binding', () => {
  it('a caller-supplied host never redirects typing: the host comes from the open page', async () => {
    saveAccount('other.example.test', { email: 'me@example.test', password: CANARY, created_at: 'now', source: 'owner', verified: true }, accountsPath);
    const s = await setup({ start: 'wd-signin.html', transitions: { 'Sign In': [{ fixture: 'wd-step1-personal.html' }] } });
    expect(await siteLogin({ host: 'other.example.test' }, s.deps)).toMatchObject({ status: 'needs_owner', code: 'no_account' });
    expect(s.site.fills).toEqual([]);
    const t = await setup({ start: 'wd-account.html' });
    saveAccount('other.example.test', { email: 'me@example.test', password: 'Zz-other-pw-123456', created_at: 'now', source: 'owner', verified: true }, accountsPath);
    expect(await siteSignup({ host: 'other.example.test', purpose: 'apply' }, t.deps)).toMatchObject({ status: 'needs_verification' });
    const l = loadAccounts(accountsPath);
    expect(l.ok && Object.keys(l.accounts).sort()).toEqual(['other.example.test', HOST].sort());
  });
  it('requires the page host to be the account key or a subdomain of it', async () => {
    const { hostMatchesAccount } = await import('../src/webcore/login.js');
    expect(hostMatchesAccount('wd.example.test', 'wd.example.test')).toBe(true);
    expect(hostMatchesAccount('a.wd.example.test', 'wd.example.test')).toBe(true);
    expect(hostMatchesAccount('evilwd.example.test', 'wd.example.test')).toBe(false);
    expect(hostMatchesAccount('', '')).toBe(false);
  });
});

describe('redirect between check and fill', () => {
  // The page reports another host after its first snapshot read, i.e. after the host check.
  const flipAfterFirstRead = (s: Awaited<ReturnType<typeof setup>>) => {
    const page = s.runtime.page() as unknown as { url: () => string; evaluate: (src: string) => Promise<unknown> };
    const origUrl = page.url.bind(page);
    const origEval = page.evaluate.bind(page);
    let flipped = false;
    page.url = () => (flipped ? 'https://evil.example.test/login' : origUrl());
    page.evaluate = async (src: string) => { const r = await origEval(src); flipped = true; return r; };
  };
  it('site_login types nothing when the host changed after the check', async () => {
    saveAccount(HOST, { email: 'me@example.test', password: CANARY, created_at: 'now', source: 'agent', verified: true }, accountsPath);
    const s = await setup({ start: 'wd-signin.html' });
    flipAfterFirstRead(s);
    expect(await siteLogin({}, s.deps)).toMatchObject({ status: 'refused', code: 'host_changed' });
    expect(s.site.fills).toEqual([]);
  });
  it('site_signup types nothing, clicks nothing and drops the credential when the host changed', async () => {
    const s = await setup();
    flipAfterFirstRead(s);
    expect(await run(s)).toMatchObject({ status: 'refused', code: 'host_changed' });
    expect(s.site.fills).toEqual([]);
    expect(s.site.events).not.toContain(`click:control:${CREATE}`);
    expect(loadAccounts(accountsPath)).toEqual({ ok: true, accounts: {} });
  });
});

describe('throwing policy retry', () => {
  it('restores the earlier credential when a fill in the strict retry throws', async () => {
    const s = await setup({
      transitions: { [CREATE]: [{ fixture: 'wd-account.html', notices: ['Password must be at least 12 characters'] }] },
    });
    const page = s.runtime.page()!;
    const origLocator = page.locator.bind(page);
    (page as unknown as { locator: unknown }).locator = (sel: string) => {
      const l = origLocator(sel);
      const fill = l.fill.bind(l);
      l.fill = async (t: string, o?: { timeout?: number }) => { if (t === CANARY_STRICT) throw new Error(`boom ${t}`); await fill(t, o); };
      return l;
    };
    const r = await run(s);
    expect(r).toMatchObject({ status: 'failed', code: 'error' });
    expect(JSON.stringify(r)).not.toContain(CANARY_STRICT);
    const l = loadAccounts(accountsPath);
    expect(l.ok && l.accounts[HOST].password).toBe(CANARY);
  });
});

describe('final-snapshot and cleanup rules', () => {
  const acctForm = (extraBox: string) => `<html><body><h1>Create Account</h1><form>
<label for="em">Email Address *</label><input id="em" type="email" required>
<label for="pw">Password *</label><input id="pw" type="password" required>
<label for="pw2">Verify New Password *</label><input id="pw2" type="password" required>${extraBox}
<button type="submit">Create Account</button></form></body></html>`;
  it('a hidden pre-checked marketing input needs the owner', async () => {
    const s = await setup({ start: acctForm('<label><input type="checkbox" checked style="display:none"> Send me promotional emails</label>') });
    expect(await run(s)).toMatchObject({ status: 'needs_owner', code: 'marketing_checkbox' });
    expect(s.site.events).not.toContain(`click:control:${CREATE}`);
  });
  it('a page that grows a CAPTCHA after the fills is caught on the final snapshot: no create click, credential dropped', async () => {
    let fills = 0;
    const s = await setup({
      start: 'wd-account.html',
      onClick: () => undefined,
    });
    // swap the page to a blocked one once the password field has been typed into
    const page = s.runtime.page()!;
    const origLocator = page.locator.bind(page);
    (page as unknown as { locator: unknown }).locator = (sel: string) => {
      const l = origLocator(sel);
      const fill = l.fill.bind(l);
      l.fill = async (t: string, o?: { timeout?: number }) => { await fill(t, o); if (++fills === 3) s.site.current().captchaWidget = true; };
      return l;
    };
    expect(await run(s)).toMatchObject({ status: 'blocked', code: 'captcha' });
    expect(s.site.events).not.toContain(`click:control:${CREATE}`);
    expect(loadAccounts(accountsPath)).toEqual({ ok: true, accounts: {} });
  });
  it('a policy retry that cannot proceed restores the earlier credential', async () => {
    const s = await setup({
      transitions: { [CREATE]: [{ fixture: acctForm('<label><input type="checkbox" required> I certify the information is true and complete</label>'), notices: ['Password must be at least 12 characters'] }] },
    });
    // the first page has no attestation; the retry page does, so the gate fails on the retry
    const r = await run(s);
    expect(r).toMatchObject({ status: 'needs_owner', code: 'consent' });
    const l = loadAccounts(accountsPath);
    expect(l.ok && l.accounts[HOST].password).toBe(CANARY);
  });
  it('the returned state never carries the account email', async () => {
    const s = await setup({ start: acctForm(''), transitions: { [CREATE]: [{ fixture: acctForm(''), notices: ['Account me@example.test already pending'] }] } });
    const r = await run(s);
    expect(JSON.stringify(r)).not.toContain('me@example.test');
  });
});

describe('credential leak tests (wd-landing -> wd-account -> verify stop)', () => {
  it('the canary password appears in no result, state, console output, escalation, dry-run row or error', async () => {
    const out: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
    const site = createFakeSite({ start: 'wd-landing.html', transitions: { Apply: [{ fixture: 'wd-account.html' }], [CREATE]: [{ fixture: 'wd-verify-email.html' }] } });
    const db = openDb(':memory:');
    const runtime = createWebRuntime({ db, launcher: site.launcher, lockPath: path.join(dir, 'l.lock'), sessionDir: path.join(dir, 's'), config: { minGapSec: 0, settleMs: 0 } });
    await runtime.open(`https://${HOST}/careers`, { allowedHosts: ['example.test'], jobId: 'j' });
    const page = runtime.page()!;
    const landing = await readPage(page);
    expect(landing.model.stepKind).toBe('landing');
    await page.locator('[data-jc="0"]').first().click(); // the applier clicks Apply
    const escalations: string[] = [];
    const deps = { runtime, db, env: { ...LIVE, SITE_ACCOUNTS_FILE: accountsPath }, accountsPath, profileEmail: 'me@example.test', escalate: (k: string, d: string) => { escalations.push(`${k} ${d}`); } };
    const results = [await siteSignup({ host: HOST, purpose: 'apply' }, deps)];
    // dry-run variant and a failing-fill variant in the same run
    results.push(await siteSignup({ host: 'dry.example.test', purpose: 'apply' }, { ...deps, env: { ...deps.env, JOBBER_DRY_RUN: 'true' } }));
    const dry = db.prepare('SELECT action, payload FROM dry_run_actions').all();
    const thrown = createFakeSite({ start: 'wd-account.html', failFill: true });
    const rt2 = createWebRuntime({ db, launcher: thrown.launcher, lockPath: path.join(dir, 'l2.lock'), sessionDir: path.join(dir, 's'), config: { minGapSec: 0, settleMs: 0 } });
    await runtime.close();
    await rt2.open(`https://${HOST}/careers`, { allowedHosts: ['example.test'], jobId: 'j2' });
    const failed = await siteSignup({ host: 'fail.example.test', purpose: 'apply' }, { ...deps, runtime: rt2, accountsPath: path.join(dir, 'second-accounts.json') });
    results.push(failed);
    expect(results[0]).toMatchObject({ status: 'needs_verification' });
    expect(failed).toMatchObject({ status: 'failed', code: 'error' });
    const blob = JSON.stringify({ results, escalations, dry, out });
    expect(blob).not.toContain(CANARY);
    expect(blob).not.toContain(CANARY_STRICT);
    expect(CANARY && site.fills.some((f) => f.value === CANARY)).toBe(true); // it was typed, nowhere else
  });
});

describe('site_login', () => {
  const stored = () => saveAccount(HOST, { email: 'me@example.test', password: CANARY, created_at: 'now', source: 'agent', verified: true }, accountsPath);
  it('logs in with the stored credential, never returning it', async () => {
    stored();
    const s = await setup({ start: 'wd-signin.html', transitions: { 'Sign In': [{ fixture: 'wd-step1-personal.html' }] } });
    const r = await siteLogin({ host: HOST }, s.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'logged_in' });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(s.site.fills.map((f) => f.value)).toEqual(['me@example.test', CANARY]);
  });
  it('fails when the sign-in page stays, needs the owner without an account, blocks on CAPTCHA, dry-runs', async () => {
    stored();
    let s = await setup({ start: 'wd-signin.html', transitions: { 'Sign In': [{ fixture: 'wd-signin.html', notices: ['Invalid credentials'] }] } });
    expect(await siteLogin({ host: HOST }, s.deps)).toMatchObject({ status: 'failed', code: 'login_failed' });
    fs.rmSync(accountsPath);
    s = await setup({ start: 'wd-signin.html' });
    expect(await siteLogin({ host: 'other.example.test' }, s.deps)).toMatchObject({ status: 'needs_owner', code: 'no_account' });
    stored();
    s = await setup({ start: 'captcha-wall.html' });
    expect(await siteLogin({ host: HOST }, s.deps)).toMatchObject({ status: 'blocked' });
    s = await setup({ start: 'wd-signin.html' }, { JOBBER_DRY_RUN: 'true' });
    expect(await siteLogin({ host: HOST }, s.deps)).toMatchObject({ status: 'dry_run' });
    expect(s.site.fills).toEqual([]);
  });
});
