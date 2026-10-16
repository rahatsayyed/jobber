import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generatePassword, listAccounts, loadAccounts, lookupAccount, markVerified, removeAccount, saveAccount, writeAccounts, getAccount,
} from '../src/webcore/accounts.js';
import { redactSecrets } from '../src/safety/redact.js';
import { gateOutbound, secretValuesFromEnv } from '../src/safety/outputGate.js';
import { resetSiteSecretsWarningForTests, setSiteAccountsPathForTests, siteAccountLiterals } from '../src/safety/siteSecrets.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { outputGateContext } from '../src/linkedin/guard.js';
import { loadProfiles, renderPolicy } from '../src/platform/runner.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-acc-'));
  fs.chmodSync(dir, 0o700);
  file = path.join(dir, 'site-accounts.json');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const acct = (over: Record<string, unknown> = {}) => ({ email: 'me@example.test', password: 'Pw-1234567890-abc', created_at: '2026-10-16T00:00:00Z', source: 'agent' as const, verified: false, ...over });

describe('accounts file', () => {
  it('missing file is an empty store; save then lookup per host and by parent host', () => {
    expect(loadAccounts(file)).toEqual({ ok: true, accounts: {} });
    saveAccount('acme.wd5.myworkdayjobs.com', acct(), file);
    expect(getAccount('acme.wd5.myworkdayjobs.com', file)?.account.email).toBe('me@example.test');
    expect(getAccount('careers.acme.wd5.myworkdayjobs.com', file)?.key).toBe('acme.wd5.myworkdayjobs.com');
    expect(getAccount('other.wd5.myworkdayjobs.com', file)).toBeNull();
    expect(getAccount('myworkdayjobs.com', file)).toBeNull();
  });
  it('writes mode 0600 atomically and leaves no temp file', () => {
    saveAccount('a.example.test', acct(), file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['site-accounts.json']);
    saveAccount('b.example.test', acct({ email: 'x@example.test' }), file);
    expect(Object.keys((loadAccounts(file) as { accounts: object }).accounts).sort()).toEqual(['a.example.test', 'b.example.test']);
  });
  it('refuses a wide file mode, a symlink, a wide directory, a bad shape and bad JSON', () => {
    writeAccounts({ 'a.example.test': acct() }, file);
    fs.chmodSync(file, 0o644);
    expect(loadAccounts(file)).toMatchObject({ ok: false });
    fs.chmodSync(file, 0o600);
    expect(loadAccounts(file).ok).toBe(true);
    fs.chmodSync(dir, 0o755);
    expect(loadAccounts(file)).toMatchObject({ ok: false });
    fs.chmodSync(dir, 0o700);
    const real = path.join(dir, 'real.json');
    fs.renameSync(file, real);
    fs.symlinkSync(real, file);
    expect(loadAccounts(file)).toMatchObject({ ok: false, reason: expect.stringContaining('symlink') });
    fs.unlinkSync(file);
    fs.writeFileSync(file, '{"a.example.test":{"email":"x"}}', { mode: 0o600 });
    expect(loadAccounts(file)).toMatchObject({ ok: false });
    fs.writeFileSync(file, 'not json', { mode: 0o600 });
    expect(loadAccounts(file)).toMatchObject({ ok: false });
  });
  it('save refuses to run over an invalid store', () => {
    fs.writeFileSync(file, 'not json', { mode: 0o600 });
    expect(() => saveAccount('a.example.test', acct(), file)).toThrow();
  });
  it('markVerified, remove and listing never expose a password', () => {
    saveAccount('a.example.test', acct(), file);
    expect(markVerified('a.example.test', file)).toBe(true);
    expect(JSON.stringify(listAccounts(file))).not.toContain('Pw-1234567890-abc');
    expect(listAccounts(file)?.[0]).toMatchObject({ host: 'a.example.test', verified: true });
    expect(removeAccount('a.example.test', file)).toBe(true);
    expect(removeAccount('a.example.test', file)).toBe(false);
  });
  it('lookupAccount rejects invalid hosts', () => {
    expect(lookupAccount({}, '../etc')).toBeNull();
    expect(lookupAccount({}, 'localhost')).toBeNull();
  });
});

describe('generatePassword', () => {
  it('is unique, long, mixed-class; strict is longer with two of each class', () => {
    const a = generatePassword();
    expect(a).toHaveLength(20);
    expect(a).not.toBe(generatePassword());
    for (const re of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]) expect(re.test(a)).toBe(true);
    const s = generatePassword(true);
    expect(s.length).toBeGreaterThan(20);
    expect((s.match(/[^A-Za-z0-9]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((s.match(/[0-9]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('literal secrets', () => {
  it('redactSecrets and secretValuesFromEnv mask the stored email and password', () => {
    saveAccount('a.example.test', acct({ email: 'secret.owner@example.test', password: 'Zx-canary-9981-QQ' }), file);
    setSiteAccountsPathForTests(file);
    try {
      // Only the password is an outbound "secret value"; the email is redact-only.
      expect(secretValuesFromEnv({})).toContain('Zx-canary-9981-QQ');
      expect(secretValuesFromEnv({})).not.toContain('secret.owner@example.test');
      const out = redactSecrets('mail secret.owner@example.test pw Zx-canary-9981-QQ end');
      expect(out).not.toContain('Zx-canary-9981-QQ');
      expect(out).not.toContain('secret.owner@example.test');
    } finally { setSiteAccountsPathForTests(undefined); }
  });
  it('is cached by mtime and size, skips a wide-mode file or a symlink, and never reads the default path under test', () => {
    saveAccount('a.example.test', acct({ password: 'First-pw-123456' }), file);
    setSiteAccountsPathForTests(file);
    try {
      expect(siteAccountLiterals({}).passwords).toEqual(['First-pw-123456']);
      saveAccount('a.example.test', acct({ password: 'Second-pw-1234567' }), file);
      expect(siteAccountLiterals({}).passwords).toEqual(['Second-pw-1234567']);
      fs.chmodSync(file, 0o644);
      expect(siteAccountLiterals({})).toEqual({ emails: [], passwords: [] });
      fs.chmodSync(file, 0o600);
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(file, link);
      setSiteAccountsPathForTests(link);
      expect(siteAccountLiterals({}).passwords).toEqual([]);
      setSiteAccountsPathForTests(undefined);
      expect(siteAccountLiterals({})).toEqual({ emails: [], passwords: [] }); // VITEST: default path not read
    } finally { setSiteAccountsPathForTests(undefined); }
  });
  it('warns loudly on stderr, once, without values, when a loose account file is skipped', () => {
    saveAccount('a.example.test', acct({ password: 'Warn-pw-1234567' }), file);
    fs.chmodSync(file, 0o644);
    resetSiteSecretsWarningForTests();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setSiteAccountsPathForTests(file);
    try {
      siteAccountLiterals({}); siteAccountLiterals({});
      expect(err).toHaveBeenCalledTimes(1);
      const msg = String(err.mock.calls[0][0]);
      expect(msg).toMatch(/NOT masked/);
      expect(msg).not.toContain('Warn-pw-1234567');
    } finally { err.mockRestore(); setSiteAccountsPathForTests(undefined); resetSiteSecretsWarningForTests(); }
  });
  it('regression: outbound text with the owner email still passes the LinkedIn output gate when the account file exists', () => {
    saveAccount('a.example.test', acct({ email: 'owner.person@example.test', password: 'Zx-canary-9981-QQ' }), file);
    setSiteAccountsPathForTests(file);
    try {
      const env = { LINKEDIN_ALLOWED_EMAILS: 'owner.person@example.test' } as NodeJS.ProcessEnv;
      const cfg = loadLinkedinConfig(env);
      const ctx = outputGateContext({
        person: { profile_key: profileKeyOf('https://www.linkedin.com/in/jane-doe'), name: 'Jane Doe' } as never, actualProfileUrl: 'https://www.linkedin.com/in/jane-doe',
        rawPageText: '', cfg, env, factVerdict: 'pass',
      });
      expect(gateOutbound('Happy to talk, write to owner.person@example.test anytime.', ctx).reasons).toEqual([]);
      expect(gateOutbound('The password is Zx-canary-9981-QQ', ctx).reasons).toContain('env_secret_value');
    } finally { setSiteAccountsPathForTests(undefined); }
  });
});

describe('runner profile key gmail_sender_allowlist', () => {
  const write = (extra: unknown) => {
    const pol = JSON.parse(fs.readFileSync('config/run-profiles.json', 'utf8')) as { profiles: Record<string, Record<string, unknown>> };
    const p = pol.profiles;
    p.mail_test = { ...p.outreach_wake, gmail_sender_allowlist: extra };
    const f = path.join(dir, 'policy.json');
    fs.writeFileSync(f, JSON.stringify(pol));
    return f;
  };
  it('is accepted when boolean, carried into the rendered policy, and rejected otherwise', () => {
    const ok = loadProfiles(write(true), 'config/permission-sets.json');
    expect(ok.mail_test.gmail_sender_allowlist).toBe(true);
    expect((renderPolicy('mail_test', ok.mail_test) as { profiles: Record<string, { gmail_sender_allowlist?: boolean }> }).profiles.mail_test.gmail_sender_allowlist).toBe(true);
    expect(() => loadProfiles(write('yes'), 'config/permission-sets.json')).toThrow(/gmail_sender_allowlist/);
  });
});

describe('scripts/site-account', () => {
  it('add, list, status and remove never print the password', async () => {
    const { run } = await import('../scripts/site-account.js');
    const { scriptedIO } = await import('../src/setup/io.js');
    const pw = 'Hidden-pw-98765-ZZ';
    const io = scriptedIO([{ ask: 'owner.person@example.test' }, { secret: pw }]);
    const lines: string[] = [];
    lines.push(...(await run(['add', 'acme.example.test'], { path: file, io, env: {} as NodeJS.ProcessEnv })).lines);
    lines.push(...(await run(['list'], { path: file })).lines);
    lines.push(...(await run(['status'], { path: file, env: {} as NodeJS.ProcessEnv })).lines);
    expect(lines.join('\n')).toContain('acme.example.test');
    expect(lines.join('\n')).not.toContain(pw);
    expect((await run(['remove', 'acme.example.test'], { path: file })).code).toBe(0);
  });
  it('the account email passes the outbound gate only in webcore scope', () => {
    const base = { recipientKey: 'r', expectedRecipientKey: 'r', factVerdict: 'pass' as const };
    const text = 'sign in as me@example.test';
    expect(gateOutbound(text, { ...base, accountEmails: ['me@example.test'] }).reasons).toContain('email_not_allowed');
    expect(gateOutbound(text, { ...base, scope: 'webcore', accountEmails: ['me@example.test'], secretValues: ['me@example.test'] }).ok).toBe(true);
    expect(gateOutbound(text, { ...base, scope: 'webcore', accountEmails: ['other@example.test'] }).reasons).toContain('email_not_allowed');
  });
});
