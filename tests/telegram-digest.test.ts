// The Telegram digest: classification table, queue, digest content, one message per period, quiet hours, restart, off mode, escaping, status command.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import {
  KEY_DIGEST_LAST_AT, NOTICE_KINDS, composeDigest, digestEveryMin, digestOn, digestTickOnce, enqueueNotice, parseSince, renderStatusDigest,
  routeNotice, rowsSince, sanitizePayload, unsentRows, urgencyOf, type NoticeKind,
} from '../src/platform/digest.js';
import { wakeNoticeSpec } from '../src/scheduler/dripNotice.js';
import { getState } from '../src/scheduler/runLog.js';
import type { QuietConfig } from '../src/outreach/quiet.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const QUIET: QuietConfig = { quietStartHour: 22, quietEndHour: 7, tzOffsetMinutes: 330 };
const T0 = new Date('2026-11-20T06:00:00.000Z'); // 11:30 IST
const min = (m: number): number => m * 60_000;
const KINDS = Object.keys(NOTICE_KINDS) as NoticeKind[];

function posts() {
  const sent: Array<{ topic: string; text: string; silent?: boolean }> = [];
  return { sent, tg: async (topic: string, text: string, o?: { silent?: boolean }) => { sent.push({ topic, text, silent: o?.silent }); } };
}

describe('classification table', () => {
  it('every kind has urgency, topic and reason; the closed list covers the owner list', () => {
    for (const k of KINDS) {
      expect(['urgent', 'routine']).toContain(NOTICE_KINDS[k].urgency);
      expect(NOTICE_KINDS[k].reason.length, k).toBeGreaterThan(10);
    }
    for (const k of ['heal', 'classifier_block', 'fact_gate_block', 'dry_run_mismatch', 'daemon_down', 'window_down', 'usage_backoff', 'wake_blocked', 'mail_held', 'apply_needs_you', 'apply_captcha']) {
      expect(urgencyOf(k as NoticeKind), k).toBe('urgent');
    }
    for (const k of ['mail_sent', 'linkedin_action', 'linkedin_accept_check', 'wake_summary', 'manual_report', 'apply_done', 'jd_read']) {
      expect(urgencyOf(k as NoticeKind), k).toBe('routine');
    }
  });

  it('every urgent kind goes out at once and is never queued; every routine kind is queued and not sent', async () => {
    for (const k of KINDS) {
      const db = openDb(':memory:');
      const p = posts();
      const r = await routeNotice({ db, tg: p.tg, env: {}, now: () => T0 }, { kind: k, text: `<b>${k}</b>`, payload: { dry: false } });
      if (urgencyOf(k) === 'urgent') {
        expect(r, k).toBe('sent');
        expect(p.sent.map((x) => x.text), k).toEqual([`<b>${k}</b>`]);
        expect(p.sent[0].topic).toBe(NOTICE_KINDS[k].topic);
        expect(unsentRows(db), k).toHaveLength(0);
      } else {
        expect(r, k).toBe('queued');
        expect(p.sent, k).toHaveLength(0);
        expect(unsentRows(db).map((x) => x.kind), k).toEqual([k]);
      }
    }
  });

  it('TELEGRAM_DIGEST=off restores the old path: every routine notice is sent at once and nothing is queued', async () => {
    for (const k of KINDS.filter((x) => urgencyOf(x) === 'routine')) {
      const db = openDb(':memory:');
      const p = posts();
      const r = await routeNotice({ db, tg: p.tg, env: { TELEGRAM_DIGEST: ' OFF ' }, now: () => T0 }, { kind: k, text: 'x', silent: true });
      expect(r, k).toBe('sent');
      expect(p.sent).toEqual([{ topic: NOTICE_KINDS[k].topic, text: 'x', silent: true }]);
      expect(unsentRows(db)).toHaveLength(0);
    }
  });

  it('no Telegram setup means nothing at all; env helpers clamp', async () => {
    const db = openDb(':memory:');
    expect(await routeNotice({ db, env: {}, now: () => T0 }, { kind: 'mail_sent', text: 'x' })).toBe('dropped');
    expect(unsentRows(db)).toHaveLength(0);
    expect(digestOn({})).toBe(true);
    expect(digestOn({ TELEGRAM_DIGEST: 'off' })).toBe(false);
    expect(digestOn({ TELEGRAM_DIGEST: 'on' })).toBe(true);
    expect(digestEveryMin({})).toBe(60);
    expect(digestEveryMin({ TELEGRAM_DIGEST_EVERY_MIN: '5' })).toBe(15);
    expect(digestEveryMin({ TELEGRAM_DIGEST_EVERY_MIN: '99999' })).toBe(1440);
    expect(digestEveryMin({ TELEGRAM_DIGEST_EVERY_MIN: 'abc' })).toBe(60);
    expect(digestEveryMin({ TELEGRAM_DIGEST_EVERY_MIN: '120' })).toBe(120);
  });

  it('a wake summary is routine, a failed or blocked wake is urgent', () => {
    const base = { runId: 'wk000000aaaa', trigger: 'scheduled' };
    expect(wakeNoticeSpec({ ...base, status: 'ok', newJobs: 3 })?.kind).toBe('wake_summary');
    expect(wakeNoticeSpec({ ...base, status: 'failed', reason: 'x' })?.kind).toBe('wake_failed');
    expect(wakeNoticeSpec({ ...base, status: 'usage_limit' })?.kind).toBe('usage_backoff');
    expect(wakeNoticeSpec({ ...base, status: 'skipped', reason: 'killed' })?.kind).toBe('wake_blocked');
    expect(wakeNoticeSpec({ ...base, status: 'skipped', reason: 'ceilings_exhausted' })?.kind).toBe('wake_skipped');
    expect(wakeNoticeSpec({ ...base, status: 'skipped', reason: 'nothing_due' })).toBeNull();
    for (const k of ['wake_summary', 'wake_skipped', 'wake_blocked', 'wake_failed', 'usage_backoff'] as const) expect(NOTICE_KINDS[k]).toBeDefined();
  });
});

// Real mail is counted from the database (src/platform/digestFacts.ts), so a test that expects emails writes the rows the senders would write.
let seq = 0;
function dbCold(db: ReturnType<typeof openDb>, at: Date): void {
  db.prepare("INSERT INTO outreach_queue (job_id, email_status, email_sent_at) VALUES (?, 'sent', ?)").run(`j${++seq}`, at.toISOString());
}
function dbFollowup(db: ReturnType<typeof openDb>, at: Date): void {
  db.prepare("INSERT INTO followups (job_id, n, status, sent_at) VALUES ('j', 1, 'sent', ?)").run(at.toISOString());
}

function filled() {
  const db = openDb(':memory:');
  const at = (m: number): Date => new Date(T0.getTime() + min(m));
  for (let n = 0; n < 4; n++) { enqueueNotice(db, 'mail_sent', { kind: 'cold', dry: false }, at(n)); dbCold(db, at(n)); }
  enqueueNotice(db, 'mail_sent', { kind: 'followup', dry: false }, at(5));
  dbFollowup(db, at(5));
  enqueueNotice(db, 'linkedin_action', { action: 'invite', dry: false }, at(6));
  enqueueNotice(db, 'linkedin_action', { action: 'invite', dry: false }, at(7));
  enqueueNotice(db, 'linkedin_action', { action: 'dm', dry: false }, at(8));
  enqueueNotice(db, 'linkedin_accept_check', { action: 'accept_recent' }, at(9));
  enqueueNotice(db, 'replies_seen', { count: 2, needs: 1 }, at(10));
  enqueueNotice(db, 'wake_summary', { newJobs: 14, scored: 10, matched: 3, prepared: 2, emailsQueued: 2, sourceErrors: 2, stopped: 1, bySource: { remotive: 6, naukri: 8 } }, at(11));
  enqueueNotice(db, 'wake_summary', { newJobs: 0, scored: 0 }, at(12));
  return db;
}

describe('digest content', () => {
  it('groups sent, found, matched, replies, problems and the next step; prints the example', () => {
    const db = filled();
    const c = composeDigest(unsentRows(db), { from: T0, to: new Date(T0.getTime() + min(60)) }, 1);
    expect(c.empty).toBe(false);
    const t = c.text;
    expect(t).toMatch(/^⚠️ <b>Jobber summary 11:30 to 12:30 IST<\/b>/);
    expect(t).toContain('<b>Sent</b>\n• 5 emails (4 cold, 1 follow-up)\n• LinkedIn: invite 2, dm 1');
    expect(t).toContain('<b>Found</b>\n• 14 new jobs (naukri 8, remotive 6)');
    expect(t).toContain('• scored 10, matched 3');
    expect(t).toContain('• 2 prepared for outreach');
    expect(t).toContain('<b>Replies seen</b>\n• 2 email replies (1 need you)');
    expect(t).toContain('source errors 2: fallback readers retry at the next code pass');
    expect(t).toContain('stopped 1: unfinished work is due again at the next wake');
    expect(t).toContain('<b>Next for you</b>\n• 1 item needs you: send /escalations');
    expect(t).toContain('2 wakes ran');
    process.stdout.write(`\n--- example digest ---\n${t.replace(/<\/?[a-z]+>/g, '')}\n---\n`);
  });

  it('a dry run is shown as dry, not as sent; nothing gives an empty digest', () => {
    const db = openDb(':memory:');
    enqueueNotice(db, 'mail_sent', { kind: 'cold', dry: true }, T0);
    const c = composeDigest(unsentRows(db), { from: T0, to: T0 }, 0);
    expect(c.text).toContain('dry run, nothing really sent: 1 mail, 0 LinkedIn');
    expect(c.text).not.toContain('1 email');
    expect(composeDigest([], { from: T0, to: T0 }, 3).empty).toBe(true);
  });

  it('escapes untrusted text and redacts secret shapes; the queue never stores raw text', () => {
    const db = openDb(':memory:');
    const secret = `ghp_${'a'.repeat(36)}`;
    enqueueNotice(db, 'apply_done', { platform: `<b>x</b> ${secret}`, note: '<script>' }, T0);
    const row = unsentRows(db)[0];
    expect(JSON.stringify(row.payload)).not.toContain(secret);
    const c = composeDigest(unsentRows(db), { from: T0, to: T0 }, 0);
    expect(c.text).not.toContain('<script>');
    expect(c.text).not.toContain(secret);
    expect(c.text).not.toMatch(/<b>x<\/b>/);
    expect(c.text).toContain('&lt;b&gt;x&lt;/b&gt;');
    const s = sanitizePayload({ a: 1, b: 'x'.repeat(500), c: [1, 2], d: { e: 2 } });
    expect(Object.keys(s).sort()).toEqual(['a', 'b', 'd']); // arrays are dropped
    expect(String(s.b).length).toBeLessThanOrEqual(61);
  });
});

describe('digest tick', () => {
  function world(env: NodeJS.ProcessEnv = {}, dbPath = ':memory:') {
    const db = openDb(dbPath);
    let t = T0.getTime();
    const sent: string[] = [];
    let ok = true;
    const d = () => ({ db, env, now: () => new Date(t), quiet: QUIET, send: async (text: string) => { if (ok) sent.push(text); return { ok }; } });
    return { db, sent, d, advance: (m: number) => { t += min(m); }, setOk: (v: boolean) => { ok = v; }, now: () => new Date(t) };
  }

  it('one message per period; the first tick only starts the period; nothing when empty', async () => {
    const w = world();
    enqueueNotice(w.db, 'mail_sent', { kind: 'cold' }, w.now());
    expect(await digestTickOnce(w.d())).toBe('not_due'); // starts the period
    w.advance(30);
    expect(await digestTickOnce(w.d())).toBe('not_due');
    w.advance(31);
    expect(await digestTickOnce(w.d())).toBe('sent');
    expect(w.sent).toHaveLength(1);
    expect(unsentRows(w.db)).toHaveLength(0);
    w.advance(61);
    expect(await digestTickOnce(w.d())).toBe('empty'); // nothing happened: no message
    expect(w.sent).toHaveLength(1);
    enqueueNotice(w.db, 'mail_sent', { kind: 'cold' }, w.now());
    expect(await digestTickOnce(w.d())).toBe('not_due'); // the empty hour restarted the period
    w.advance(61);
    expect(await digestTickOnce(w.d())).toBe('sent');
    expect(w.sent).toHaveLength(2);
    expect(await digestTickOnce(w.d())).toBe('not_due'); // never twice in one period
  });

  it('quiet hours send nothing; the first digest after holds the whole span', async () => {
    const w = world({ TELEGRAM_DIGEST_EVERY_MIN: '60' });
    await digestTickOnce(w.d());
    w.advance(600); // 10 h later: 21:30 IST (quiet hours are 22:00 to 07:00)
    enqueueNotice(w.db, 'mail_sent', { kind: 'cold' }, w.now());
    dbCold(w.db, w.now());
    w.advance(60); // 22:30 IST
    enqueueNotice(w.db, 'mail_sent', { kind: 'cold' }, w.now());
    dbCold(w.db, w.now());
    expect(await digestTickOnce(w.d())).toBe('quiet');
    w.advance(60 * 8); // 06:30 IST, still quiet (until 07:00)
    expect(await digestTickOnce(w.d())).toBe('quiet');
    w.advance(40); // 07:10 IST
    expect(await digestTickOnce(w.d())).toBe('sent');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain('2 emails');
    expect(w.sent[0]).toMatch(/Jobber summary \d{2}-\d{2} /); // a span over two days shows the date
  });

  it('rows survive a restart and are marked sent only after Telegram accepted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-'));
    dirs.push(dir);
    const file = join(dir, 'db.sqlite');
    const a = world({}, file);
    await digestTickOnce(a.d());
    enqueueNotice(a.db, 'mail_sent', { kind: 'cold' }, a.now());
    a.db.close();
    const b = world({}, file); // a new process with the same file
    b.advance(61);
    b.setOk(false);
    expect(await digestTickOnce(b.d())).toBe('send_failed');
    expect(unsentRows(b.db)).toHaveLength(1); // still queued
    b.setOk(true);
    expect(await digestTickOnce(b.d())).toBe('sent');
    expect(unsentRows(b.db)).toHaveLength(0);
    expect(getState(b.db, KEY_DIGEST_LAST_AT)).toBe(b.now().toISOString());
  });

  it('TELEGRAM_DIGEST=off: the tick does nothing', async () => {
    const w = world({ TELEGRAM_DIGEST: 'off' });
    enqueueNotice(w.db, 'mail_sent', { kind: 'cold' }, w.now());
    w.advance(500);
    expect(await digestTickOnce(w.d())).toBe('off');
    expect(w.sent).toHaveLength(0);
  });
});

describe('status digest (npx tsx scripts/status.ts digest)', () => {
  it('prints the digest of the last hour, sent or not, and the empty line', () => {
    const db = filled();
    const now = new Date(T0.getTime() + min(30));
    const out = renderStatusDigest(db, now, min(60));
    expect(out).toContain('Jobber summary 11:00 to 12:00 IST');
    expect(out).toContain('5 emails (4 cold, 1 follow-up)');
    expect(out).not.toMatch(/<[a-z]+>/); // plain text
    const later = renderStatusDigest(db, new Date(T0.getTime() + min(60 * 5)), min(60));
    expect(later).toBe('nothing happened in the last 1h');
    expect(rowsSince(db, new Date(T0.getTime() - min(5)).toISOString()).length).toBeGreaterThan(5);
    expect(renderStatusDigest(openDb(':memory:'), now, min(180))).toBe('nothing happened in the last 3h');
  });

  it('parses the --since span', () => {
    expect(parseSince('3h')).toBe(3 * 3_600_000);
    expect(parseSince('90m')).toBe(90 * 60_000);
    expect(parseSince('2d')).toBe(2 * 86_400_000);
    expect(parseSince('2')).toBe(2 * 3_600_000);
    expect(parseSince('soon')).toBeNull();
    expect(parseSince(undefined)).toBeNull();
    expect(parseSince('0h')).toBeNull();
  });
});
