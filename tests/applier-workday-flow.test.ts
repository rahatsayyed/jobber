import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Plan 8G-2 task 22: Workday-like multi-step flow with account creation and the verification handoff.
// Hermetic: invented fixtures, a hand-written mail string (Gmail is never contacted), temp accounts file.
const CANARY = 'Cv9!canaryPASSWORD#7731xx';
const CANARY_STRICT = 'St7!strictCANARY#4412yy';
vi.mock('../src/webcore/accounts.js', async (orig) => {
  const real = await orig<typeof import('../src/webcore/accounts.js')>();
  return { ...real, generatePassword: (strict = false) => (strict ? CANARY_STRICT : CANARY) };
});

import { handleOpen } from '../src/applier/tools/open.js';
import { handleFill } from '../src/applier/tools/fill.js';
import { handleChoose } from '../src/applier/tools/choose.js';
import { handleNext } from '../src/applier/tools/next.js';
import { handleSubmit } from '../src/applier/tools/submit.js';
import { handleState } from '../src/applier/tools/state.js';
import { handleEscalate } from '../src/applier/escalate.js';
import { loadAccounts } from '../src/webcore/accounts.js';
import { siteLogin } from '../src/webcore/login.js';
import { siteSignup } from '../src/webcore/signup.js';
import { siteOpenLink, verificationMode } from '../src/webcore/mailLink.js';
import { makeApplier, type ApplierHarness } from './helpers/applierHarness.js';

const WD_URL = 'https://acme.wd5.myworkdayjobs.com/en-US/x/job/1';
const WD_HOST = 'acme.wd5.myworkdayjobs.com';
const SENDER = 'no-reply@acme.wd5.myworkdayjobs.com';
const GOOD_LINK = `https://${WD_HOST}/verify?token=abcdef0123456789abcdef`;
const mail = (from: string, link: string) => `From: Workday <${from}>\nSubject: Verify your account\n\nWelcome. Confirm your email here: ${link}\n`;

let h: ApplierHarness | null = null;
let dir: string;
let accountsPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-wdflow-'));
  fs.chmodSync(dir, 0o700);
  accountsPath = path.join(dir, 'site-accounts.json');
});
afterEach(async () => {
  await h?.close(); h = null;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const P = (field: 'name.first' | 'name.last' | 'phone' | 'location') => ({ kind: 'profile' as const, field });
const A = (key: string) => ({ kind: 'answer' as const, key });

function start(env: NodeJS.ProcessEnv = {}): ApplierHarness {
  h = makeApplier({
    start: 'wd-landing.html', applyUrl: WD_URL, platform: 'workday', tier: 'agent',
    env: { APPLY_ALLOW_ACCOUNT_CREATION: 'true', APPLY_SUBMIT_MODE: 'hold', ...env },
    transitions: {
      'Create Account': [{ fixture: 'wd-verify-email.html' }],
      Apply: [{ fixture: 'wd-account.html' }],
      'Sign In': [{ fixture: 'wd-step1-personal.html' }],
      'Save and Continue': [{ fixture: 'wd-step2-questions.html' }, { fixture: 'wd-step3-review.html' }],
    },
    gotoMap: { '/verify': 'wd-signin.html' },
  });
  return h;
}
const siteDeps = (x: ApplierHarness) => ({
  runtime: x.runtime, db: x.db, env: x.env, accountsPath, profileEmail: 'me@example.test', escalate: x.deps.escalate,
});
const clickApply = async (x: ApplierHarness) => { await x.runtime.page()!.locator('[data-jc="0"]').first().click(); };

/** landing -> Apply -> account form -> site_signup. Returns the signup result. */
async function createAccount(x: ApplierHarness) {
  expect((await handleOpen({ job_id: 'job-1' }, x.deps)).status).toBe('ok');
  await clickApply(x);
  return siteSignup({ purpose: 'apply' }, siteDeps(x));
}

/** The by-hand steps after sign-in: step 1, step 2, review, then submit in hold mode. */
async function stepsToHeld(x: ApplierHarness, results: unknown[]) {
  const fill = async (field: string, ref: ReturnType<typeof P>) => { const r = await handleFill({ field, ref }, x.deps); results.push(r); return r; };
  expect(await fill('f1', P('name.first'))).toMatchObject({ status: 'ok' });
  expect(await fill('f2', P('name.last'))).toMatchObject({ status: 'ok' });
  expect(await fill('f3', P('phone'))).toMatchObject({ status: 'ok' });
  expect(await fill('f4', P('location'))).toMatchObject({ status: 'ok' });
  const n1 = await handleNext({ control: 'c2' }, x.deps); results.push(n1);
  expect(n1, JSON.stringify(n1)).toMatchObject({ status: 'ok', code: 'moved' });
  const c1 = await handleChoose({ field: 'f1', option: 'Yes', ref: A('authorized_to_work') }, x.deps); results.push(c1);
  expect(c1).toMatchObject({ status: 'ok' });
  const q = await handleFill({ field: 'f2', ref: A('years_experience') as never }, x.deps); results.push(q);
  expect(q).toMatchObject({ status: 'ok' });
  const eeo = await handleChoose({ field: 'f3', option: 'Decline to self-identify' }, x.deps); results.push(eeo);
  expect(eeo).toMatchObject({ status: 'ok' });
  const n2 = await handleNext({ control: 'c2' }, x.deps); results.push(n2);
  expect(n2, JSON.stringify(n2)).toMatchObject({ status: 'ok', code: 'moved' });
  const st = await handleState(x.deps); results.push(st);
  expect(st.state).toContain('step=review');
  const sub = await handleSubmit({}, x.deps); results.push(sub);
  return sub;
}

/** Gmail mode as the operator would drive it, minus Gmail itself: one allowlisted message text, then site_open_link. */
async function verifyByMail(x: ApplierHarness, text: string, results: unknown[]) {
  const r = await siteOpenLink({ url_or_message_text: text }, { runtime: x.runtime, db: x.db, hosts: x.deps.state.cur!.allowedHosts, env: x.env });
  results.push(r);
  return r;
}

describe('verification flow on the Workday-like fixture site', () => {
  it('owner_assist stops at needs_owner email_verification after account creation', async () => {
    const x = start({ SITE_ACCOUNTS_FILE: accountsPath });
    const results: unknown[] = [];
    const su = await createAccount(x);
    results.push(su);
    expect(su).toMatchObject({ status: 'needs_verification', code: 'verify_email', mode: 'owner_assist' });
    // the account form was submitted with the marketing box unchecked and the legal box checked
    const clicks = x.site.events.filter((e) => e.startsWith('click:field:'));
    expect(clicks).toContain('click:field:I acknowledge the Privacy Notice');
    expect(clicks.some((e) => /promotional/i.test(e))).toBe(true); // pre-checked, so it was clicked once to uncheck
    expect(x.escalations.some(([k]) => k === 'verification')).toBe(true);
    const esc = await handleEscalate({ job_id: 'job-1', reason: 'email_verification' }, x.deps, { notify: () => undefined, runId: null });
    results.push(esc);
    expect(esc).toMatchObject({ status: 'needs_owner', code: 'escalated' });
    expect(x.db.prepare("SELECT reason FROM escalations WHERE reason = 'apply:email_verification'").all()).toHaveLength(1);
    expect(x.db.prepare("SELECT apply_status FROM outreach_queue WHERE job_id = 'job-1'").get()).toEqual({ apply_status: 'needs_owner' });
    // no link was opened and nothing was submitted
    expect(x.site.events.filter((e) => e === 'goto')).toHaveLength(1); // the apply_open navigation only
    expect(x.db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
    expect(JSON.stringify(results)).not.toContain(CANARY);
  });

  it('gmail mode with allowlist opens the one allowlisted link and reaches held', async () => {
    const env = { SITE_ACCOUNTS_FILE: accountsPath, SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: SENDER };
    const x = start(env);
    const results: unknown[] = [];
    const su = await createAccount(x);
    results.push(su);
    expect(su).toMatchObject({ status: 'needs_verification', mode: 'gmail' });
    const ol = await verifyByMail(x, mail(SENDER, GOOD_LINK), results);
    // the fake page reports a fixed URL; the point is that the result is origin and path only, no token
    expect(ol).toMatchObject({ status: 'opened' });
    expect(JSON.stringify(ol)).not.toMatch(/token=|\?/);
    expect((await handleState(x.deps)).state).toContain('Sign In');
    const li = await siteLogin({}, siteDeps(x));
    results.push(li);
    expect(li).toMatchObject({ status: 'ok', code: 'logged_in' });
    const held = await stepsToHeld(x, results);
    expect(held).toMatchObject({ status: 'held', code: 'hold_mode' });
    // stored credential was typed at sign-up and again at sign-in, nowhere else
    expect(x.site.fills.filter((f) => f.value === CANARY)).toHaveLength(3 /* password + confirm + sign-in */);
    expect(x.site.events.filter((e) => e.startsWith('click:control:Submit'))).toEqual([]);
    expect(x.db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
    // marketing and newsletter boxes were never left checked
    expect(x.site.current().fields.filter((f) => f.type === 'checkbox' && /newsletter|promotional/i.test(f.label)).every((f) => !f.checked)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(CANARY);
  });

  it('gmail mode with empty allowlist behaves as owner_assist', async () => {
    expect(verificationMode({ SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: '' } as NodeJS.ProcessEnv)).toBe('owner_assist');
    const x = start({ SITE_ACCOUNTS_FILE: accountsPath, SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: '' });
    const su = await createAccount(x);
    expect(su).toMatchObject({ status: 'needs_verification', mode: 'owner_assist' });
    // owner_assist does not check the From header, but the host and path rules still apply to pasted text
    const results: unknown[] = [];
    expect(await verifyByMail(x, mail('anyone@example.org', 'https://evil.example.org/verify?x=1'), results)).toMatchObject({ status: 'refused', code: 'no_link' });
  });

  it('senders set but SITE_MAIL_VERIFY unset stays owner_assist', async () => {
    expect(verificationMode({ SITE_MAIL_SENDERS: SENDER } as NodeJS.ProcessEnv)).toBe('owner_assist');
    const x = start({ SITE_ACCOUNTS_FILE: accountsPath, SITE_MAIL_SENDERS: SENDER });
    expect(await createAccount(x)).toMatchObject({ status: 'needs_verification', mode: 'owner_assist' });
  });

  it('non-allowlisted sender and off-host link are refused', async () => {
    const x = start({ SITE_ACCOUNTS_FILE: accountsPath, SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: SENDER });
    expect(await createAccount(x)).toMatchObject({ mode: 'gmail' });
    const results: unknown[] = [];
    const gotos = () => x.site.events.filter((e) => e === 'goto').length;
    const before = gotos();
    expect(await verifyByMail(x, mail('phish@evil.example.org', GOOD_LINK), results)).toMatchObject({ status: 'refused', code: 'no_link' });
    expect(await verifyByMail(x, mail(SENDER, 'https://evil.example.org/verify?token=abcdef0123456789abcdef'), results)).toMatchObject({ status: 'refused', code: 'no_link' });
    expect(await verifyByMail(x, mail(SENDER, `https://${WD_HOST}.evil.example.org/verify?x=1`), results)).toMatchObject({ status: 'refused', code: 'no_link' });
    expect(await verifyByMail(x, `Subject: no header block\n\n${GOOD_LINK}`, results)).toMatchObject({ status: 'refused', code: 'no_link' });
    expect(gotos()).toBe(before); // nothing was navigated
  });

  it('canary password appears in no result across the whole flow', async () => {
    const out: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
    const x = start({ SITE_ACCOUNTS_FILE: accountsPath, SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: SENDER });
    const results: unknown[] = [];
    results.push(await handleOpen({ job_id: 'job-1' }, x.deps));
    await clickApply(x);
    results.push(await siteSignup({ purpose: 'apply' }, siteDeps(x)));
    await verifyByMail(x, mail(SENDER, GOOD_LINK), results);
    results.push(await siteLogin({}, siteDeps(x)));
    results.push(await stepsToHeld(x, results));
    const blob = JSON.stringify({
      results, out, escalations: x.escalations,
      dry: x.db.prepare('SELECT action, payload FROM dry_run_actions').all(),
      esc: x.db.prepare('SELECT reason, detail FROM escalations').all(),
    });
    expect(blob).not.toContain(CANARY);
    expect(blob).not.toContain(CANARY_STRICT);
    expect(blob).not.toContain('me@example.test');
    // it was typed into the page and stored in the accounts file, nowhere else
    expect(x.site.fills.some((f) => f.value === CANARY)).toBe(true);
    const acc = loadAccounts(accountsPath);
    expect(acc.ok && acc.accounts[WD_HOST]?.password).toBe(CANARY);
  });
});
