import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleFill } from '../src/applier/tools/fill.js';
import { handleUpload } from '../src/applier/tools/upload.js';
import { handleSubmit } from '../src/applier/tools/submit.js';
import { detectConfirmation } from '../src/applier/confirm.js';
import { extractFormModel } from '../src/webcore/formModel.js';
import { checkAndIncrement } from '../src/lib/rateLimit.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { count, HOST, makeApplier, type ApplierHarness, type HarnessOpts } from './helpers/applierHarness.js';
import { loadFixture } from './helpers/fixtureSite.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const SUBMIT = 'Submit application';
const TO_CONFIRM = { [SUBMIT]: [{ fixture: 'ats-b-confirmation.html' }] };
const clicks = (x: ApplierHarness) => x.site.events.filter((e) => e === `click:control:${SUBMIT}`).length;
const easy = (x: ApplierHarness) => count(x.db, "SELECT COALESCE(SUM(count),0) n FROM daily_counters WHERE key='easy_apply'");
const hostCount = (x: ApplierHarness) => count(x.db, 'SELECT COALESCE(SUM(count),0) n FROM apply_host_day');

// ats-b-form with name, email and resume filled
async function ready(o: HarnessOpts = {}): Promise<ApplierHarness> {
  h = makeApplier({ start: 'ats-b-form.html', transitions: TO_CONFIRM, ...o });
  expect((await handleOpen({ job_id: 'job-1' }, h.deps)).status).toBe('ok');
  const okOrDry = ['ok', 'dry_run'];
  expect(okOrDry).toContain((await handleFill({ field: 'f1', ref: { kind: 'profile', field: 'name.full' } }, h.deps)).status);
  expect(okOrDry).toContain((await handleFill({ field: 'f2', ref: { kind: 'profile', field: 'email' } }, h.deps)).status);
  expect(okOrDry).toContain((await handleUpload({ field: 'f4' }, h.deps)).status);
  return h;
}

describe('apply_submit', () => {
  it('dry', async () => {
    const x = await ready({ env: { JOBBER_DRY_RUN: 'true' } });
    // dry run: fills above were dry too, so the form is still empty; dry wins before any check
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'dry_run' });
    expect(clicks(x)).toBe(0);
    expect(easy(x)).toBe(0);
    expect(hostCount(x)).toBe(0);
    expect(count(x.db, "SELECT COUNT(*) n FROM dry_run_actions WHERE action='apply_submit'")).toBe(1);
    expect(count(x.db, 'SELECT COUNT(*) n FROM applications')).toBe(0);
  });

  it('hold', async () => {
    for (const mode of ['hold', undefined, 'anything-else']) {
      const x = await ready({ env: { APPLY_SUBMIT_MODE: mode as string } });
      const r = await handleSubmit({}, x.deps);
      expect(r, String(mode)).toMatchObject({ status: 'held', code: 'hold_mode' });
      expect(typeof (r as { state?: string }).state).toBe('string');
      expect(clicks(x)).toBe(0);
      expect(easy(x)).toBe(0);
      expect(hostCount(x)).toBe(0);
      expect(count(x.db, 'SELECT COUNT(*) n FROM applications')).toBe(0);
      await x.close(); h = null;
    }
  });

  it('classifier', async () => {
    const x = await ready();
    x.classifier.classify.mockResolvedValue({ malicious: true, score: 0.99, truncated: false });
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'blocked', code: 'injection_suspected' });
    expect(clicks(x)).toBe(0);
    expect(easy(x)).toBe(0);
  });

  it('captcha', async () => {
    const x = await ready();
    x.site.current().captchaWidget = true;
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'blocked', code: 'captcha' });
    expect(clicks(x)).toBe(0);
    expect(easy(x)).toBe(0);
    expect(x.escalations.some(([k]) => k === 'block')).toBe(true);
  });

  it('missing required', async () => {
    h = makeApplier({ start: 'ats-b-form.html', transitions: TO_CONFIRM });
    await handleOpen({ job_id: 'job-1' }, h.deps);
    await handleFill({ field: 'f1', ref: { kind: 'profile', field: 'name.full' } }, h.deps);
    const r = await handleSubmit({}, h.deps);
    expect(r).toMatchObject({ status: 'needs_owner', code: 'missing_required' });
    expect((r as { fields?: string[] }).fields).toEqual(['f2', 'f4']);
    expect(clicks(h)).toBe(0);
    expect(easy(h)).toBe(0);
    expect(hostCount(h)).toBe(0);
  });

  it('halted', async () => {
    const x = await ready();
    haltPlatform(x.db, 'apply', 'owner', new Date());
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'refused', code: 'halted' });
    expect(clicks(x)).toBe(0);
    expect(easy(x)).toBe(0);
  });

  it('STOP', async () => {
    const x = await ready();
    fs.writeFileSync(x.stopFile, 'stop\n');
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'refused', code: 'killed' });
    expect(clicks(x)).toBe(0);
    expect(easy(x)).toBe(0);
  });

  it('daily cap', async () => {
    const x = await ready({ env: { MAX_APPLIES_PER_DAY: '1' } });
    expect(checkAndIncrement(x.db, 'easy_apply', 1)).toBe(true);
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'rate_limited', code: 'daily_cap' });
    expect(clicks(x)).toBe(0);
    expect(easy(x)).toBe(1);
    expect(hostCount(x)).toBe(0);
    expect(x.db.prepare("SELECT status FROM outreach_queue WHERE job_id='job-1'").get()).toEqual({ status: 'queued' });
  });

  it('per-host cap', async () => {
    const x = await ready({ env: { APPLY_MAX_PER_HOST: '3' } });
    x.db.prepare("INSERT INTO apply_host_day (host, day, count) VALUES (?, date('now'), 3)").run(HOST);
    const r = await handleSubmit({}, x.deps);
    expect(r).toMatchObject({ status: 'rate_limited', code: 'host_cap', reason: 'host_cap' });
    expect(clicks(x)).toBe(0);
    expect(easy(x)).toBe(0); // the global counter is not consumed when the host is at its cap
    expect(hostCount(x)).toBe(3);
    expect(x.db.prepare("SELECT status FROM outreach_queue WHERE job_id='job-1'").get()).toEqual({ status: 'queued' });
    expect(count(x.db, 'SELECT COUNT(*) n FROM applications')).toBe(0);
  });

  it('per-platform cap beats the top-level cap', async () => {
    const x = await ready({ env: { APPLY_MAX_PER_HOST: '9', APPLY_MAX_PER_HOST_GREENHOUSE: '1' } });
    x.db.prepare("INSERT INTO apply_host_day (host, day, count) VALUES (?, date('now'), 1)").run(HOST);
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'rate_limited', code: 'host_cap' });
  });

  it('happy path consumes easy_apply and the host counter exactly once', async () => {
    const x = await ready();
    const r = await handleSubmit({}, x.deps);
    expect(r).toMatchObject({ status: 'submitted', code: 'confirmed' });
    expect(clicks(x)).toBe(1);
    expect(easy(x)).toBe(1);
    expect(hostCount(x)).toBe(1);
    expect(x.db.prepare('SELECT host, count FROM apply_host_day').get()).toEqual({ host: HOST, count: 1 });
    expect(x.db.prepare("SELECT job_id, platform, method, status FROM applications").all()).toEqual([
      { job_id: 'job-1', platform: 'greenhouse', method: 'browser', status: 'submitted' },
    ]);
    expect(x.db.prepare("SELECT apply_status, status FROM outreach_queue WHERE job_id='job-1'").get()).toEqual({ apply_status: 'submitted', status: 'queued' });
  });

  it('no confirmation -> unconfirmed', async () => {
    const x = await ready({ transitions: { [SUBMIT]: [{ fixture: 'ats-b-form.html' }] } });
    const r = await handleSubmit({}, x.deps);
    expect(r).toMatchObject({ status: 'unconfirmed', code: 'no_confirmation' });
    expect(clicks(x)).toBe(1);
    expect(easy(x)).toBe(1);
    expect(hostCount(x)).toBe(1);
    expect(x.db.prepare('SELECT status FROM applications').all()).toEqual([{ status: 'manual_review' }]);
    expect(count(x.db, "SELECT COUNT(*) n FROM applications WHERE status='submitted'")).toBe(0);
    expect(x.db.prepare("SELECT apply_status FROM outreach_queue WHERE job_id='job-1'").get()).toEqual({ apply_status: 'manual_review' });
  });

  it('a confirmation-looking word on a page that still has the form is not a confirmation', async () => {
    const withText = '<html><body><h2>Thank you for applying soon</h2><form><label>Email <input type="email" required></label><div role="alert" class="error">Required</div><button>Submit application</button></form></body></html>';
    const x = await ready({ transitions: { [SUBMIT]: [{ fixture: withText }] } });
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'unconfirmed' });
  });

  it('duplicate submit', async () => {
    const x = await ready();
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'submitted' });
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'refused', code: 'already_submitted' });
    expect(clicks(x)).toBe(1);
    expect(easy(x)).toBe(1);
    expect(hostCount(x)).toBe(1);
    expect(count(x.db, 'SELECT COUNT(*) n FROM applications')).toBe(1);
  });

  it('a re-checking marketing box blocks submit', async () => {
    const form = `<html><body><form>
<label>Full name <input name="name" type="text" required></label><label>Email <input name="email" type="email" required></label>
<label>Resume <input name="resume" type="file" required></label>
<label><input id="news" type="checkbox" checked> Subscribe to our newsletter</label>
<button type="submit">Submit application</button></form></body></html>`;
    h = makeApplier({ start: form, stickyLabel: /newsletter/i, transitions: TO_CONFIRM });
    await handleOpen({ job_id: 'job-1' }, h.deps);
    await handleFill({ field: 'f1', ref: { kind: 'profile', field: 'name.full' } }, h.deps);
    await handleFill({ field: 'f2', ref: { kind: 'profile', field: 'email' } }, h.deps);
    await handleUpload({ field: 'f3' }, h.deps);
    expect(await handleSubmit({}, h.deps)).toMatchObject({ status: 'needs_owner', code: 'marketing_checkbox' });
    expect(clicks(h)).toBe(0);
    expect(easy(h)).toBe(0);
    expect(hostCount(h)).toBe(0);
  });

  it('a pre-checked marketing box is unchecked by the submit gate, then the form goes', async () => {
    const form = `<html><body><form>
<label>Full name <input name="name" type="text" required></label><label>Email <input name="email" type="email" required></label>
<label>Resume <input name="resume" type="file" required></label>
<label><input id="news" type="checkbox" checked> Subscribe to our newsletter</label>
<button type="submit">Submit application</button></form></body></html>`;
    h = makeApplier({ start: form, transitions: TO_CONFIRM });
    await handleOpen({ job_id: 'job-1' }, h.deps);
    await handleFill({ field: 'f1', ref: { kind: 'profile', field: 'name.full' } }, h.deps);
    await handleFill({ field: 'f2', ref: { kind: 'profile', field: 'email' } }, h.deps);
    await handleUpload({ field: 'f3' }, h.deps);
    expect(await handleSubmit({}, h.deps)).toMatchObject({ status: 'submitted' });
    const order = h.site.events;
    expect(order.indexOf('click:field:Subscribe to our newsletter')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('click:field:Subscribe to our newsletter')).toBeLessThan(order.indexOf(`click:control:${SUBMIT}`));
  });

  it('host change refused', async () => {
    const urlRef = { value: 'https://boards.greenhouse.io/acme/jobs/1' };
    const x = await ready({ urlRef });
    urlRef.value = 'https://evil.example.test/apply';
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'refused', code: 'host_changed' });
    expect(clicks(x)).toBe(0);
    expect(easy(x)).toBe(0);
    expect(hostCount(x)).toBe(0);
  });

  it('no job open', async () => {
    h = makeApplier();
    expect(await handleSubmit({}, h.deps)).toMatchObject({ status: 'refused', code: 'no_job' });
  });

  it('a click that throws after the counters were consumed is failed and recorded for manual review', async () => {
    const x = await ready();
    const page = x.runtime.page()!;
    const orig = page.locator.bind(page);
    (page as { locator: unknown }).locator = (s: string) => {
      const l = orig(s);
      if (s.startsWith('[data-jc=')) (l as { click: unknown }).click = async () => { throw new Error('boom secret-text'); };
      return l;
    };
    const r = await handleSubmit({}, x.deps);
    expect(r).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(r)).not.toContain('secret-text');
    expect(x.db.prepare('SELECT status FROM applications').all()).toEqual([{ status: 'manual_review' }]);
  });
});

describe('confirmation layers', () => {
  const after = (name: string, url = 'https://boards.greenhouse.io/acme/jobs/1/confirmation') => {
    const raw = loadFixture(name, url);
    return { raw, model: extractFormModel(raw) };
  };
  const before = extractFormModel(loadFixture('ats-b-form.html', 'https://boards.greenhouse.io/acme/jobs/1'));

  it('recipe signals first', () => {
    const a = after('ats-b-confirmation.html', 'https://boards.greenhouse.io/acme/jobs/1');
    expect(detectConfirmation(before, a, { text: [/we have received your application/i] })).toMatchObject({ confirmed: true, layer: 'recipe' });
  });
  it('url path plus form gone', () => {
    const raw = loadFixture('ats-b-confirmation.html', 'https://boards.greenhouse.io/acme/jobs/1/submitted');
    raw.text = 'All set';
    expect(detectConfirmation(before, { raw, model: extractFormModel(raw) })).toMatchObject({ confirmed: true, layer: 'url' });
  });
  it('generic text plus form gone', () => {
    const a = after('ats-a-confirmation.html', 'https://boards.greenhouse.io/acme/jobs/1');
    expect(detectConfirmation(before, a)).toMatchObject({ confirmed: true, layer: 'text' });
  });
  it('the form still showing, an error notice or a block is never a confirmation', () => {
    const still = after('ats-b-form.html', 'https://boards.greenhouse.io/acme/jobs/1/confirmation');
    expect(detectConfirmation(before, still).confirmed).toBe(false);
    const a = after('ats-a-confirmation.html');
    a.raw.notices = ['Something went wrong'];
    a.model = extractFormModel(a.raw);
    expect(detectConfirmation(before, a).confirmed).toBe(false);
    const w = after('captcha-wall.html');
    expect(detectConfirmation(before, w).confirmed).toBe(false);
  });
});
