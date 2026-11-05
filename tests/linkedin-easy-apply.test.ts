// LinkedIn Easy Apply through the engine: arm (kind easy_apply) -> click the page's own Easy Apply control -> code-owned fill of each modal
// step -> Next / Review / Submit application through the commit guard. Fake page over invented HTML; nothing is applied anywhere.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAnswerBook } from '../src/apply/answers.js';
import { saveJob } from '../src/db.js';
import { countSince } from '../src/outreach/limits.js';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { classify, checkType, dialogKindOf } from '../src/browserctl/guard.js';
import { world, refOf, type World } from './helpers/bcWorld.js';

const JOB = 'li-job:4012345678';
const JOB_URL = 'https://www.linkedin.com/jobs/view/4012345678/';
const ENV = { JOBBER_DRY_RUN: 'false', APPLY_LINKEDIN_EASY: 'true', MAX_APPLIES_PER_DAY: '5', JOBBER_RUN_LANE: 'linkedin_drip' };

const dirs: string[] = [];
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const jobPage = (o: { extra?: string; control?: string } = {}): string => `<html><head><title>Full Stack Developer | Acme | LinkedIn</title></head><body><main>
<h1>Full Stack Developer</h1><p>Acme · Remote</p>${o.control ?? '<button>Easy Apply</button>'}<button>Save</button>${o.extra ?? ''}</main></body></html>`;

interface Form { phone?: string; remote?: 'yes' | 'no' | ''; sent?: boolean; extra?: string }
const step1 = (f: Form = {}): string => jobPage({ extra: `<div role="dialog" aria-label="Apply to Acme"><h2>Apply to Acme</h2><p>Progress 25%</p><p>Contact info</p>
<label>Mobile phone number</label><input type="text" value="${f.phone ?? ''}">
<p>Are you comfortable working remotely?</p>
<input type="radio" name="r" ${f.remote === 'yes' ? 'checked' : ''}><span>Yes</span><input type="radio" name="r" ${f.remote === 'no' ? 'checked' : ''}><span>No</span>
${f.extra ?? ''}<footer><button>Next</button></footer></div>` });
const review = (o: { sent?: boolean } = {}): string => jobPage({ extra: `<div role="dialog" aria-label="Apply to Acme"><h2>${o.sent ? 'Application sent' : 'Review your application'}</h2>
<p>Progress 100%</p>${o.sent ? '<p>Your application was sent to Acme</p>' : '<footer><button>Back</button><button>Submit application</button></footer>'}</div>` });

function setup(o: { env?: Record<string, string>; answers?: object; resume?: boolean; html?: string; custom?: Record<string, string> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ea-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'renderer', 'automation', 'job1'), { recursive: true });
  const pdf = path.join('renderer', 'automation', 'job1', 'resume.pdf');
  writeFileSync(path.join(root, pdf), '%PDF-1.4 fake');
  const ans = path.join(root, 'answers.json');
  const prof = path.join(root, 'profile.json');
  writeFileSync(ans, JSON.stringify(o.answers ?? { phone: '+91 90000 00000', years_experience: 3, authorized_to_work: true, custom: { 'are you comfortable working remotely?': true, ...(o.custom ?? {}) } }));
  writeFileSync(prof, JSON.stringify({ name: 'Rahat Sayyed', email: 'rahat@example.test', phone: '+91 90000 00000' }));
  const w = world({
    html: o.html ?? jobPage(), url: JOB_URL, env: { ...ENV, ...(o.env ?? {}) }, seed: false,
    attach: { root, resumeName: () => 'Rahat Sayyed' },
    easyApply: { answers: () => loadAnswerBook({ answersPath: ans, profilePath: prof }) },
  });
  worlds.push(w);
  saveJob(w.db, { id: JOB, source: 'linkedin-jobs', title: 'Full Stack Developer', company: 'Acme', url: JOB_URL, apply_url: JOB_URL, description: 'Remote\nReact.' });
  w.db.prepare("INSERT INTO outreach_queue (job_id, resume_pdf_path, apply_platform, apply_tier, apply_url, status) VALUES (?,?,?,?,?,'queued')")
    .run(JOB, o.resume === false ? null : pdf, 'linkedin_easy', 'agent', JOB_URL);
  // The fake page reacts to the actions like the form would: a fill sets the phone, a radio click checks it, the controls move the steps.
  const form: Form = {};
  w.page.onAct = (what) => {
    const m = /^(fill|click) (\d+)(?: (.*))?$/.exec(what);
    if (!m) return;
    const n = Number(m[2]);
    const node = buildTreeFromHtml(w.page.currentHtml(), JOB_URL).nodes.find((x) => x.n === n);
    if (!node) return;
    if (m[1] === 'fill') { form.phone = m[3]; w.page.setHtml(step1(form)); return; }
    if (node.role === 'radio') {
      const radios = buildTreeFromHtml(w.page.currentHtml(), JOB_URL).nodes.filter((x) => x.role === 'radio');
      form.remote = radios[0]?.n === n ? 'yes' : 'no';
      w.page.setHtml(step1(form));
    } else if (node.role === 'button' && node.name === 'Easy Apply') w.page.setHtml(step1(form));
    else if (node.role === 'button' && node.name === 'Next') w.page.setHtml(review());
    else if (node.role === 'button' && node.name === 'Submit application') w.page.setHtml(review({ sent: true }));
  };
  return { w, form };
}

async function click(w: World, role: string, name: string) { return w.engine.click(refOf(await w.snap(), role, name)); }
const appRows = (w: World) => w.db.prepare('SELECT platform, method, status FROM applications WHERE job_id = ?').all(JOB);
const queue = (w: World) => w.db.prepare('SELECT apply_status, apply_note, apply_platform FROM outreach_queue WHERE job_id = ?').get(JOB) as { apply_status: string | null; apply_note: string | null; apply_platform: string };

describe('guard: Easy Apply classes', () => {
  it('classifies the page control and the modal step controls; refuses the rest of the modal', () => {
    expect(dialogKindOf('Apply to Acme')).toBe('easy_apply');
    expect(classify({ platform: 'linkedin', role: 'button', name: 'Easy Apply' })).toBe('linkedin_easy_apply');
    expect(classify({ platform: 'linkedin', role: 'button', name: 'Easy Apply to Acme' })).toBe('linkedin_easy_apply');
    const m = { platform: 'linkedin' as const, dialogKind: 'easy_apply' as const };
    for (const n of ['Next', 'Review', 'Submit application']) expect(classify({ ...m, role: 'button', name: n })).toBe('linkedin_easy_apply');
    expect(classify({ ...m, role: 'button', name: 'Dismiss' })).toBe('free');
    expect(classify({ ...m, role: 'button', name: 'Done' })).toBe('irreversible_other');
    expect(classify({ ...m, role: 'button', name: 'Upload resume' })).toBe('irreversible_other');
    for (const r of ['radio', 'checkbox', 'combobox', 'file']) expect(classify({ ...m, role: r, name: 'Yes' })).toBe('irreversible_other');
    // Outside LinkedIn the name is not an Easy Apply control.
    expect(classify({ platform: 'naukri', role: 'button', name: 'Easy Apply' })).toBe('naukri_apply');
  });
  it('typing into a modal field under an Easy Apply intent is refused', () => {
    const node = { n: 1, role: 'textbox', name: '', text: '', disabled: false, composer: true } as never;
    expect(checkType(node, 'hello', { class: 'linkedin_easy_apply', text: null })).toMatchObject({ ok: false, code: 'text_not_allowed' });
  });
});

describe('arm kind easy_apply', () => {
  it('arms with a job id only, opens the page from SQLite and returns the resume name, never a path', async () => {
    const { w } = setup();
    const r = await w.arm({ kind: 'easy_apply', job_id: JOB });
    expect(r).toMatchObject({ status: 'armed', class: 'linkedin_easy_apply', dry_run: false, attachment: { name: 'Rahat-Sayyed-Resume.pdf' } });
    expect(JSON.stringify(r)).not.toContain('renderer');
    expect(w.page.log.filter((l) => l.startsWith('goto'))).toEqual([`goto ${JOB_URL}`]);
    expect(countSince(w.db, 'linkedin_profile_view', new Date(0))).toBe(1);
  });
  it('works only inside the LinkedIn drip lane run (a wake or an interactive session is refused)', async () => {
    const { w } = setup({ env: { JOBBER_RUN_LANE: '' } });
    expect(await w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'refused', code: 'drip_lane_only' });
    expect(w.page.log.some((l) => l.startsWith('goto'))).toBe(false);
  });
  it('a worker window without the linkedin_drip marker (the mail window, a bare or other lane name) cannot arm it', async () => {
    for (const lane of ['mail', 'linkedin', 'wake', 'LINKEDIN_DRIP']) {
      const { w } = setup({ env: { JOBBER_RUN_LANE: lane } });
      expect(await w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'refused', code: 'drip_lane_only' });
      expect(w.page.log.some((l) => l.startsWith('goto'))).toBe(false);
    }
  });
  it('is refused while APPLY_LINKEDIN_EASY is off, for unknown, vetoed and applied jobs, and without a resume', async () => {
    const off = setup({ env: { APPLY_LINKEDIN_EASY: 'false' } });
    expect(await off.w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'refused', code: 'easy_apply_off' });
    const a = setup();
    expect(await a.w.arm({ kind: 'easy_apply', job_id: 'li-job:999' })).toMatchObject({ code: 'unknown_job' });
    expect(await a.w.arm({ kind: 'easy_apply' })).toMatchObject({ code: 'bad_job_id' });
    a.w.db.prepare("UPDATE jobs SET excluded_reason = 'x' WHERE id = ?").run(JOB);
    expect(await a.w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ code: 'vetoed' });
    a.w.db.prepare("UPDATE jobs SET excluded_reason = NULL WHERE id = ?").run(JOB);
    a.w.db.prepare("INSERT INTO applications (job_id, platform, status) VALUES (?, 'linkedin', 'submitted')").run(JOB);
    expect(await a.w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ code: 'already_applied' });
    const nr = setup({ resume: false });
    expect(await nr.w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'refused', code: 'attachment_no_resume' });
    expect(nr.w.page.log.some((l) => l.startsWith('goto'))).toBe(false);
  });
  it('respects the linkedin_easy_apply ceiling, the shared apply room and the profile-view ceiling', async () => {
    const c = setup({ env: { LINKEDIN_MAX_EASY_APPLIES_PER_DAY: '0' } });
    expect(await c.w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'rate_limited' });
    const d = setup({ env: { MAX_APPLIES_PER_DAY: '1' } });
    d.w.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'easy_apply', 1)").run();
    expect(await d.w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'rate_limited' });
    const v = setup({ env: { LINKEDIN_MAX_PROFILE_VIEWS_PER_DAY: '0' } });
    expect(await v.w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'rate_limited', code: 'profile_view_limit' });
    expect(v.w.page.log.some((l) => l.startsWith('goto'))).toBe(false);
  });
  it('hands a job whose Apply goes to the company site back to the external-apply route and never retries it', async () => {
    const { w } = setup({ html: jobPage({ control: '<button>Apply</button>' }) });
    expect(await w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'refused', code: 'not_easy_apply' });
    expect(queue(w)).toMatchObject({ apply_platform: 'linkedin', apply_note: 'easy_apply:not_easy_apply', apply_status: null });
    expect(await w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ code: 'not_easy_apply' });
  });
  it('a job page that already shows Applied is parked for the owner, not applied to', async () => {
    const { w } = setup({ html: jobPage({ control: '<button>Easy Apply</button><p>Applied 2 days ago</p>' }) });
    expect(await w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ code: 'already_applied_on_page' });
    expect(queue(w)).toMatchObject({ apply_status: 'needs_owner', apply_note: 'easy_apply:already_applied_on_page' });
  });
  it('dry run arms a dry intent and clicks nothing', async () => {
    const { w } = setup({ env: { JOBBER_DRY_RUN: 'true' } });
    expect(await w.arm({ kind: 'easy_apply', job_id: JOB })).toMatchObject({ status: 'armed', dry_run: true });
    expect(await click(w, 'button', 'Easy Apply')).toMatchObject({ ok: true, status: 'dry_run' });
    expect(w.page.log.filter((l) => l.startsWith('click'))).toEqual([]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM dry_run_actions WHERE action = 'linkedin_easy_apply'").get()).toMatchObject({ n: 1 });
  });
});

describe('the application flow', () => {
  it('opens, fills from the answer book, steps, submits and records the application once', async () => {
    const { w } = setup();
    expect((await w.arm({ kind: 'easy_apply', job_id: JOB })).status).toBe('armed');
    expect(await click(w, 'button', 'Easy Apply')).toMatchObject({ ok: true, code: 'modal_opened' });

    // Next is refused until the code-owned fill passed for this step.
    expect(await click(w, 'button', 'Next')).toMatchObject({ ok: false, code: 'fill_required' });

    const f1 = await w.engine.easyApplyFill();
    expect(f1).toMatchObject({ ok: true, code: 'filled', detail: { filled: 2, next: 'next', step: 1 } });
    expect(w.page.log.some((l) => l.includes('fill') && l.includes('+91 90000 00000'))).toBe(true);
    expect(await click(w, 'button', 'Next')).toMatchObject({ ok: true, code: 'step_ok' });

    const f2 = await w.engine.easyApplyFill();
    expect(f2).toMatchObject({ ok: true, detail: { next: 'submit', step: 2 } });
    const sub = await click(w, 'button', 'Submit application');
    expect(sub).toMatchObject({ ok: true, status: 'sent', code: 'applied' });
    expect(appRows(w)).toEqual([{ platform: 'linkedin', method: 'easy_apply', status: 'submitted' }]);
    expect(queue(w).apply_status).toBe('submitted');
    expect(countSince(w.db, 'linkedin_easy_apply', new Date(0))).toBe(1);
    expect(w.db.prepare("SELECT count FROM daily_counters WHERE key = 'easy_apply'").get()).toMatchObject({ count: 1 });
    // The intent is gone: a second Submit does nothing.
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Easy Apply')).catch(() => ({ ok: false }))).toMatchObject({ ok: false });
  });

  it('the model cannot type into the modal or click a choice field by hand', async () => {
    const { w } = setup();
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    const s = await w.snap();
    expect(await w.engine.type(refOf(s, 'textbox', ''), '+91 1', false)).toMatchObject({ ok: false, code: 'text_not_allowed' });
    const radio = await w.engine.click(refOf(s, 'radio', ''));
    expect(radio).toMatchObject({ ok: false });
    expect(w.page.log.some((l) => l.startsWith('fill'))).toBe(false);
  });

  it('an unanswered required question parks the job as needs_answer, records it and closes the modal', async () => {
    const { w } = setup({ answers: { phone: '+91 90000 00000', custom: {} } });
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    const f = await w.engine.easyApplyFill();
    expect(f).toMatchObject({ ok: false, code: 'needs_answer', detail: { questions: 1 } });
    expect(queue(w)).toMatchObject({ apply_status: 'needs_answer' });
    const q = w.db.prepare("SELECT label, host, kind, status FROM apply_questions").all();
    expect(q).toEqual([{ label: 'Are you comfortable working remotely?', host: 'linkedin.com', kind: 'radio', status: 'open' }]);
    expect(w.page.log).toContain('press Escape');
    expect(w.page.log.filter((l) => l.startsWith('fill'))).toEqual([]);
    expect(w.intents.peek('linkedin')).toBeNull();
    expect(w.db.prepare("SELECT reason FROM escalations WHERE platform = 'apply'").all()).toEqual([{ reason: 'apply:needs_answer' }]);
  });

  it('an answer the owner stored (once) is used', async () => {
    const { w } = setup({ answers: { phone: '+91 90000 00000', custom: {} } });
    w.db.prepare("INSERT INTO apply_questions (job_id, host, label, norm_label, kind, options, status, answer, answer_scope, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(JOB, 'linkedin.com', 'Are you comfortable working remotely?', 'are you comfortable working remotely?', 'radio', '[]', 'answered', 'Yes', 'always', '2026-10-14T00:00:00Z');
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    expect(await w.engine.easyApplyFill()).toMatchObject({ ok: true, code: 'filled' });
  });

  it.each([
    ['a CAPTCHA', '<p>Complete the CAPTCHA to continue</p>', 'verification'],
    ['a premium upsell', '<p>Try Premium for free to stand out</p>', 'premium_upsell'],
    ['an unknown button', '<button>Pay now</button>', 'unknown_button'],
  ])('%s closes the modal and parks the job needs_owner (%s)', async (_n, extra, code) => {
    const { w, form } = setup();
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    form.extra = extra;
    w.page.setHtml(step1(form));
    const f = await w.engine.easyApplyFill();
    expect(f).toMatchObject({ ok: false, code: 'needs_owner', detail: { park: code } });
    expect(queue(w)).toMatchObject({ apply_status: 'needs_owner', apply_note: `easy_apply:${code}` });
    expect(w.db.prepare("SELECT reason FROM escalations WHERE platform = 'apply'").all()).toEqual([{ reason: 'apply:linkedin_easy_apply' }]);
    expect(w.page.log).toContain('press Escape');
    expect(w.intents.peek('linkedin')).toBeNull();
    expect(appRows(w)).toEqual([]);
  });

  it('more than 8 steps parks the job', async () => {
    const { w } = setup();
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    // Next keeps showing the same step: every Next passes the fill and the guard until the 8th.
    w.page.onAct = (what) => { if (/^click/.test(what)) w.page.setHtml(step1({ phone: '+91 90000 00000', remote: 'yes' })); };
    w.page.setHtml(step1({ phone: '+91 90000 00000', remote: 'yes' }));
    for (let i = 0; i < 8; i++) {
      expect(await w.engine.easyApplyFill()).toMatchObject({ ok: true });
      expect(await click(w, 'button', 'Next')).toMatchObject({ ok: true, code: 'step_ok' });
    }
    expect(await w.engine.easyApplyFill()).toMatchObject({ ok: false, code: 'needs_owner', detail: { park: 'more_than_8_steps' } });
    expect(queue(w).apply_note).toBe('easy_apply:more_than_8_steps');
  });

  it('an unconfirmed submit is recorded manual_review, counted once, and never retried', async () => {
    const { w } = setup();
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    await w.engine.easyApplyFill();
    await click(w, 'button', 'Next');
    await w.engine.easyApplyFill();
    w.page.onAct = undefined; // the page does not react to the click
    const r = await click(w, 'button', 'Submit application');
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed' });
    expect(appRows(w)).toEqual([{ platform: 'linkedin', method: 'easy_apply', status: 'manual_review' }]);
    expect(queue(w)).toMatchObject({ apply_status: 'manual_review', apply_note: 'easy_apply:unconfirmed' });
    expect(countSince(w.db, 'linkedin_easy_apply', new Date(0))).toBe(1);
  });

  it('a spent shared daily counter stops the submit before the click and leaves both counters untouched', async () => {
    const { w } = setup({ env: { MAX_APPLIES_PER_DAY: '1' } });
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    await w.engine.easyApplyFill();
    await click(w, 'button', 'Next');
    await w.engine.easyApplyFill();
    w.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'easy_apply', 1)").run();
    const r = await click(w, 'button', 'Submit application');
    expect(r).toMatchObject({ ok: false, status: 'rate_limited' });
    expect(countSince(w.db, 'linkedin_easy_apply', new Date(0))).toBe(0);
    expect(w.page.log.filter((l) => l.startsWith('click')).length).toBe(3); // Easy Apply, the answered radio and Next; never Submit
    expect(appRows(w)).toEqual([]);
  });

  it('a veto that lands after arming stops the click', async () => {
    const { w } = setup();
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    w.db.prepare("UPDATE jobs SET excluded_reason = 'hard stop' WHERE id = ?").run(JOB);
    expect(await click(w, 'button', 'Easy Apply')).toMatchObject({ ok: false, code: 'vetoed' });
  });

  it('without an arm the Easy Apply control is refused', async () => {
    const { w } = setup();
    expect(await click(w, 'button', 'Easy Apply')).toMatchObject({ ok: false, code: 'no_armed_intent' });
  });

  it('the kill switch stops the fill', async () => {
    const { w } = setup();
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    writeFileSync(w.stopFile, 'x');
    expect(await w.engine.easyApplyFill()).toMatchObject({ ok: false, code: 'killed' });
  });

  it('the operator can abort: the modal is closed and the job parked', async () => {
    const { w } = setup();
    await w.arm({ kind: 'easy_apply', job_id: JOB });
    await click(w, 'button', 'Easy Apply');
    expect(await w.engine.easyApplyAbort()).toMatchObject({ ok: false, code: 'needs_owner' });
    expect(queue(w)).toMatchObject({ apply_status: 'needs_owner', apply_note: 'easy_apply:operator_abort' });
  });
});
