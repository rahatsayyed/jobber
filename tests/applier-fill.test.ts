import { afterEach, describe, expect, it } from 'vitest';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleFill } from '../src/applier/tools/fill.js';
import { handleChoose } from '../src/applier/tools/choose.js';
import { handleUpload } from '../src/applier/tools/upload.js';
import { handleNext } from '../src/applier/tools/next.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { APPLY_URL, makeApplier, WHY, type ApplierHarness, type HarnessOpts } from './helpers/applierHarness.js';
import type { AnswerRef } from '../src/apply/answers.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });

async function opened(o: HarnessOpts = {}): Promise<ApplierHarness> {
  h = makeApplier(o);
  const r = await handleOpen({ job_id: o.jobId ?? 'job-1' }, h.deps);
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return h;
}
const P = (field: 'name.first' | 'name.last' | 'name.full' | 'email' | 'phone' | 'linkedin_url' | 'location'): AnswerRef => ({ kind: 'profile', field });
const A = (key: string): AnswerRef => ({ kind: 'answer', key: key as never });
const fill = (x: ApplierHarness, field: string, ref: AnswerRef) => handleFill({ field, ref }, x.deps);

const MARKETING_FORM = `<html><body><form>
<label>Full name <input name="name" type="text" required></label>
<label>Email <input name="email" type="email" required></label>
<label>Resume <input name="resume" type="file" required></label>
<label><input id="news" type="checkbox" checked> Subscribe to our newsletter</label>
<button type="submit">Submit application</button></form></body></html>`;

describe('apply_fill', () => {
  it('full fill of ats-a-form and ats-b-form', async () => {
    let x = await opened();
    const outs = [
      await fill(x, 'f1', P('name.first')), await fill(x, 'f2', P('name.last')), await fill(x, 'f3', P('email')),
      await fill(x, 'f4', P('phone')), await fill(x, 'f7', P('linkedin_url')), await fill(x, 'f8', A(`custom:Why do you want to work here?`)),
      await handleUpload({ field: 'f5' }, x.deps),
    ];
    for (const r of outs) expect(r, JSON.stringify(r)).toMatchObject({ status: 'ok' });
    expect(x.site.fills.map((f) => f.value)).toEqual([
      'Jane', 'Fixture', 'jane.fixture@example.com', '+00 1112223333', 'https://linkedin.com/in/fixture-person', WHY,
    ]);
    expect(x.site.uploads).toEqual([{ label: 'Resume/CV *', path: x.resumePath }]);
    // a value never travels back to the model
    const blob = JSON.stringify(outs);
    for (const v of ['Jane', 'jane.fixture', '+00 1112223333', WHY]) expect(blob).not.toContain(v);
    expect(blob).not.toContain(x.resumePath);
    await x.close(); h = null;

    x = await opened({ start: 'ats-b-form.html' });
    const b = [
      await fill(x, 'f1', P('name.full')), await fill(x, 'f2', P('email')), await fill(x, 'f3', P('location')), await fill(x, 'f5', P('linkedin_url')),
      await handleUpload({ field: 'f4' }, x.deps),
      await handleChoose({ field: 'f6', option: 'Decline to self-identify' }, x.deps),
    ];
    for (const r of b) expect(r, JSON.stringify(r)).toMatchObject({ status: 'ok' });
    expect(x.site.fills.map((f) => f.value)).toEqual(['Jane Q Fixture', 'jane.fixture@example.com', 'Fixture City', 'https://linkedin.com/in/fixture-person']);
    expect(x.site.selections).toEqual([{ label: 'Gender', option: 'Decline to self-identify' }]);
  });

  it('role/ref mismatch refused', async () => {
    const x = await opened();
    expect(await fill(x, 'f3', P('phone'))).toMatchObject({ status: 'refused', code: 'role_ref_mismatch' });
    expect(await fill(x, 'f1', P('name.last'))).toMatchObject({ status: 'refused', code: 'role_ref_mismatch' });
    expect(await fill(x, 'f4', A('years_experience'))).toMatchObject({ status: 'refused', code: 'role_ref_mismatch' });
    expect(x.site.fills).toEqual([]);
  });

  it('honeypot field refused', async () => {
    const x = await opened();
    expect(await fill(x, 'f9', P('name.first'))).toMatchObject({ status: 'refused', code: 'hidden_field' });
    expect(await fill(x, 'f9', A('custom:anything'))).toMatchObject({ status: 'refused', code: 'hidden_field' });
    expect(x.site.fills).toEqual([]);
  });

  it('unresolved question returns needs_owner with the question text and types nothing', async () => {
    const x = await opened({ why: false });
    // the book has no entry for this question: whatever ref the model names, nothing is typed
    for (const ref of [A('years_experience'), A('custom:No such answer')]) {
      const r = await fill(x, 'f8', ref);
      expect(r).toMatchObject({ status: 'needs_owner' });
      expect((r as { question?: string }).question).toContain('Why do you want to work here?');
    }
    const y = await (async () => { await x.close(); h = null; return opened({ start: 'wd-step2-questions.html' }); })();
    // years question known in the book, but a ref for another topic is a mismatch, not a guess
    expect(await fill(y, 'f2', A('notice_period_days'))).toMatchObject({ status: 'refused', code: 'role_ref_mismatch' });
    expect(y.site.fills).toEqual([]);
  });

  it('a question whose book entry is missing is needs_owner, nothing typed', async () => {
    const x = await opened({ start: 'wd-step2-questions.html' });
    x.deps.answers = { ...x.deps.answers, has: () => false };
    const r = await fill(x, 'f2', A('years_experience'));
    expect(r).toMatchObject({ status: 'needs_owner', code: 'missing_answer' });
    expect((r as { question?: string }).question).toContain('years of React experience');
    expect(x.site.fills).toEqual([]);
  });

  it('a known question is typed from the book (years of experience)', async () => {
    const x = await opened({ start: 'wd-step2-questions.html' });
    expect(await fill(x, 'f2', A('years_experience'))).toMatchObject({ status: 'ok' });
    expect(x.site.fills.map((f) => f.value)).toEqual(['5']);
  });

  it('refuses password, consent, marketing, eeo, select and file fields', async () => {
    let x = await opened({ start: '<html><body><form><label>Email <input type="email" name="e"></label><label>Password <input type="password" name="p"></label><button>Sign in</button></form></body></html>' });
    expect(await fill(x, 'f2', P('email'))).toMatchObject({ status: 'refused', code: 'use_login' });
    await x.close(); h = null;
    x = await opened({ start: 'ats-b-form.html' });
    expect(await fill(x, 'f6', P('name.full'))).toMatchObject({ status: 'refused', code: 'use_choose' });
    expect(await fill(x, 'f4', { kind: 'resume_pdf' })).toMatchObject({ status: 'refused', code: 'use_upload' });
    expect(await fill(x, 'f77', P('email'))).toMatchObject({ status: 'refused', code: 'unknown_field' });
    await x.close(); h = null;
    x = await opened({ start: MARKETING_FORM });
    expect(await fill(x, 'f4', P('email'))).toMatchObject({ status: 'refused', code: 'use_choose' });
    expect(x.site.fills).toEqual([]);
  });

  it('host change refused: nothing is typed once the page left the host', async () => {
    const urlRef = { value: APPLY_URL };
    const x = await opened({ urlRef });
    urlRef.value = 'https://evil.example.test/apply';
    expect(await fill(x, 'f1', P('name.first'))).toMatchObject({ status: 'refused', code: 'host_changed' });
    expect(x.site.fills).toEqual([]);
    expect(await handleUpload({ field: 'f5' }, x.deps)).toMatchObject({ status: 'refused', code: 'host_changed' });
    expect(x.site.uploads).toEqual([]);
  });

  it('halt, dry run and a block stop the tool; a fill error never leaks the typed value', async () => {
    let x = await opened();
    haltPlatform(x.db, 'apply', 'owner', new Date());
    expect(await fill(x, 'f1', P('name.first'))).toMatchObject({ status: 'refused', code: 'halted' });
    await x.close(); h = null;
    x = await opened({ env: { APPLY_DRY_RUN: 'true' } });
    expect(await fill(x, 'f1', P('name.first'))).toMatchObject({ status: 'dry_run' });
    expect(x.site.fills).toEqual([]);
    const rows = x.db.prepare('SELECT payload FROM dry_run_actions').all() as Array<{ payload: string }>;
    expect(rows.length).toBe(1);
    expect(rows.map((r) => r.payload).join()).not.toContain('Jane');
    await x.close(); h = null;
    x = await opened({ failFill: true });
    const r = await fill(x, 'f1', P('name.first'));
    expect(r).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(r)).not.toContain('Jane');
    await x.close(); h = null;
    x = await opened();
    x.site.current().captchaWidget = true;
    expect(await fill(x, 'f1', P('name.first'))).toMatchObject({ status: 'blocked', code: 'captcha' });
  });

  it('no job open', async () => {
    h = makeApplier();
    expect(await fill(h, 'f1', P('name.first'))).toMatchObject({ status: 'refused', code: 'no_job' });
  });
});

describe('apply_choose', () => {
  it('EEO decline option chosen', async () => {
    const x = await opened({ start: 'ats-b-form.html' });
    expect(await handleChoose({ field: 'f6', option: 'Female' }, x.deps)).toMatchObject({ status: 'refused', code: 'eeo_decline_only' });
    expect(await handleChoose({ field: 'f6', option: 'Not an option' }, x.deps)).toMatchObject({ status: 'refused', code: 'option_not_listed' });
    expect(x.site.selections).toEqual([]);
    expect(await handleChoose({ field: 'f6', option: 'decline to self-identify' }, x.deps)).toMatchObject({ status: 'ok', code: 'chosen' });
    expect(x.site.selections).toEqual([{ label: 'Gender', option: 'Decline to self-identify' }]);
  });

  it('EEO without a decline option waits for the owner', async () => {
    const x = await opened({ start: '<html><body><form><label>Gender <select name="eeo_gender"><option>Female</option><option>Male</option></select></label><button>Submit application</button></form></body></html>' });
    expect(await handleChoose({ field: 'f1', option: 'Female' }, x.deps)).toMatchObject({ status: 'needs_owner' });
    expect(x.site.selections).toEqual([]);
  });

  it('boolean answers map to Yes/No and a different option is refused', async () => {
    const x = await opened({ start: 'wd-step2-questions.html' });
    expect(await handleChoose({ field: 'f1', option: 'No', ref: A('authorized_to_work') }, x.deps)).toMatchObject({ status: 'refused', code: 'option_mismatch' });
    expect(await handleChoose({ field: 'f1', option: 'Yes', ref: A('authorized_to_work') }, x.deps)).toMatchObject({ status: 'ok' });
    expect(x.site.selections).toEqual([{ label: 'Are you legally authorized to work in this country? *', option: 'Yes' }]);
    // a ref for another topic
    expect(await handleChoose({ field: 'f1', option: 'Yes', ref: A('willing_to_relocate') }, x.deps)).toMatchObject({ status: 'refused', code: 'role_ref_mismatch' });
    // no ref at all for a question
    expect(await handleChoose({ field: 'f1', option: 'Yes' }, x.deps)).toMatchObject({ status: 'needs_owner' });
  });

  it('pre-checked marketing box is unchecked and verified', async () => {
    const x = await opened({ start: MARKETING_FORM });
    const r = await handleChoose({ field: 'f4', option: 'yes' }, x.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'marketing_unchecked' });
    expect(x.site.events.filter((e) => e.startsWith('click:field')).length).toBe(1);
    expect(x.site.current().fields[3].checked).toBe(false);
    // asking again changes nothing: it stays unchecked, no further click
    expect(await handleChoose({ field: 'f4', option: 'yes' }, x.deps)).toMatchObject({ status: 'ok', code: 'marketing_unchecked' });
    expect(x.site.events.filter((e) => e.startsWith('click:field')).length).toBe(1);
  });

  it('a marketing box that re-checks itself is needs_owner, never ok', async () => {
    const x = await opened({ start: MARKETING_FORM, stickyLabel: /newsletter/i });
    expect(await handleChoose({ field: 'f4', option: 'yes' }, x.deps)).toMatchObject({ status: 'needs_owner', code: 'marketing_checkbox' });
  });

  it('a required legal box is checked only when allowed; attestations wait for the owner', async () => {
    const legal = '<html><body><form><label><input type="checkbox" required> I acknowledge the privacy notice</label><button>Submit application</button></form></body></html>';
    let x = await opened({ start: legal });
    expect(await handleChoose({ field: 'f1', option: 'yes' }, x.deps)).toMatchObject({ status: 'ok', code: 'consent_checked' });
    expect(x.site.current().fields[0].checked).toBe(true);
    await x.close(); h = null;
    x = await opened({ start: legal, env: { APPLY_ACCEPT_LEGAL_REQUIRED: 'false' } });
    expect(await handleChoose({ field: 'f1', option: 'yes' }, x.deps)).toMatchObject({ status: 'needs_owner', code: 'consent' });
    await x.close(); h = null;
    x = await opened({ start: '<html><body><form><label><input type="checkbox" required> I certify the information is true and complete</label><button>Submit application</button></form></body></html>' });
    expect(await handleChoose({ field: 'f1', option: 'yes' }, x.deps)).toMatchObject({ status: 'needs_owner', code: 'consent' });
    expect(x.site.current().fields[0].checked).toBe(false);
  });

  it('radio groups go through one code-built script and a failed click is not ok', async () => {
    const radio = '<html><body><form><label>Relocate? <input type="radio" name="r"> Yes</label><label><input type="radio" name="r"> No</label><button>Submit application</button></form></body></html>';
    const x = await opened({ start: radio });
    // the fake page cannot run the in-page script: evaluate returns a snapshot, not true
    const r = await handleChoose({ field: 'f1', option: 'Yes', ref: A('willing_to_relocate') }, x.deps);
    expect(r.status).not.toBe('ok');
  });

  it('refuses a text field and an unknown field', async () => {
    const x = await opened({ start: 'wd-step2-questions.html' });
    expect(await handleChoose({ field: 'f2', option: 'x' }, x.deps)).toMatchObject({ status: 'refused', code: 'use_fill' });
    expect(await handleChoose({ field: 'f55', option: 'x' }, x.deps)).toMatchObject({ status: 'refused', code: 'unknown_field' });
  });
});

describe('apply_upload', () => {
  it('uploads the prepared PDF to the resume field only', async () => {
    const x = await opened();
    expect(await handleUpload({ field: 'f5' }, x.deps)).toMatchObject({ status: 'ok', code: 'uploaded' });
    expect(x.site.uploads).toEqual([{ label: 'Resume/CV *', path: x.resumePath }]);
    expect(await handleUpload({ field: 'f1' }, x.deps)).toMatchObject({ status: 'refused', code: 'not_a_file_field' });
    expect(await handleUpload({ field: 'f9' }, x.deps)).toMatchObject({ status: 'refused', code: 'hidden_field' });
  });

  it('an optional cover letter stays empty', async () => {
    const x = await opened();
    expect(await handleUpload({ field: 'f6' }, x.deps)).toMatchObject({ status: 'refused', code: 'cover_letter_not_supplied' });
    expect(x.site.uploads).toEqual([]);
  });

  it('a required cover letter is needs_owner', async () => {
    const x = await opened({ start: '<html><body><form><label>Cover letter <input type="file" required></label><button>Submit application</button></form></body></html>' });
    expect(await handleUpload({ field: 'f1' }, x.deps)).toMatchObject({ status: 'needs_owner', code: 'cover_letter' });
  });

  it('refuses a resume path outside the output directory or that is not a pdf', async () => {
    const x = await opened();
    x.db.prepare("UPDATE outreach_queue SET resume_pdf_path = '/etc/hosts'").run();
    expect(await handleUpload({ field: 'f5' }, x.deps)).toMatchObject({ status: 'refused', code: 'no_resume' });
    x.db.prepare("UPDATE outreach_queue SET resume_pdf_path = ?").run(`${x.resumePath}/../../../../escape.pdf`);
    expect(await handleUpload({ field: 'f5' }, x.deps)).toMatchObject({ status: 'refused', code: 'no_resume' });
    expect(x.site.uploads).toEqual([]);
  });
});

describe('apply_next', () => {
  const STEPS = { 'Save and Continue': [{ fixture: 'wd-step2-questions.html' }, { fixture: 'wd-step3-review.html' }] };

  it('moves forward, counts steps and returns the screened state', async () => {
    const x = await opened({ start: 'wd-step1-personal.html', transitions: STEPS });
    const r = await handleNext({ control: 'c2' }, x.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'moved' });
    expect((r as { state?: string }).state).toContain('Are you legally authorized');
    expect(x.classifier.classify).toHaveBeenCalled();
  });

  it('next/back/save only; submit is not allowed here', async () => {
    const x = await opened({ start: 'wd-step3-review.html' });
    expect(await handleNext({ control: 'c2' }, x.deps)).toMatchObject({ status: 'refused', code: 'control_not_allowed' });
    expect(await handleNext({ control: 'c9' }, x.deps)).toMatchObject({ status: 'refused', code: 'unknown_control' });
    expect(x.site.events.filter((e) => e.startsWith('click'))).toEqual([]);
  });

  it('enforces APPLY_MAX_STEPS', async () => {
    const x = await opened({ start: 'wd-step1-personal.html', transitions: STEPS, env: { APPLY_MAX_STEPS: '1' } });
    expect(await handleNext({ control: 'c2' }, x.deps)).toMatchObject({ status: 'ok' });
    expect(await handleNext({ control: 'c2' }, x.deps)).toMatchObject({ status: 'refused', code: 'max_steps' });
  });

  it('re-runs the marketing-box gate before leaving a step', async () => {
    const stepWithBox = '<html><body><form><label>Email <input type="email"></label><label><input type="checkbox" checked> Send me job alerts and newsletters</label><button type="button">Back</button><button type="submit">Save and Continue</button></form></body></html>';
    let x = await opened({ start: stepWithBox, transitions: { 'Save and Continue': [{ fixture: 'wd-step3-review.html' }] } });
    expect(await handleNext({ control: 'c2' }, x.deps)).toMatchObject({ status: 'ok' });
    expect(x.site.events.indexOf('click:field:Send me job alerts and newsletters')).toBeGreaterThanOrEqual(0);
    expect(x.site.events.indexOf('click:field:Send me job alerts and newsletters')).toBeLessThan(x.site.events.indexOf('click:control:Save and Continue'));
    await x.close(); h = null;
    x = await opened({ start: stepWithBox, stickyLabel: /newsletters/i, transitions: { 'Save and Continue': [{ fixture: 'wd-step3-review.html' }] } });
    expect(await handleNext({ control: 'c2' }, x.deps)).toMatchObject({ status: 'needs_owner', code: 'marketing_checkbox' });
    expect(x.site.events.some((e) => e === 'click:control:Save and Continue')).toBe(false);
  });

  it('a block after the click is reported and escalated', async () => {
    const x = await opened({ start: 'wd-step1-personal.html', transitions: { 'Save and Continue': [{ fixture: 'captcha-wall.html' }] } });
    expect(await handleNext({ control: 'c2' }, x.deps)).toMatchObject({ status: 'blocked', code: 'captcha' });
    expect(x.escalations.some(([k]) => k === 'block')).toBe(true);
  });
});
