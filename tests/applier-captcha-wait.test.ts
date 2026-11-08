import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { handleOpen } from '../src/applier/tools/open.js';
import {
  CAPTCHA_POLL_MS, captchaWaitSec, clearedSnapshot, noticeCaptchaWait, readPageWaitingForCaptcha, waitForCaptchaCleared, type PageSnap,
} from '../src/applier/captchaWait.js';
import { extractFormModel, FORM_SNAPSHOT_SCRIPT, type RawFormSnapshot } from '../src/webcore/formModel.js';
import { detectBlock } from '../src/webcore/blocks.js';
import { openDb } from '../src/db.js';
import type { LiPage } from '../src/linkedin/types.js';
import { count, makeApplier, type ApplierHarness } from './helpers/applierHarness.js';

const HOST = 'boards.greenhouse.io';
const URL_ = `https://${HOST}/acme/jobs/1`;

function snapOf(o: Partial<RawFormSnapshot> = {}): PageSnap {
  const raw: RawFormSnapshot = { url: URL_, title: 'Apply', text: 'Apply for Senior Engineer', fields: [], controls: [], notices: [], ...o };
  return { raw, model: extractFormModel(raw) };
}
const captchaSnap = (o: Partial<RawFormSnapshot> = {}) => snapOf({ text: 'Please verify you are human.', captchaWidget: true, ...o });

/** A clock the fake sleep advances. */
function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

describe('captchaWaitSec', () => {
  it('defaults to 25, 0 is off, clamps 0..60, invalid -> default', () => {
    expect(captchaWaitSec({})).toBe(25);
    expect(captchaWaitSec({ APPLY_CAPTCHA_WAIT_SEC: '' })).toBe(25);
    expect(captchaWaitSec({ APPLY_CAPTCHA_WAIT_SEC: '0' })).toBe(0);
    expect(captchaWaitSec({ APPLY_CAPTCHA_WAIT_SEC: '40' })).toBe(40);
    expect(captchaWaitSec({ APPLY_CAPTCHA_WAIT_SEC: '999' })).toBe(60);
    expect(captchaWaitSec({ APPLY_CAPTCHA_WAIT_SEC: '-5' })).toBe(25);
    expect(captchaWaitSec({ APPLY_CAPTCHA_WAIT_SEC: 'abc' })).toBe(25);
    expect(captchaWaitSec({ APPLY_CAPTCHA_WAIT_SEC: '1.5' })).toBe(25);
  });
});

describe('waitForCaptchaCleared', () => {
  it('cleared after 2 polls', async () => {
    const c = clock();
    let n = 0;
    let got: PageSnap | null = null;
    const r = await waitForCaptchaCleared({
      snapshot: async () => (++n < 2 ? captchaSnap() : snapOf()), sleep: c.sleep, now: c.now, waitSec: 25, host: HOST,
      onCleared: (s) => { got = s; },
    });
    expect(r).toBe('cleared');
    expect(n).toBe(2);
    expect(c.sleeps).toEqual([CAPTCHA_POLL_MS, CAPTCHA_POLL_MS]);
    expect(got).not.toBeNull();
  });

  it('still_there at the limit', async () => {
    const c = clock();
    let n = 0;
    const r = await waitForCaptchaCleared({ snapshot: async () => { n++; return captchaSnap(); }, sleep: c.sleep, now: c.now, waitSec: 10, host: HOST });
    expect(r).toBe('still_there');
    expect(n).toBe(4); // 3, 6, 9, 10 seconds
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('page_changed when the host is not the apply host any more', async () => {
    const c = clock();
    const r = await waitForCaptchaCleared({ snapshot: async () => snapOf({ url: 'https://evil.example/x' }), sleep: c.sleep, now: c.now, waitSec: 25, host: HOST });
    expect(r).toBe('page_changed');
  });

  it('a snapshot error or the kill switch ends the wait as still_there', async () => {
    const c = clock();
    expect(await waitForCaptchaCleared({ snapshot: async () => { throw new Error('x'); }, sleep: c.sleep, now: c.now, waitSec: 25, host: HOST })).toBe('still_there');
    const snapshot = vi.fn(async () => snapOf());
    expect(await waitForCaptchaCleared({ snapshot, sleep: c.sleep, now: c.now, waitSec: 25, host: HOST, abort: () => true })).toBe('still_there');
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('another block replacing the captcha is not cleared', async () => {
    const c = clock();
    const r = await waitForCaptchaCleared({ snapshot: async () => snapOf({ text: 'Access denied. Unusual traffic.' }), sleep: c.sleep, now: c.now, waitSec: 6, host: HOST });
    expect(r).toBe('still_there');
  });
});

describe('clearedSnapshot', () => {
  it('a filled token with the widget still shown counts only when nothing else blocks', () => {
    const solved = clearedSnapshot(snapOf({ captchaWidget: true, captchaSolved: true }));
    expect(solved).not.toBeNull();
    expect(solved!.model.block).toBeNull();
    // the captcha wording is still on the page: not cleared
    expect(clearedSnapshot(captchaSnap({ captchaSolved: true }))).toBeNull();
    // a widget with no token is still a captcha
    expect(clearedSnapshot(snapOf({ captchaWidget: true }))).toBeNull();
    expect(clearedSnapshot(snapOf({ captchaWidget: true, captchaSolved: false }))).toBeNull();
  });

  it('the snapshot script reads response tokens and the formModel detect is untouched by captchaSolved alone', () => {
    expect(FORM_SNAPSHOT_SCRIPT).toContain('g-recaptcha-response');
    expect(FORM_SNAPSHOT_SCRIPT).toContain('cf-turnstile-response');
    expect(detectBlock({ url: URL_, title: '', text: '', fields: [], controls: [], notices: [], captchaWidget: true, captchaSolved: true })).toBe('captcha');
  });
});

describe('readPageWaitingForCaptcha', () => {
  const pageOf = (seq: () => RawFormSnapshot): LiPage => ({ evaluate: async () => JSON.parse(JSON.stringify(seq())) } as unknown as LiPage);
  const raw = (s: PageSnap) => s.raw;
  const ctx = (env: NodeJS.ProcessEnv, c = clock(), stopped = false) => {
    const notify = vi.fn(async () => undefined);
    return { c, notify, ctx: { env, jobId: 'job-1', stopped: () => stopped, notify, sleep: c.sleep, now: c.now } };
  };

  it('no captcha: plain read, no notice, no sleep', async () => {
    const x = ctx({ JOBBER_DRY_RUN: 'false' });
    const r = await readPageWaitingForCaptcha(pageOf(() => raw(snapOf())), x.ctx);
    expect(r.model.block).toBeNull();
    expect(x.notify).not.toHaveBeenCalled();
    expect(x.c.sleeps).toEqual([]);
  });

  it('captcha cleared by the owner: returns the fresh read and sends one notice', async () => {
    const x = ctx({ JOBBER_DRY_RUN: 'false' });
    let reads = 0;
    const r = await readPageWaitingForCaptcha(pageOf(() => { reads++; return raw(reads <= 3 ? captchaSnap() : snapOf()); }), x.ctx);
    expect(r.model.block).toBeNull();
    expect(x.notify).toHaveBeenCalledTimes(1);
    expect(x.notify).toHaveBeenCalledWith(HOST, 25);
  });

  it('not cleared: returns the ORIGINAL read (still a captcha block)', async () => {
    const x = ctx({ JOBBER_DRY_RUN: 'false', APPLY_CAPTCHA_WAIT_SEC: '6' });
    const r = await readPageWaitingForCaptcha(pageOf(() => raw(captchaSnap())), x.ctx);
    expect(r.model.block).toBe('captcha');
    expect(x.c.sleeps.reduce((a, b) => a + b, 0)).toBe(6000);
  });

  it('wait 0, dry run and a stop all read once and never wait', async () => {
    for (const [env, stopped] of [[{ JOBBER_DRY_RUN: 'false', APPLY_CAPTCHA_WAIT_SEC: '0' }, false], [{ JOBBER_DRY_RUN: 'true' }, false], [{ JOBBER_DRY_RUN: 'false' }, true]] as const) {
      const x = ctx(env, clock(), stopped);
      const evalSpy = vi.fn(async () => JSON.parse(JSON.stringify(raw(captchaSnap()))));
      const r = await readPageWaitingForCaptcha({ evaluate: evalSpy } as unknown as LiPage, x.ctx);
      expect(r.model.block).toBe('captcha');
      expect(evalSpy).toHaveBeenCalledTimes(1);
      expect(x.notify).not.toHaveBeenCalled();
      expect(x.c.sleeps).toEqual([]);
    }
  });

  it('MFA, phone verification, bot wall and login wall are never waited for', async () => {
    const codeField = { type: 'text', name: 'code', id: 'code', label: 'Verification code', required: true, filled: false, hidden: false, autocomplete: 'one-time-code', maxlength: 0 };
    const cases: Array<[string, Partial<RawFormSnapshot>]> = [
      ['mfa', { text: 'Enter the verification code from your authenticator app', fields: [codeField] }],
      ['phone_verification', { text: 'We sent a text message. Verify your phone.', fields: [codeField] }],
      ['bot_wall', { text: 'Access denied. Unusual traffic from your network.' }],
      ['login_required', { text: 'Please sign in to apply' }],
    ];
    for (const [kind, o] of cases) {
      const x = ctx({ JOBBER_DRY_RUN: 'false' });
      const r = await readPageWaitingForCaptcha(pageOf(() => raw(snapOf(o))), x.ctx);
      expect(r.model.block, kind).toBe(kind);
      expect(x.notify, kind).not.toHaveBeenCalled();
      expect(x.c.sleeps, kind).toEqual([]);
    }
  });
});

describe('noticeCaptchaWait', () => {
  it('sends one escaped notice per host per 5 minutes, host and title only', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO jobs (id, source, title, company, url, apply_url, description) VALUES (?,?,?,?,?,?,?)').run('job-1', 'remotive', 'Dev <b>x</b>', 'Acme', URL_, URL_, 'd');
    const sent: string[] = [];
    const notifier = { send: async (t: string) => { sent.push(t); return { ok: true, detail: '' }; } };
    const base = { host: HOST, jobId: 'job-1', waitSec: 25, notifier, env: { JOBBER_DRY_RUN: 'false' } };
    const t0 = new Date('2026-11-08T10:00:00Z');
    expect(await noticeCaptchaWait(db, { ...base, now: t0 })).toBe('sent');
    expect(await noticeCaptchaWait(db, { ...base, now: new Date(t0.getTime() + 60_000) })).toBe('deduped');
    expect(await noticeCaptchaWait(db, { ...base, now: new Date(t0.getTime() + 301_000) })).toBe('sent');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain(HOST);
    expect(sent[0]).toContain('25 seconds');
    expect(sent[0]).toContain('Dev &lt;b&gt;x&lt;/b&gt;');
    expect(await noticeCaptchaWait(db, { ...base, now: t0, env: { JOBBER_DRY_RUN: 'true' } })).toBe('dry_run');
  });
});

describe('apply_open with a captcha wall', () => {
  let h: ApplierHarness | null = null;
  afterEach(async () => { await h?.close(); h = null; });

  function setup(env: NodeJS.ProcessEnv, solveAfter: number | null) {
    const x = (h = makeApplier({ start: 'captcha-wall.html', env }));
    const c = clock();
    let sleeps = 0;
    const sent: string[] = [];
    x.deps.captcha = {
      now: c.now,
      sleep: async (ms) => {
        await c.sleep(ms);
        sleeps++;
        if (solveAfter !== null && sleeps >= solveAfter) { const cur = x.site.current(); cur.captchaWidget = false; cur.text = 'Apply for Senior Engineer'; }
      },
      notifier: { send: async (t) => { sent.push(t); return { ok: true, detail: '' }; } },
    };
    return { x, c, sent };
  }

  it('cleared after 2 polls: apply_open goes on, no block is recorded, one notice', async () => {
    const { x, sent } = setup({ APPLY_CAPTCHA_WAIT_SEC: '25' }, 2);
    expect(await handleOpen({ job_id: 'job-1' }, x.deps)).toMatchObject({ status: 'ok', code: 'opened' });
    expect(x.escalations).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(count(x.db, "SELECT COUNT(*) n FROM scheduler_state WHERE key LIKE 'captcha_wait_ping:%'")).toBe(1);
  });

  it('never solved: parks exactly as before (blocked captcha, one escalation)', async () => {
    const { x, c, sent } = setup({ APPLY_CAPTCHA_WAIT_SEC: '9' }, null);
    expect(await handleOpen({ job_id: 'job-1' }, x.deps)).toMatchObject({ status: 'blocked', code: 'captcha' });
    expect(x.escalations.filter(([k]) => k === 'block')).toHaveLength(1);
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(9000);
    expect(sent).toHaveLength(1);
  });

  it('wait 0 = old behaviour: no sleep, no notice, blocked at once', async () => {
    const { x, c, sent } = setup({ APPLY_CAPTCHA_WAIT_SEC: '0' }, 1);
    expect(await handleOpen({ job_id: 'job-1' }, x.deps)).toMatchObject({ status: 'blocked', code: 'captcha' });
    expect(c.sleeps).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('model-facing surface is unchanged', () => {
  it('no captcha tool exists and the wait has no env or input on any tool', () => {
    const mcp = fs.readFileSync('src/mcp/applier.ts', 'utf8');
    expect(mcp).not.toMatch(/captcha_wait|solve_captcha|apply_captcha/i);
    for (const f of ['.claude/agents/apply-operator.md', 'config/worker-tools.json']) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/captcha_wait|solve_captcha/i);
    }
  });
});
