import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { handleOpen } from '../src/applier/tools/open.js';
import { haltPlatform, recordEvent } from '../src/outreach/limits.js';
import { noteBlock } from '../src/webcore/signup.js';
import { count, HOST, makeApplier, type ApplierHarness, type HarnessOpts } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });
const setup = (o: HarnessOpts = {}): ApplierHarness => (h = makeApplier(o));
const open = (x: ApplierHarness, job_id = 'job-1') => handleOpen({ job_id }, x.deps);
const noPage = (x: ApplierHarness) => expect(x.site.events).toEqual([]);

describe('apply_open refusals', () => {
  it('open refuses: unknown job', async () => {
    const x = setup();
    expect(await open(x, 'nope')).toMatchObject({ status: 'refused', code: 'unknown_job' });
    noPage(x);
  });

  it('open refuses: veto and hard stop', async () => {
    let x = setup();
    x.db.prepare("UPDATE jobs SET excluded_reason = 'location FAIL' WHERE id = 'job-1'").run();
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'vetoed' });
    noPage(x);
    await x.close();
    x = setup();
    x.db.prepare("UPDATE jobs SET hard_stops = ? WHERE id = 'job-1'").run(JSON.stringify(['no sponsorship']));
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'hard_stop' });
    noPage(x);
  });

  it('open refuses: class none, look-alike and non-http(s)', async () => {
    for (const [url, source] of [
      ['https://evil-greenhouse.io/acme/1', 'remotive'],
      ['javascript:alert(1)', 'remotive'],
      ['https://unknown-company.example/jobs/1', 'remotive'],
      ['https://boards.greenhouse.io/acme/1', 'workday'],
    ] as const) {
      const x = setup({ applyUrl: url, source, jobId: 'job-1' });
      const r = await open(x);
      expect(r, url).toMatchObject({ status: 'refused', code: 'class_none' });
      noPage(x);
      await x.close();
      h = null;
    }
  });

  it('open refuses: a queue row already classified never', async () => {
    const x = setup({ tier: 'never', platform: 'none' });
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'class_none' });
  });

  it('open refuses: a platform the web applier does not drive', async () => {
    const x = setup({ applyUrl: 'https://www.naukri.com/job-listings-x-123', jobId: 'job-1' });
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'unsupported_platform' });
  });

  it('open refuses: no resume', async () => {
    let x = setup({ resume: false });
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'no_resume' });
    noPage(x);
    await x.close();
    x = setup({ queue: false });
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'no_resume' });
    await x.close();
    x = setup();
    fs.rmSync(x.resumePath);
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'no_resume' });
    expect(count(x.db, "SELECT COUNT(*) n FROM rate_events WHERE key='apply_attempt'")).toBe(0);
  });

  it('open refuses: already applied', async () => {
    const x = setup();
    x.db.prepare("INSERT INTO applications (job_id, platform, method, status) VALUES ('job-1','greenhouse','browser','submitted')").run();
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'already_applied' });
  });

  it('open refuses: a clicked but unconfirmed submit waits for the owner', async () => {
    const x = setup();
    x.db.prepare("INSERT INTO applications (job_id, platform, method, status) VALUES ('job-1','greenhouse','browser','manual_review')").run();
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'already_attempted' });
    noPage(x);
  });

  it('open refuses: halt (apply, web, all)', async () => {
    for (const p of ['apply', 'web', 'all']) {
      const x = setup();
      haltPlatform(x.db, p, 'owner stop', new Date());
      expect(await open(x), p).toMatchObject({ status: 'refused', code: 'halted' });
      noPage(x);
      expect(count(x.db, "SELECT COUNT(*) n FROM rate_events WHERE key='apply_attempt'")).toBe(0);
      await x.close();
      h = null;
    }
  });

  it('open refuses: STOP file and JOBBER_KILL', async () => {
    let x = setup();
    fs.writeFileSync(x.stopFile, 'stop\n');
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'killed' });
    noPage(x);
    await x.close();
    x = setup({ env: { JOBBER_KILL: '1' } });
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'killed' });
  });

  it('open refuses: host cooldown', async () => {
    const x = setup();
    noteBlock(HOST); noteBlock(HOST);
    expect(await open(x)).toMatchObject({ status: 'refused', code: 'host_cooldown' });
    noPage(x);
  });

  it('open refuses: per-host gap', async () => {
    const x = setup({ env: { WEB_MIN_GAP_SEC: '30' } });
    expect(await open(x)).toMatchObject({ status: 'ok' });
    const second = await open(x);
    expect(second).toMatchObject({ status: 'refused', code: 'host_gap' });
    expect(typeof (second as { retry_after_sec?: number }).retry_after_sec).toBe('number');
    expect(count(x.db, "SELECT COUNT(*) n FROM rate_events WHERE key='apply_attempt'")).toBe(1);
  });

  it('open refuses: attempt cap', async () => {
    const x = setup({ env: { APPLY_MAX_ATTEMPTS_PER_DAY: '1' } });
    recordEvent(x.db, 'apply_attempt', new Date());
    expect(await open(x)).toMatchObject({ status: 'rate_limited', code: 'attempt_cap' });
    noPage(x);
    expect(count(x.db, "SELECT COUNT(*) n FROM rate_events WHERE key='apply_attempt'")).toBe(1);
  });

  it('open refuses: per-host cap', async () => {
    const x = setup({ env: { APPLY_MAX_PER_HOST_GREENHOUSE: '2' } });
    x.db.prepare("INSERT INTO apply_host_day (host, day, count) VALUES (?, date('now'), 2)").run(HOST);
    expect(await open(x)).toMatchObject({ status: 'rate_limited', code: 'host_cap' });
    noPage(x);
    expect(count(x.db, "SELECT COUNT(*) n FROM rate_events WHERE key='apply_attempt'")).toBe(0);
  });
});

describe('apply_open success', () => {
  it('open consumes only apply_attempt', async () => {
    const x = setup();
    const r = await open(x);
    expect(r).toMatchObject({ status: 'ok', code: 'opened', platform: 'greenhouse', host: HOST });
    expect(typeof (r as { state?: string }).state).toBe('string');
    expect(count(x.db, "SELECT COUNT(*) n FROM rate_events WHERE key='apply_attempt'")).toBe(1);
    expect(count(x.db, "SELECT COUNT(*) n FROM rate_events WHERE key<>'apply_attempt'")).toBe(0);
    expect(count(x.db, "SELECT COUNT(*) n FROM daily_counters")).toBe(0);
    expect(count(x.db, "SELECT COUNT(*) n FROM apply_host_day")).toBe(0);
    expect(x.site.events.filter((e) => e.startsWith('click') || e.startsWith('fill'))).toEqual([]);
  });

  it('a captcha page at open is a block, escalated, and the host is noted', async () => {
    const x = setup({ start: 'captcha-wall.html' });
    expect(await open(x)).toMatchObject({ status: 'blocked', code: 'captcha' });
    expect(x.escalations.some(([k]) => k === 'block')).toBe(true);
  });

  it('a navigation failure maps to a fixed code and does not leak browser text', async () => {
    const x = setup();
    const r = await handleOpen({ job_id: 'job-1' }, { ...x.deps, runtime: { ...x.runtime, open: async () => ({ ok: false as const, code: 'failed', reason: 'navigation failed' }) } as typeof x.runtime });
    expect(r).toMatchObject({ status: 'failed', code: 'failed' });
  });
});
