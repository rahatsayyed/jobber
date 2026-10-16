import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generatePassword, listAccounts, loadAccounts, lookupAccount, markVerified, removeAccount, saveAccount, writeAccounts, getAccount,
} from '../src/webcore/accounts.js';
import { redactSecrets } from '../src/safety/redact.js';
import { gateOutbound, secretValuesFromEnv } from '../src/safety/outputGate.js';

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
    const env = { SITE_ACCOUNTS_FILE: file } as NodeJS.ProcessEnv;
    expect(secretValuesFromEnv(env)).toEqual(expect.arrayContaining(['secret.owner@example.test', 'Zx-canary-9981-QQ']));
    const prev = process.env.SITE_ACCOUNTS_FILE;
    process.env.SITE_ACCOUNTS_FILE = file;
    try {
      const out = redactSecrets('mail secret.owner@example.test pw Zx-canary-9981-QQ end');
      expect(out).not.toContain('Zx-canary-9981-QQ');
      expect(out).not.toContain('secret.owner@example.test');
    } finally {
      if (prev === undefined) delete process.env.SITE_ACCOUNTS_FILE; else process.env.SITE_ACCOUNTS_FILE = prev;
    }
  });
  it('the account email passes the outbound gate only in webcore scope', () => {
    const base = { recipientKey: 'r', expectedRecipientKey: 'r', factVerdict: 'pass' as const };
    const text = 'sign in as me@example.test';
    expect(gateOutbound(text, { ...base, accountEmails: ['me@example.test'] }).reasons).toContain('email_not_allowed');
    expect(gateOutbound(text, { ...base, scope: 'webcore', accountEmails: ['me@example.test'], secretValues: ['me@example.test'] }).ok).toBe(true);
    expect(gateOutbound(text, { ...base, scope: 'webcore', accountEmails: ['other@example.test'] }).reasons).toContain('email_not_allowed');
  });
});
