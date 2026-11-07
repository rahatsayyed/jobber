import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noticesPath, NOTICE_KEEP_LINES, readNotices, recordNotice } from '../src/platform/noticeLog.js';
import { sendToTopic } from '../src/telegram/send.js';
import { makeHarness, type Harness } from './helpers/webHarness.js';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'notices-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('recordNotice', () => {
  it('writes a redacted plain line with mode 0600', () => {
    recordNotice(root, { topic: 'alerts', silent: false, html: true, text: '<b>Wake &amp; failed</b>\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 mail a@b.io' });
    const file = noticesPath(root);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const [n] = readNotices(root);
    expect(n!.title).toBe('Wake & failed');
    expect(n!.urgency).toBe('loud');
    expect(n!.text).not.toContain('<b>');
    expect(n!.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(n!.text).toContain('a@b.io');
  });
  it('bounds title and text', () => {
    recordNotice(root, { topic: 'wakes', silent: true, text: 'x'.repeat(5000) });
    const [n] = readNotices(root);
    expect(n!.title.length).toBeLessThanOrEqual(120);
    expect(n!.text.length).toBeLessThanOrEqual(1500);
    expect(n!.urgency).toBe('silent');
  });
  it('rotates to the last 500 lines past 1 MB and reads newest first, skipping bad lines', () => {
    mkdirSync(path.dirname(noticesPath(root)), { recursive: true });
    const line = (i: number) => JSON.stringify({ id: `i${i}`, at: '2026-01-01T00:00:00.000Z', topic: 'mail', urgency: 'silent', title: `t${i}`, text: 'y'.repeat(900) });
    writeFileSync(noticesPath(root), `${Array.from({ length: 1300 }, (_, i) => line(i)).join('\n')}\nnot json\n`);
    recordNotice(root, { topic: 'mail', silent: true, text: 'latest' });
    const lines = readFileSync(noticesPath(root), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(NOTICE_KEEP_LINES);
    const all = readNotices(root, { limit: 200 });
    expect(all[0]!.title).toBe('latest');
    expect(readNotices(root, { topic: 'alerts' })).toEqual([]);
  });
  it('never throws on an unwritable root', () => {
    const file = path.join(root, 'afile'); writeFileSync(file, 'x');
    expect(() => recordNotice(path.join(file, 'sub'), { topic: 'mail', silent: true, text: 'a' })).not.toThrow();
  });
});

describe('sendToTopic records', () => {
  it('records with no Telegram config', async () => {
    const r = await sendToTopic('inbox', 'Needs you: reply', { env: {}, root });
    expect(r.ok).toBe(false);
    expect(readNotices(root)[0]).toMatchObject({ topic: 'inbox', urgency: 'loud', title: 'Needs you: reply' });
  });
  it('records when fetch fails', async () => {
    const fetchFn = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const r = await sendToTopic('wakes', 'Wake done', { env: { TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_CHAT_ID: '5' }, root, fetchFn });
    expect(r.ok).toBe(false);
    expect(readNotices(root)[0]).toMatchObject({ topic: 'wakes', urgency: 'silent' });
  });
});

describe('GET /api/notices', () => {
  let h: Harness | null = null;
  afterEach(async () => { if (h) await h.close(); h = null; });
  it('needs auth, validates params and returns newest first', async () => {
    h = await makeHarness({ root });
    recordNotice(root, { topic: 'alerts', silent: false, text: 'first' });
    recordNotice(root, { topic: 'mail', silent: true, text: 'second' });
    expect((await h.call('GET', '/api/notices')).status).toBe(401);
    const { cookie } = await h.login();
    const get = (q: string) => h!.call('GET', `/api/notices${q}`, { headers: { cookie } });
    const ok = JSON.parse((await get('')).body) as { notices: { title: string }[]; topics: string[] };
    expect(ok.notices.map((n) => n.title)).toEqual(['second', 'first']);
    expect(ok.topics).toContain('linkedin');
    expect(JSON.parse((await get('?topic=alerts&limit=5')).body).notices).toHaveLength(1);
    for (const bad of ['?limit=0', '?limit=201', '?limit=abc', '?topic=nope']) expect((await get(bad)).status).toBe(400);
    expect(existsSync(noticesPath(root))).toBe(true);
  });
});
