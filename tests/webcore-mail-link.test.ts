import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createWebRuntime } from '../src/webcore/runtime.js';
import { extractVerificationLinks, parseSenders, siteOpenLink, verificationMode } from '../src/webcore/mailLink.js';
import { createFakeSite } from './helpers/fakeSitePage.js';

describe('verificationMode (O-email)', () => {
  it('defaults to owner_assist; senders alone never switch to gmail', () => {
    expect(verificationMode({} as NodeJS.ProcessEnv)).toBe('owner_assist');
    expect(verificationMode({ SITE_MAIL_SENDERS: 'no-reply@acme.example.test' } as NodeJS.ProcessEnv)).toBe('owner_assist');
    expect(verificationMode({ SITE_MAIL_VERIFY: 'owner_assist', SITE_MAIL_SENDERS: 'a@acme.example.test' } as NodeJS.ProcessEnv)).toBe('owner_assist');
  });
  it('gmail with an empty or invalid allowlist behaves as owner_assist; gmail with senders is gmail; off is off', () => {
    expect(verificationMode({ SITE_MAIL_VERIFY: 'gmail' } as NodeJS.ProcessEnv)).toBe('owner_assist');
    expect(verificationMode({ SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: ' , nonsense' } as NodeJS.ProcessEnv)).toBe('owner_assist');
    expect(verificationMode({ SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: 'no-reply@acme.example.test' } as NodeJS.ProcessEnv)).toBe('gmail');
    expect(verificationMode({ SITE_MAIL_VERIFY: 'off', SITE_MAIL_SENDERS: 'a@acme.example.test' } as NodeJS.ProcessEnv)).toBe('off');
  });
  it('parseSenders lowercases and keeps address and @domain entries', () => {
    expect(parseSenders({ SITE_MAIL_SENDERS: 'No-Reply@Acme.example.test, @jobs.example.test' } as NodeJS.ProcessEnv)).toEqual(['no-reply@acme.example.test', '@jobs.example.test']);
  });
});

const HOSTS = ['acme.example.test'];
const SENDERS = ['no-reply@acme.example.test'];
const mail = (from: string, body: string) => `From: ${from}\nSubject: Verify\n\n${body}`;

describe('extractVerificationLinks', () => {
  const ok = 'https://login.acme.example.test/verify?x=1';
  const cases: Array<[string, string, string[]]> = [
    ['good link, allowlisted sender', mail('Acme <no-reply@acme.example.test>', `Click ${ok}.`), [ok]],
    ['token parameter without a verify path', mail('no-reply@acme.example.test', 'go https://acme.example.test/a?token=abc123'), ['https://acme.example.test/a?token=abc123']],
    ['off-host', mail('no-reply@acme.example.test', 'https://evil.example.org/verify?x=1'), []],
    ['look-alike host', mail('no-reply@acme.example.test', 'https://evilacme.example.test/verify'), []],
    ['http', mail('no-reply@acme.example.test', 'http://acme.example.test/verify'), []],
    ['credentials', mail('no-reply@acme.example.test', 'https://u:p@acme.example.test/verify'), []],
    ['no verify path or token', mail('no-reply@acme.example.test', 'https://acme.example.test/careers?utm=1'), []],
    ['sender not allowlisted', mail('phish@evil.example.org', ok), []],
    ['no From header', `Subject: x\n\n${ok}`, []],
    ['multi-host mail yields exactly one link', mail('no-reply@acme.example.test', `https://evil.example.org/verify https://acme.example.test/confirm/1 https://acme.example.test/verify/2`), ['https://acme.example.test/confirm/1']],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => { expect(extractVerificationLinks(text, { senders: SENDERS, hosts: HOSTS })).toEqual(want); });
  }
  it('without a sender list the From header is not checked (owner_assist) but the host rule is', () => {
    expect(extractVerificationLinks(`x ${ok}`, { hosts: HOSTS })).toEqual([ok]);
    expect(extractVerificationLinks('x https://evil.example.org/verify', { hosts: HOSTS })).toEqual([]);
  });
});

describe('siteOpenLink', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-ml-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const LIVE = { SCHEDULER_DRY_RUN: 'false', WEB_DRY_RUN: 'false', APPLY_DRY_RUN: 'false', SCOUT_DRY_RUN: 'false' } as NodeJS.ProcessEnv;
  async function setup(env: NodeJS.ProcessEnv) {
    const db = openDb(':memory:');
    const site = createFakeSite({ start: 'wd-verify-email.html', url: 'https://acme.example.test/' });
    const runtime = createWebRuntime({ db, launcher: site.launcher, lockPath: path.join(dir, 'l.lock'), sessionDir: path.join(dir, 's'), config: { minGapSec: 0, settleMs: 0 } });
    await runtime.open('https://acme.example.test/', { allowedHosts: HOSTS, jobId: 'j' });
    return { db, site, runtime, deps: { runtime, db, hosts: HOSTS, env } };
  }
  it('opens a bare in-host link and a link inside pasted text', async () => {
    const s = await setup(LIVE);
    expect(await siteOpenLink({ url_or_message_text: 'https://acme.example.test/verify?t=1' }, s.deps)).toMatchObject({ status: 'opened' });
    const pasted = await siteOpenLink({ url_or_message_text: 'hi\nhttps://acme.example.test/confirm/abc' }, s.deps);
    expect(pasted).toMatchObject({ status: 'opened' });
  });
  it('refuses off-host, non-verify and http input with one rule', async () => {
    const s = await setup(LIVE);
    for (const t of ['https://evil.example.org/verify', 'https://acme.example.test/careers', 'http://acme.example.test/verify', 'javascript:alert(1)', 'nothing here']) {
      expect(await siteOpenLink({ url_or_message_text: t }, s.deps)).toMatchObject({ status: 'refused', code: 'no_link' });
    }
  });
  it('gmail mode requires an allowlisted From on pasted text; off refuses; dry run records and does not navigate', async () => {
    const g = await setup({ ...LIVE, SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: SENDERS.join(',') });
    expect(await siteOpenLink({ url_or_message_text: mail('x@evil.example.org', 'https://acme.example.test/verify') }, g.deps)).toMatchObject({ code: 'no_link' });
    expect(await siteOpenLink({ url_or_message_text: mail(SENDERS[0], 'https://acme.example.test/verify') }, g.deps)).toMatchObject({ status: 'opened' });
    const off = await setup({ ...LIVE, SITE_MAIL_VERIFY: 'off' });
    expect(await siteOpenLink({ url_or_message_text: 'https://acme.example.test/verify' }, off.deps)).toMatchObject({ code: 'mode_off' });
    const dry = await setup({} as NodeJS.ProcessEnv);
    const before = dry.site.events.length;
    expect(await siteOpenLink({ url_or_message_text: 'https://acme.example.test/verify' }, dry.deps)).toEqual({ status: 'dry_run' });
    expect(dry.site.events.length).toBe(before);
    expect((dry.db.prepare('SELECT COUNT(*) n FROM dry_run_actions').get() as { n: number }).n).toBe(1);
  });
});
