// Code-sent Telegram notices of the wakes and the drip lanes (src/scheduler/dripNotice.ts and the lanes that call it). Fakes only:
// no Telegram, no tmux, no claude.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { upsertPerson } from '../src/outreach/people.js';
import { markdownToHtmlChunks } from '../src/telegram/format.js';
import type { TopicName } from '../src/telegram/topics.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import { wakeOnce } from '../src/scheduler/driver.js';
import { StreamInspector } from '../src/scheduler/stream.js';
import type { LaunchHandle, LaunchPlan, Launcher, PollResult } from '../src/scheduler/launch.js';
import { dripTick } from '../src/scheduler/mailDrip.js';
import { LI_STATE_INBOX_AT, linkedinDripTick } from '../src/scheduler/linkedinDrip.js';
import { setState } from '../src/scheduler/runLog.js';
import {
  formatLinkedinNotice, formatMailNotice, maskAddress, notifyTg, tidy, wakeNotice, type TgPost,
} from '../src/scheduler/dripNotice.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST: inside the send window and the LinkedIn active hours
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });
const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

describe('formatting', () => {
  it('masks an address as j***@domain and never shows the local part', () => {
    expect(maskAddress('jane.doe@acme.example')).toBe('j***@acme.example');
    expect(maskAddress('x')).toBe('***');
    expect(maskAddress(null)).toBe('***');
    expect(maskAddress('a@b@evil.example<script>')).not.toMatch(/[<>]/);
  });

  it('mail notice: cold vs follow-up, masked address, dry run wording', () => {
    const cold = formatMailNotice({ kind: 'cold', company: 'Acme', title: 'React Dev', address: 'jane@acme.example', dry: false });
    expect(cold).toBe('Mail sent: cold email to Acme, React Dev (j***@acme.example)');
    expect(formatMailNotice({ kind: 'followup', company: 'Acme', title: 'React Dev', address: 'jane@acme.example', dry: false })).toMatch(/follow-up/);
    const dry = formatMailNotice({ kind: 'cold', company: 'Acme', title: 'React Dev', address: 'jane@acme.example', dry: true });
    expect(dry).toMatch(/^dry run: would send/);
    expect(dry).not.toMatch(/Mail sent/);
    expect(cold + dry).not.toContain('jane@');
  });

  it('third-party text loses markdown marks and is HTML-escaped by the format layer', () => {
    expect(tidy('A*cme_ `x` [y]\n<b>z</b>')).toBe('Acme x y <b>z</b>');
    const text = formatMailNotice({ kind: 'cold', company: '<b>Evil</b> & Co', title: '*bold* `code`', address: 'a@b.example', dry: false });
    const html = markdownToHtmlChunks(text).join('');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
    expect(html).not.toContain('<b>Evil');
    expect(html).not.toContain('<code>');
    expect(html).not.toContain('<i>');
  });

  it('LinkedIn notice: label, person and company, dry run and failure', () => {
    expect(formatLinkedinNotice({ kind: 'invite', name: 'Jane Roe', company: 'Acme', dry: false, ok: true })).toBe('LinkedIn invite: Jane Roe, Acme');
    expect(formatLinkedinNotice({ kind: 'accept_recent', dry: false, ok: true })).toBe('LinkedIn accept check');
    expect(formatLinkedinNotice({ kind: 'dm', name: 'Jane', dry: true, ok: true })).toMatch(/^dry run: LinkedIn DM: Jane; nothing was sent/);
    expect(formatLinkedinNotice({ kind: 'dm', name: 'Jane', dry: false, ok: false, reason: 'exit 1' })).toMatch(/did not end cleanly/);
  });
});

describe('wake notice routing', () => {
  const base = { runId: 'abcdef0123456789', trigger: 'scheduled' };
  it('ok wake: wakes topic with id, trigger, status, duration, counts and extras', () => {
    const n = wakeNotice({ ...base, status: 'ok', durationSec: 125, counts: { done: 4, skipped: 1, escalated: 0, stopped: 0 }, newJobs: 12, queued: 3 });
    expect(n?.topic).toBe('wakes');
    expect(n?.text).toContain('Wake abcdef01 ok (scheduled), 2m 5s');
    expect(n?.text).toContain('done 4, skipped 1, escalated 0, stopped 0');
    expect(n?.text).toContain('new jobs 12, queued outreach 3');
  });
  it('failure statuses go to alerts with the reason', () => {
    for (const status of ['failed', 'budget_exceeded', 'usage_limit', 'incomplete', 'crashed']) {
      const n = wakeNotice({ ...base, status, reason: 'stalled' });
      expect(n?.topic).toBe('alerts');
      expect(n?.text).toContain('stalled');
    }
  });
  it('skips: killed, halted and ceilings_exhausted are told; quiet_hours and nothing_due are silent', () => {
    for (const reason of ['killed', 'halted', 'ceilings_exhausted']) expect(wakeNotice({ ...base, status: 'skipped', reason })?.topic).toBe('wakes');
    for (const reason of ['quiet_hours', 'nothing_due', 'locked', 'usage_backoff']) expect(wakeNotice({ ...base, status: 'skipped', reason })).toBeNull();
  });
  it('the stream inspector sums the done, skipped, escalated and stopped counts of the final line', () => {
    const i = new StreamInspector();
    const line = JSON.stringify({ type: 'result', result: `done\n${JSON.stringify({ run_id: 'r1', operators: [
      { operator: 'a', tasks: [{ kind: 'x', done: 2, skipped: 1, escalated: 0, stopped: false }, { kind: 'y', done: 1, skipped: 0, escalated: 1, stopped: true }] },
      { operator: 'b', tasks: [{ kind: 'z', done: 3 }] },
    ] })}` });
    i.feed(`${line}\n`);
    i.finish();
    expect(i.report(['r1'])?.counts).toEqual({ done: 6, skipped: 1, escalated: 1, stopped: 1 });
  });
});

describe('notifyTg', () => {
  it('does nothing without a sender, swallows a throw and gives up on a hang', async () => {
    await notifyTg({}, 'drips', 'x');
    await notifyTg({ tg: async () => { throw new Error('boom'); } }, 'drips', 'x');
    const t0 = Date.now();
    await notifyTg({ tg: () => new Promise(() => undefined) }, 'drips', 'x', 30);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

class FakeLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  exitCode = 0;
  constructor(private onStart: (plan: LaunchPlan) => void) {}
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    this.onStart(plan);
    return { runId: plan.runId, session: plan.session, window: `w-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> { return { exited: true, exitCode: this.exitCode, newOutput: '' }; }
  async kill(): Promise<void> {}
}

function setup(opts: { env?: NodeJS.ProcessEnv; tg?: TgPost; sends?: boolean; start?: Date } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drip-notice-'));
  dirs.push(dir);
  let t = (opts.start ?? NOON_IST).getTime();
  const env = opts.env ?? {};
  const db = openDb(':memory:');
  const clock = (): Date => new Date(t);
  const posts: Array<{ topic: TopicName; text: string }> = [];
  const launcher = new FakeLauncher((plan) => {
    if (opts.sends === false) return;
    const m = /outreach_queue row id (\d+)/.exec(plan.prompt);
    if (m) db.prepare("UPDATE outreach_queue SET email_status = 'sent', email_sent_at = ? WHERE id = ?").run(sqlTime(clock()), Number(m[1]));
  });
  const d: DriverDeps = {
    db, now: clock, rng: () => 0, sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), runDir: join(dir, 'runs'), projectRoot: dir,
    launcher, notifier: { notify: async () => undefined },
    tg: opts.tg ?? (async (topic, text) => { posts.push({ topic, text }); }),
    newRunId: (() => { let i = 0; return () => `n${String(++i).padStart(7, '0')}`; })(),
    pollMs: 5000,
  };
  const queue = (n: number): number[] => {
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', ?, 'hr', 1, 't', 0.9)").run(`person${i}@co${i}.example`);
      db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES (?, 't', ?, ?, 'u')").run(`job${i}`, `Dev_${i} *x*`, `<b>Acme${i}</b>`);
      ids.push(Number(db.prepare("INSERT INTO outreach_queue (job_id, email_subject, email_body, email_to) VALUES (?, 's', 'b', ?)").run(`job${i}`, `person${i}@co${i}.example`).lastInsertRowid));
    }
    return ids;
  };
  return { d, db, launcher, posts, queue, now: clock };
}

describe('mail drip lane notices', () => {
  it('one drips line per real send, address masked, third-party text cleaned', async () => {
    const s = setup();
    s.queue(5);
    const r = await dripTick(s.d);
    expect(r.status).toBe('ran');
    expect(s.posts).toHaveLength(r.runs?.length ?? -1);
    for (const p of s.posts) {
      expect(p.topic).toBe('drips');
      expect(p.text).toMatch(/^Mail sent: cold email to <b>Acme\d<\/b>, Dev\d x \(p\*\*\*@co\d\.example\)$/);
      expect(p.text).not.toContain('person');
    }
  });

  it('a no-op tick posts nothing', async () => {
    const s = setup();
    expect(await dripTick(s.d)).toMatchObject({ status: 'skipped', reason: 'nothing_queued' });
    expect(s.posts).toHaveLength(0);
  });

  it('a dry run says "dry run" and never claims a send', async () => {
    const s = setup({ env: { JOBBER_DRY_RUN: '1' }, sends: false });
    s.queue(2);
    await dripTick(s.d);
    expect(s.posts.length).toBeGreaterThan(0);
    for (const p of s.posts) {
      expect(p.topic).toBe('drips');
      expect(p.text).toMatch(/^dry run: would send/);
    }
  });

  it('a held (quarantined) row is told on drips and not as a send or an alert', async () => {
    const s = setup({ sends: false });
    s.queue(1);
    await dripTick(s.d);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toMatchObject({ topic: 'drips' });
    expect(s.posts[0]?.text).toMatch(/is held/);
    expect(s.posts[0]?.text).not.toMatch(/Mail sent/);
  });

  it('a failed run that did record a send goes to alerts', async () => {
    const s = setup();
    s.launcher.exitCode = 1;
    s.queue(1);
    await dripTick(s.d);
    expect(s.posts.map((p) => p.topic)).toEqual(['alerts']);
    expect(s.posts[0]?.text).toMatch(/Mail drip run failed/);
  });

  it('a notice that throws or hangs does not break the lane', async () => {
    const boom = setup({ tg: async () => { throw new Error('telegram down'); } });
    boom.queue(3);
    const r = await dripTick(boom.d);
    expect(r.status).toBe('ran');
    expect((boom.db.prepare("SELECT COUNT(*) AS n FROM outreach_queue WHERE email_status = 'sent'").get() as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('LinkedIn drip lane notices', () => {
  const dmDue = (s: ReturnType<typeof setup>): void => {
    const id = upsertPerson(s.db, { platform: 'linkedin', profileKey: 'linkedin.com/in/jane', name: 'Jane *Roe*', headline: 'Recruiter at Acme', company: 'Acme', category: 'recruiter' });
    s.db.prepare('UPDATE contact_state SET stage = ?, cycle_started_at = ? WHERE person_id = ?').run('active', new Date(s.now().getTime() - 30 * 86400_000).toISOString(), id);
    s.db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'connect', 'c-jane', 'sent', ?)").run(id, new Date(s.now().getTime() - 10 * 86400_000).toISOString());
    s.db.prepare("INSERT INTO connections (profile_url, status) VALUES (?, 'connected')").run('https://www.linkedin.com/in/jane');
    setState(s.db, LI_STATE_INBOX_AT, s.now().toISOString(), s.now()); // inbox not due: the DM is the item
  };

  it('a DM line names the person and the company; a no-op tick posts nothing', async () => {
    const empty = setup();
    setState(empty.db, LI_STATE_INBOX_AT, empty.now().toISOString(), empty.now());
    const none = await linkedinDripTick(empty.d);
    if (none.status === 'skipped') expect(empty.posts).toHaveLength(0);
    const s = setup();
    dmDue(s);
    const r = await linkedinDripTick(s.d);
    expect(r.status).toBe('ran');
    expect(s.posts).toEqual([{ topic: 'drips', text: 'LinkedIn DM: Jane Roe, Acme' }]);
  });

  it('a failed run goes to alerts, a dry run says dry run, a throwing notice changes nothing', async () => {
    const f = setup();
    dmDue(f);
    f.launcher.exitCode = 1;
    await linkedinDripTick(f.d);
    expect(f.posts.map((p) => p.topic)).toEqual(['alerts']);
    const dry = setup({ env: { JOBBER_DRY_RUN: '1' } });
    dmDue(dry);
    await linkedinDripTick(dry.d);
    expect(dry.posts[0]?.text).toMatch(/^dry run: LinkedIn DM/);
    const boom = setup({ tg: async () => { throw new Error('down'); } });
    dmDue(boom);
    expect((await linkedinDripTick(boom.d)).status).toBe('ran');
  });
});

describe('wake notices from the driver', () => {
  const wakeDeps = (env: NodeJS.ProcessEnv = {}, start = new Date('2026-10-14T21:00:00.000Z')) => {
    const s = setup({ env, start });
    return s;
  };
  it('a skipped wake is told once per reason for killed, silent for quiet_hours', async () => {
    const quiet = wakeDeps();
    await wakeOnce(quiet.d, {});
    expect(quiet.posts).toHaveLength(0); // 02:30 IST is quiet hours
    const killed = setup({ start: NOON_IST });
    killed.d.control = { exists: () => true, read: () => 'stop' };
    const r1 = await wakeOnce(killed.d, { force: true });
    expect(r1).toMatchObject({ status: 'skipped', reason: 'killed' });
    const r2 = await wakeOnce(killed.d, { force: true });
    expect(r2.status).toBe('skipped');
    const told = killed.posts.filter((p) => p.topic === 'wakes');
    expect(told).toHaveLength(1);
    expect(told[0]?.text).toMatch(/^Wake n0000001 skipped \(forced\): killed/);
  });
});
