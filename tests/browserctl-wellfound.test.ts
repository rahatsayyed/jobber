// Wellfound on the browserctl engine: guard classes, open and block pages, the type guard, the message arm
// gates, the wellfound_send commit path and the wellfound_apply commit path with the optional note.
// Everything runs on a fake page over invented HTML; nothing is really sent or applied and no site is contacted.
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { haltPlatform, haltReason, recordEvent, countSince } from '../src/outreach/limits.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { listDryRun } from '../src/safety/dryRun.js';
import { getState } from '../src/scheduler/runLog.js';
import { saveApplication, saveJob } from '../src/db.js';
import { pauseContact } from '../src/linkedin/touches.js';
import { upsertPerson } from '../src/outreach/people.js';
import { bumpFailures, FAILURE_LIMIT, threadStateKey } from '../src/wellfound/sendState.js';
import { armWellfoundMessage } from '../src/browserctl/arm/wellfound.js';
import { checkType, classify, classifyKey, isWellfoundApplyName } from '../src/browserctl/guard.js';
import type { LiveNode } from '../src/browserctl/snapshot.js';
import { JOB_ID, JOB_URL, LIVE_ENV, MSG, NOTE, NOW, THREAD, THREAD_URL, jobHtml, refOf, threadHtml, wfWorld, type WfWorld } from './helpers/wfWorld.js';

const DRY_ENV: Record<string, string> = { JOBBER_DRY_RUN: 'true' };

const worlds: WfWorld[] = [];
const mk = (o: Parameters<typeof wfWorld>[0]) => { const w = wfWorld(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const clicks = (w: WfWorld) => w.page.log.filter((l) => l.startsWith('click'));
const touches = (w: WfWorld) => w.db.prepare('SELECT status, kind FROM touches').all() as { status: string; kind: string }[];
const ceiling = (w: WfWorld, key: string) => countSince(w.db, key as never, new Date(0));
const applications = (w: WfWorld) => w.db.prepare("SELECT job_id, platform, method, status FROM applications").all() as { job_id: string; platform: string; method: string; status: string }[];

// ---------------------------------------------------------------------------------------------
describe('guard classes: wellfound_apply and wellfound_send', () => {
  const g = (name: string, o: Partial<Parameters<typeof classify>[0]> = {}) =>
    classify({ platform: 'wellfound', role: 'button', name, ...o });

  it('Apply and Apply now are the wellfound_apply click; the Apply name test is exact', () => {
    expect(g('Apply')).toBe('wellfound_apply');
    expect(g('Apply now')).toBe('wellfound_apply');
    expect(g('  APPLY  ')).toBe('wellfound_apply');
    expect(isWellfoundApplyName('Apply')).toBe(true);
    expect(isWellfoundApplyName('Submit application')).toBe(false);
  });

  it('Submit application and Send application are wellfound_apply step controls', () => {
    expect(g('Submit application', { dialogName: 'Apply to Acme', inFooter: true })).toBe('wellfound_apply');
    expect(g('Send application')).toBe('wellfound_apply');
    expect(g('Submit', { dialogName: 'Apply to Acme' })).toBe('wellfound_apply');
    expect(g('Submit')).toBe('irreversible_other');
  });

  it('Send is wellfound_send on a thread, wellfound_apply inside the form, irreversible elsewhere', () => {
    expect(g('Send', { pageKind: 'thread' })).toBe('wellfound_send');
    expect(g('Send message', { pageKind: 'thread' })).toBe('wellfound_send');
    expect(g('Send', { dialogName: 'Apply to Acme' })).toBe('wellfound_apply');
    expect(g('Send', { inComposer: true })).toBe('wellfound_apply');
    expect(g('Send', { pageKind: 'job' })).toBe('irreversible_other');
  });

  it('off-site apply links are never clicked', () => {
    expect(g('Apply on company site')).toBe('irreversible_other');
    expect(g('Apply on company website')).toBe('irreversible_other');
    expect(g('Apply externally')).toBe('irreversible_other');
    expect(classify({ platform: 'wellfound', role: 'link', name: 'Apply on company site', href: 'https://acme.example/careers' })).toBe('irreversible_other');
  });

  it('fails closed: an unknown dialog-footer or submit button is irreversible_other', () => {
    expect(g('Continue to payment', { dialogName: 'Apply to Acme', inFooter: true })).toBe('irreversible_other');
    expect(g('Boost your application', { isSubmit: true })).toBe('irreversible_other');
    expect(g('Follow Acme')).toBe('irreversible_other');
    expect(g('Save')).toBe('free');
    expect(g('Cancel', { dialogName: 'Apply to Acme', inFooter: true })).toBe('free');
  });

  it('non-actionable roles are free, a point in a dialog footer fails closed', () => {
    expect(classify({ platform: 'wellfound', role: 'heading', name: 'Apply' })).toBe('free');
    expect(classify({ platform: 'wellfound', role: 'text', name: '', dialogName: 'Apply to Acme', inFooter: true, viaPoint: true })).toBe('irreversible_other');
  });

  it('a wellfound control is never classed as a LinkedIn or Naukri commit, and the other way round', () => {
    expect(classify({ platform: 'linkedin', role: 'button', name: 'Apply' })).toBe('irreversible_other');
    expect(classify({ platform: 'naukri', role: 'button', name: 'Apply' })).toBe('naukri_apply');
    expect(classify({ platform: 'wellfound', role: 'button', name: 'Connect' })).toBe('irreversible_other');
  });

  it('Enter in a composer is the Send (thread) or the form step (dialog); Space on a control is its click', () => {
    expect(classifyKey({ platform: 'wellfound', role: 'textbox', name: 'x', inComposer: true, pageKind: 'thread', key: 'Enter' })).toBe('wellfound_send');
    expect(classifyKey({ platform: 'wellfound', role: 'textbox', name: 'x', inComposer: true, pageKind: 'job', key: 'Enter' })).toBe('wellfound_apply');
    expect(classifyKey({ platform: 'wellfound', role: 'button', name: 'Apply', key: 'Space' })).toBe('wellfound_apply');
    expect(classifyKey({ platform: 'wellfound', role: 'textbox', name: 'x', inComposer: true, key: 'Escape' })).toBe('free');
  });

  it('checkType: a wellfound_apply intent allows only its armed note', () => {
    const box: LiveNode = { n: 1, role: 'textbox', name: 'Write a note', text: '', composer: true } as LiveNode;
    expect(checkType(box, 'anything', { class: 'wellfound_apply', text: null })).toMatchObject({ ok: false, code: 'text_not_allowed' });
    expect(checkType(box, 'other text', { class: 'wellfound_apply', text: NOTE })).toMatchObject({ ok: false, code: 'intent_text_mismatch' });
    expect(checkType(box, NOTE, { class: 'wellfound_apply', text: NOTE })).toEqual({ ok: true, mode: 'composer' });
    expect(checkType(box, NOTE, null)).toMatchObject({ ok: false, code: 'no_armed_intent' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('wellfound engine: open, blocks and free actions', () => {
  it('refuses off-site and blocked URLs and navigates to a wellfound page', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.engine.open('https://evil.example/jobs/messages')).code).toBe('not_wellfound');
    expect((await w.engine.open('https://wellfound.com.evil.io/x')).code).toBe('not_wellfound');
    expect((await w.engine.open('http://wellfound.com/jobs')).code).toBe('not_wellfound');
    expect((await w.engine.open('https://wellfound.com/logout')).code).toBe('blocked_path');
    expect(w.page.log.some((l) => l.startsWith('goto'))).toBe(false);
    const r = await w.engine.open(THREAD_URL);
    expect(r.ok).toBe(true);
    expect(r.state).toContain('<<<PAGE_TEXT');
  });

  it('a bot wall halts wellfound and the halt sticks', async () => {
    const w = mk({ html: '<html><head><title>Just a moment...</title></head><body><h1>Just a moment...</h1></body></html>', url: JOB_URL, env: LIVE_ENV });
    expect((await w.engine.snapshot()).code).toBe('halted');
    expect(haltReason(w.db, 'wellfound')).toContain('blocked');
    expect(haltReason(w.db, 'naukri')).toBeNull();
    expect((await w.engine.snapshot()).code).toBe('halted');
  });

  it('a CAPTCHA page halts wellfound', async () => {
    const w = mk({ html: '<html><head><title>Wellfound</title></head><body><h1>Please verify you are human</h1><p>Complete the CAPTCHA</p></body></html>', url: JOB_URL, env: LIVE_ENV });
    expect((await w.engine.snapshot()).code).toBe('halted');
    expect(haltReason(w.db, 'wellfound')).toContain('captcha');
  });

  it('a login wall is reported as login_required and halts nothing', async () => {
    const w = mk({ html: '<html><head><title>Log in</title></head><body><input type="password"></body></html>', url: 'https://wellfound.com/login', env: LIVE_ENV });
    expect((await w.engine.snapshot()).code).toBe('login_required');
    expect(haltReason(w.db, 'wellfound')).toBeNull();
  });

  it('screenshot and click_at are off unless WELLFOUND_SCREENSHOT is on, and say which flag', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const s = await w.engine.screenshot();
    expect(s.code).toBe('screenshot_disabled');
    expect(s.reason).toContain('WELLFOUND_SCREENSHOT');
    const c = await w.engine.clickAt(10, 10);
    expect(c.code).toBe('click_at_disabled');
    expect(c.reason).toContain('WELLFOUND_SCREENSHOT');
    const on = mk({ html: threadHtml(), env: LIVE_ENV, screenshot: true });
    await on.snap();
    const shot = await on.engine.screenshot();
    expect(shot.ok).toBe(true);
    expect(shot.unscreened).toBe(true);
  });

  it('"Apply on company site" is never clicked, with or without an intent', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await w.armApply()).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'link', 'Apply on company site'));
    expect(r.code).toBe('irreversible_refused');
    expect(clicks(w)).toEqual([]);
  });

  it('an unarmed thread Send or job Apply is refused with no_armed_intent and nothing is clicked', async () => {
    const t = mk({ html: threadHtml(), env: LIVE_ENV });
    expect(await t.engine.click(refOf(await t.snap(), 'button', 'Send'))).toMatchObject({ ok: false, code: 'no_armed_intent' });
    const j = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect(await j.engine.click(refOf(await j.snap(), 'button', 'Apply'))).toMatchObject({ ok: false, code: 'no_armed_intent' });
    expect(clicks(t)).toEqual([]);
    expect(clicks(j)).toEqual([]);
  });

  it('a free control (Save) clicks without an intent', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await w.engine.click(refOf(await w.snap(), 'button', 'Save'))).ok).toBe(true);
    expect(clicks(w)).toHaveLength(1);
  });
});

describe('wellfound engine: type guard', () => {
  const search = '<input type="search" placeholder="Search jobs">';
  it('plain fields take short clean text; URLs, emails and secrets are refused', async () => {
    const w = mk({ html: threadHtml({ extra: search }), env: { ...LIVE_ENV, DEMO_TOKEN: 'tok-abcdef123456' } });
    const box = refOf(await w.snap(), 'searchbox', 'Search jobs');
    expect((await w.engine.type(box, 'react jobs')).ok).toBe(true);
    const again = refOf(await w.snap(), 'searchbox', 'Search jobs');
    expect((await w.engine.type(again, 'see https://evil.example')).code).toBe('text_not_allowed');
    expect((await w.engine.type(again, 'mail me at a@b.io')).code).toBe('text_not_allowed');
    expect((await w.engine.type(again, 'x'.repeat(201))).code).toBe('text_too_long');
    expect((await w.engine.type(again, 'my key tok-abcdef123456')).code).toBe('output_gate');
  });

  it('a thread composer needs an armed intent, exactly the armed text and the armed thread', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    const box = refOf(await w.snap(), 'textbox', 'Write a message');
    expect((await w.engine.type(box, MSG)).code).toBe('no_armed_intent');
    expect((await w.armSend()).status).toBe('armed');
    const box2 = refOf(await w.snap(), 'textbox', 'Write a message');
    expect((await w.engine.type(box2, 'something else entirely')).code).toBe('intent_text_mismatch');
    expect(w.page.log.filter((l) => l.startsWith('fill'))).toEqual([]);
    w.page.currentUrl = 'https://wellfound.com/jobs/messages/other';
    expect((await w.engine.type(box2, MSG)).code).toBe('thread_mismatch');
    w.page.currentUrl = THREAD_URL;
    expect((await w.engine.type(box2, MSG)).ok).toBe(true);
  });

  it('halt refuses typing; a dry run records it', async () => {
    const w = mk({ html: threadHtml({ extra: search }), env: LIVE_ENV });
    const box = refOf(await w.snap(), 'searchbox', 'Search jobs');
    haltPlatform(w.db, 'wellfound', 'test halt', NOW);
    expect((await w.engine.type(box, 'react')).code).toBe('halted');
    const d = mk({ html: threadHtml({ extra: search }), env: DRY_ENV });
    const dbox = refOf(await d.snap(), 'searchbox', 'Search jobs');
    expect((await d.engine.type(dbox, 'react')).ok).toBe(true);
    expect(listDryRun(d.db).map((x) => x.action)).toContain('wellfound_type');
  });
});

// ---------------------------------------------------------------------------------------------
describe('armWellfoundMessage: arm refusals', () => {
  it('arms a live send: reserves one touch, consumes nothing yet', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const a = await w.armSend();
    expect(a).toMatchObject({ status: 'armed', code: 'armed', class: 'wellfound_send', dry_run: false });
    expect(touches(w)).toEqual([{ status: 'sending', kind: 'role_ask' }]);
    expect(ceiling(w, 'wellfound_message')).toBe(0);
    expect(w.intents.peek('wellfound')?.threadRef).toBe(THREAD);
  });

  it('cold messages are impossible: an unknown thread is refused before any page load', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend({ thread_ref: 'someone-elses-thread' })).code).toBe('unverified_thread');
    expect(w.page.log).toEqual([]);
    expect(w.intents.peek('wellfound')).toBeNull();
  });

  it('an inbound founder or reply thread verifies a thread without a confirmed state', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    w.db.prepare('DELETE FROM scheduler_state WHERE key = ?').run(threadStateKey(w.pid));
    expect((await w.armSend()).code).toBe('unverified_thread');
    w.db.prepare(
      "INSERT INTO inbound_messages (platform, thread_ref, person_id, text_hash, klass, escalated, created_at) VALUES ('wellfound', ?, ?, 'h', 'recruiter_inquiry', 0, ?)",
    ).run(THREAD, w.pid, NOW.toISOString());
    expect((await w.armSend()).status).toBe('armed');
  });

  it('an inbound thread of another platform does not verify a wellfound thread', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    w.db.prepare('DELETE FROM scheduler_state WHERE key = ?').run(threadStateKey(w.pid));
    w.db.prepare(
      "INSERT INTO inbound_messages (platform, thread_ref, person_id, text_hash, klass, escalated, created_at) VALUES ('naukri', ?, ?, 'h', 'recruiter_inquiry', 0, ?)",
    ).run(THREAD, w.pid, NOW.toISOString());
    expect((await w.armSend()).code).toBe('unverified_thread');
  });

  it('bad kind, bad thread ref and empty or oversize text are refused first', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend({ kind: 'connect' as never })).code).toBe('bad_kind');
    expect((await w.armSend({ thread_ref: 'a b' })).code).toBe('bad_thread_ref');
    expect((await w.armSend({ text: '   ' })).code).toBe('empty_text');
    expect((await w.armSend({ text: 'x'.repeat(1801) })).code).toBe('message_too_long');
    expect(w.page.log).toEqual([]);
  });

  it('halted by wellfound or all, killed by STOP; a naukri halt does not stop wellfound', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    haltPlatform(w.db, 'wellfound', 'x', NOW);
    expect((await w.armSend()).status).toBe('halted');
    const all = mk({ html: threadHtml(), env: LIVE_ENV });
    haltPlatform(all.db, 'all', 'x', NOW);
    expect((await all.armSend()).status).toBe('halted');
    const nk = mk({ html: threadHtml(), env: LIVE_ENV });
    haltPlatform(nk.db, 'naukri', 'x', NOW);
    expect((await nk.armSend()).status).toBe('armed');
    const k = mk({ html: threadHtml(), env: LIVE_ENV });
    writeFileSync(k.stopFile, 'stop\n');
    expect(await k.armSend()).toMatchObject({ status: 'halted', code: 'killed' });
  });

  it('quiet hours refuse', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const r = await armWellfoundMessage({ ...w.armDeps, now: () => new Date('2026-10-14T21:00:00Z') }, { person_id: w.pid, thread_ref: THREAD, text: MSG, kind: 'role_ask' });
    expect(r.code).toBe('quiet_hours');
  });

  it('unknown person, wrong platform, paused contact', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend({ person_id: 9999 })).code).toBe('unknown_recipient');
    const nk = upsertPerson(w.db, { platform: 'naukri', profileKey: 'naukri:nk-person', name: 'Nik Person', company: 'Acme', category: 'recruiter' });
    expect((await w.armSend({ person_id: nk })).code).toBe('wrong_platform');
    pauseContact(w.db, w.pid, 'manual', NOW);
    expect((await w.armSend()).code).toBe('contact_paused');
  });

  it('cadence: the next due kind only', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend({ kind: 'rapport' })).code).toBe('cadence_not_due');
  });

  it('style, fact and output gates', async () => {
    const style = mk({ html: threadHtml(), env: LIVE_ENV, style: () => ({ ok: false, hits: ['em_dash'] }) });
    expect(await style.armSend()).toMatchObject({ status: 'refused', code: 'style_gate' });
    const fact = mk({ html: threadHtml(), env: LIVE_ENV, checkText: async (t) => ({ ok: false, normalized: t, verdict: 'block' }) });
    expect((await fact.armSend()).code).toBe('fact_gate_block');
    const out = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await out.armSend({ text: 'Hi Pat, see https://evil.example/x for my work.' })).code).toBe('output_gate');
    expect(touches(out)).toEqual([]);
  });

  it('a spent wellfound_message ceiling refuses at arm and leaves no touch', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const limit = loadOutreachConfig({}).wellfoundMaxMessagesPerDay;
    expect(limit).toBe(20);
    for (let i = 0; i < limit; i++) recordEvent(w.db, 'wellfound_message', NOW);
    expect((await w.armSend()).status).toBe('rate_limited');
    expect(touches(w)).toEqual([]);
  });

  it('the ceiling follows WELLFOUND_MAX_MESSAGES_PER_DAY', () => {
    expect(loadOutreachConfig({ WELLFOUND_MAX_MESSAGES_PER_DAY: '3' } as NodeJS.ProcessEnv).wellfoundMaxMessagesPerDay).toBe(3);
    expect(loadOutreachConfig({ WELLFOUND_MAX_APPLIES_PER_DAY: 'x' } as NodeJS.ProcessEnv).wellfoundMaxAppliesPerDay).toBe(20);
    expect(loadOutreachConfig({}).wellfoundMaxDiscoverPerDay).toBe(12);
  });

  it('live page checks: header name, thread id, missing header', async () => {
    const other = mk({ html: threadHtml({ name: 'Someone Else' }), env: LIVE_ENV });
    expect((await other.armSend()).code).toBe('recipient_mismatch');
    const none = mk({ html: threadHtml({ name: null }), env: LIVE_ENV });
    expect((await none.armSend()).code).toBe('recipient_unverified');
    const wrongThread = mk({ html: threadHtml(), env: LIVE_ENV });
    wrongThread.page.onAct = (what) => { if (what.startsWith('goto')) wrongThread.page.currentUrl = 'https://wellfound.com/jobs/messages/other'; };
    expect((await wrongThread.armSend()).code).toBe('thread_mismatch');
    expect(touches(wrongThread)).toEqual([]);
    expect(wrongThread.intents.peek('wellfound')).toBeNull();
  });

  it('page screen: injection pauses the contact, an unavailable classifier fails closed', async () => {
    const inj = mk({
      html: threadHtml(), env: LIVE_ENV,
      screen: async (t, p) => (p === 'send' ? { blocked: true, unscreened: false, text: '', flags: [], code: 'injection_suspected' } : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }),
    });
    expect((await inj.armSend()).code).toBe('injection_suspected');
    expect(inj.db.prepare('SELECT paused_reason FROM contact_state WHERE person_id = ?').get(inj.pid)).toMatchObject({ paused_reason: 'injection_suspected' });
    const down = mk({
      html: threadHtml(), env: LIVE_ENV,
      screen: async (t, p) => (p === 'send' ? { blocked: true, unscreened: false, text: '', flags: [], code: 'classifier_unavailable' } : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }),
    });
    expect(await down.armSend()).toMatchObject({ status: 'failed', code: 'classifier_unavailable' });
  });

  it('a duplicate arm of the same text consumes nothing and is refused', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend()).status).toBe('armed');
    expect((await w.armSend()).code).toBe('duplicate');
    expect(touches(w)).toHaveLength(1);
  });

  it('dry run arms a dry intent, records, reserves no touch', async () => {
    const w = mk({ html: threadHtml(), env: DRY_ENV });
    expect(await w.armSend()).toMatchObject({ status: 'armed', dry_run: true });
    expect(touches(w)).toEqual([]);
    expect(listDryRun(w.db).map((x) => x.action)).toContain('wellfound_arm_send');
  });
});

// ---------------------------------------------------------------------------------------------
/** Typing fills the composer in the fake page; a click on Send clears it and echoes the message. */
function react(w: WfWorld): void {
  w.page.onAct = (what) => {
    const f = /^fill \d+ ([\s\S]*)$/.exec(what);
    if (f) w.page.setHtml(threadHtml({ text: f[1] }));
    else if (what.startsWith('click') || what === 'press Enter') w.page.setHtml(threadHtml({ text: '', sent: MSG }));
  };
}

async function armAndType(w: WfWorld, text = MSG): Promise<string> {
  expect((await w.armSend()).status).toBe('armed');
  const box = refOf(await w.snap(), 'textbox', 'Write a message');
  const t = await w.engine.type(box, text);
  expect(t.ok, JSON.stringify(t)).toBe(true);
  return refOf(await w.snap(), 'button', 'Send');
}

describe('wellfound_send commit path', () => {
  it('sends: types the armed text, clicks Send, confirms by echo, records everything once', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const r = await w.engine.click(await armAndType(w));
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(clicks(w)).toHaveLength(1);
    expect(touches(w)).toEqual([{ status: 'sent', kind: 'role_ask' }]);
    expect(ceiling(w, 'wellfound_message')).toBe(1);
    expect(getState(w.db, threadStateKey(w.pid))).toBe(THREAD);
    expect(w.db.prepare('SELECT stage FROM contact_state WHERE person_id = ?').get(w.pid)).toMatchObject({ stage: 'active' });
    expect(w.intents.peek('wellfound')).toBeNull();
  });

  it('the intent is single use: a second Send click is refused', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    await w.engine.click(await armAndType(w));
    w.page.setHtml(threadHtml({ text: MSG }));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('no_armed_intent');
    expect(clicks(w)).toHaveLength(1);
  });

  it('a spent ceiling at commit time refuses, clicks nothing and releases the touch', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    for (let i = 0; i < 20; i++) recordEvent(w.db, 'wellfound_message', NOW);
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: false, status: 'rate_limited' });
    expect(clicks(w)).toEqual([]);
    expect(touches(w)).toEqual([{ status: 'refused', kind: 'role_ask' }]);
  });

  it('typed text changed after arming: the commit refuses on the live composer text', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    w.page.setHtml(threadHtml({ text: 'Different text sneaked in' }));
    const r = await w.engine.click(send);
    expect(r.ok).toBe(false);
    expect(clicks(w)).toEqual([]);
  });

  it('dry run: arm, type, click records and clicks nothing', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: DRY_ENV });
    react(w);
    const r = await w.engine.click(await armAndType(w));
    expect(r).toMatchObject({ ok: true, status: 'dry_run' });
    expect(clicks(w)).toEqual([]);
    expect(listDryRun(w.db).map((x) => x.action)).toContain('wellfound_send');
    expect(ceiling(w, 'wellfound_message')).toBe(0);
  });

  it('an unconfirmed click is reported, never retried, and the third failure halts wellfound', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    w.page.responseOk = false;
    w.page.onAct = (what) => {
      const f = /^fill \d+ ([\s\S]*)$/.exec(what);
      if (f) w.page.setHtml(threadHtml({ text: f[1] }));
    };
    const r = await w.engine.click(await armAndType(w));
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed' });
    expect(touches(w)).toEqual([{ status: 'unconfirmed', kind: 'role_ask' }]);
    expect(haltReason(w.db, 'wellfound')).toBeNull();
    bumpFailures(w.db, null, NOW);
    for (let i = 0; i < FAILURE_LIMIT; i++) bumpFailures(w.db, null, NOW);
    expect(haltReason(w.db, 'wellfound')).toContain('consecutive wellfound send failures');
    expect(haltReason(w.db, 'naukri')).toBeNull();
  });

  it('a wrong header at commit time (page changed to another person) refuses', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    w.page.setHtml(threadHtml({ name: 'Mallory Other', text: MSG }));
    expect((await w.engine.click(send)).ok).toBe(false);
    expect(clicks(w)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
/** The apply flow on the fake page: Apply opens the form, typing fills the note, Submit shows the confirmation. */
function applyFlow(w: WfWorld, opts: { confirm?: string; noForm?: boolean } = {}): { stage: () => number } {
  let stage = 0;
  w.page.onAct = (what) => {
    const f = /^fill \d+ ([\s\S]*)$/.exec(what);
    if (f) { w.page.setHtml(jobHtml({ form: true, note: f[1] })); return; }
    if (!what.startsWith('click')) return;
    stage++;
    if (stage === 1) w.page.setHtml(opts.noForm ? jobHtml({ applied: true }) : jobHtml({ form: true }));
    else w.page.setHtml(jobHtml({ confirm: opts.confirm ?? 'Application sent', applied: true }));
  };
  return { stage: () => stage };
}

describe('armWellfoundApply: refusals', () => {
  it('arms a live apply on the stored job page and spends nothing yet', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect(await w.armApply()).toMatchObject({ status: 'armed', class: 'wellfound_apply', dry_run: false });
    expect(ceiling(w, 'wellfound_apply')).toBe(0);
    expect(w.page.log).toContain(`goto ${JOB_URL}`);
    expect(w.intents.peek('wellfound')).toMatchObject({ class: 'wellfound_apply', pageKey: JOB_ID, text: null });
  });

  it('refuses a bad id, an unknown job, a vetoed job, an applied job and a hard stop before any browser use', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await w.armApply({ job_id: 'bad id!' })).code).toBe('bad_job_id');
    expect((await w.armApply({ job_id: 'wellfound:999999' })).code).toBe('unknown_job');
    w.db.prepare('UPDATE jobs SET excluded_reason = ? WHERE id = ?').run('test veto', JOB_ID);
    expect((await w.armApply()).code).toBe('vetoed');
    w.db.prepare('UPDATE jobs SET excluded_reason = NULL WHERE id = ?').run(JOB_ID);
    saveApplication(w.db, { job_id: JOB_ID, platform: 'wellfound', method: 'native', account: 'wellfound', status: 'submitted', reason: null, applied_at: NOW.toISOString() });
    expect((await w.armApply()).code).toBe('already_applied');
    expect(w.page.log).toEqual([]);
  });

  it('a job whose apply url is not on wellfound.com is class_none', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    saveJob(w.db, { id: 'hn:1', source: 'weworkremotely', title: 'T', company: 'C', url: 'https://wellfound.com/jobs/777777-x', apply_url: 'https://wellfound.com/jobs/777777-x', description: 'd' });
    expect((await w.armApply({ job_id: 'hn:1' })).code).toBe('class_none');
    saveJob(w.db, { id: 'other:1', source: 'wellfound', title: 'T', company: 'C', url: 'https://boards.greenhouse.io/a/jobs/1', apply_url: 'https://boards.greenhouse.io/a/jobs/1', description: 'd' });
    expect((await w.armApply({ job_id: 'other:1' })).code).toBe('class_none');
  });

  it('a spent wellfound_apply ceiling or the shared daily cap refuses at arm', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    for (let i = 0; i < loadOutreachConfig({}).wellfoundMaxAppliesPerDay; i++) recordEvent(w.db, 'wellfound_apply', NOW);
    expect((await w.armApply()).status).toBe('rate_limited');
    const c = mk({ html: jobHtml(), url: JOB_URL, env: { ...LIVE_ENV, MAX_APPLIES_PER_DAY: '1' } });
    c.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'easy_apply', 1)").run();
    expect((await c.armApply()).code).toBe('rate_limited');
  });

  it('halted by wellfound, killed by STOP', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    haltPlatform(w.db, 'wellfound', 'x', NOW);
    expect((await w.armApply()).status).toBe('halted');
    const k = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    writeFileSync(k.stopFile, 'stop\n');
    expect(await k.armApply()).toMatchObject({ status: 'halted', code: 'killed' });
  });

  it('the page is a different job: refused', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    w.page.onAct = (what) => { if (what.startsWith('goto')) w.page.currentUrl = 'https://wellfound.com/jobs/111111-other'; };
    expect((await w.armApply()).code).toBe('job_url_mismatch');
    expect(w.intents.peek('wellfound')).toBeNull();
  });

  it('page screen: injection refuses, an unavailable classifier fails closed', async () => {
    const inj = mk({
      html: jobHtml(), url: JOB_URL, env: LIVE_ENV,
      screen: async (t, p) => (p === 'send' ? { blocked: true, unscreened: false, text: '', flags: [], code: 'injection_suspected' } : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }),
    });
    expect((await inj.armApply()).code).toBe('injection_suspected');
    const down = mk({
      html: jobHtml(), url: JOB_URL, env: LIVE_ENV,
      screen: async (t, p) => (p === 'send' ? { blocked: true, unscreened: false, text: '', flags: [], code: 'classifier_unavailable' } : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }),
    });
    expect(await down.armApply()).toMatchObject({ status: 'failed', code: 'classifier_unavailable' });
  });

  it('dry run arms a dry intent and records', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: DRY_ENV });
    expect(await w.armApply()).toMatchObject({ status: 'armed', dry_run: true });
    expect(listDryRun(w.db).map((x) => x.action)).toContain('wellfound_arm_apply');
  });
});

describe('armWellfoundApply: the optional note passes every outbound gate', () => {
  it('arms with a gated note and stores exactly the normalised text', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV, checkText: async (t) => ({ ok: true, normalized: `${t.trim()}`, verdict: 'pass' }) });
    expect(await w.armApply({ job_id: JOB_ID, note: `  ${NOTE}  ` })).toMatchObject({ status: 'armed', would: { note_chars: NOTE.length } });
    expect(w.intents.peek('wellfound')?.text).toBe(NOTE);
  });

  it('style, fact, output gate, length and classifier refuse the note before any page load', async () => {
    const style = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV, style: () => ({ ok: false, hits: ['banned'] }) });
    expect((await style.armApply({ job_id: JOB_ID, note: NOTE })).code).toBe('style_gate');
    const fact = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV, checkText: async (t) => ({ ok: false, normalized: t, verdict: 'block' }) });
    expect((await fact.armApply({ job_id: JOB_ID, note: NOTE })).code).toBe('fact_gate_block');
    const out = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await out.armApply({ job_id: JOB_ID, note: 'See https://evil.example for details' })).code).toBe('output_gate');
    expect((await out.armApply({ job_id: JOB_ID, note: 'x'.repeat(601) })).code).toBe('note_too_long');
    const blocked = mk({
      html: jobHtml(), url: JOB_URL, env: LIVE_ENV,
      screen: async (t, p) => (p === 'send' && t === NOTE ? { blocked: true, unscreened: false, text: '', flags: [], code: 'injection_suspected' } : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }),
    });
    expect((await blocked.armApply({ job_id: JOB_ID, note: NOTE })).code).toBe('note_screen_blocked');
    const down = mk({
      html: jobHtml(), url: JOB_URL, env: LIVE_ENV,
      screen: async (t, p) => (p === 'send' && t === NOTE ? { blocked: true, unscreened: false, text: '', flags: [], code: 'classifier_unavailable' } : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }),
    });
    expect(await down.armApply({ job_id: JOB_ID, note: NOTE })).toMatchObject({ status: 'failed', code: 'classifier_unavailable' });
    for (const w of [style, fact, out, blocked, down]) {
      expect(w.page.log).toEqual([]);
      expect(w.intents.peek('wellfound')).toBeNull();
    }
  });
});

describe('wellfound_apply commit path', () => {
  it('without an intent nothing is clicked', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Apply'))).toMatchObject({ ok: false, code: 'no_armed_intent' });
    expect(clicks(w)).toEqual([]);
  });

  it('applies with a note: Apply spends both counters once, the exact note is typed, Submit application confirms and records once', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    applyFlow(w);
    expect((await w.armApply({ job_id: JOB_ID, note: NOTE })).status).toBe('armed');
    const opened = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(opened).toMatchObject({ ok: true, code: 'form_opened' });
    expect(ceiling(w, 'wellfound_apply')).toBe(1);
    expect(w.db.prepare("SELECT count FROM daily_counters WHERE key = 'easy_apply'").get()).toMatchObject({ count: 1 });
    let s = await w.snap();
    const box = refOf(s, 'textbox', 'Write a note to the team');
    expect((await w.engine.type(box, 'a different pitch')).code).toBe('intent_text_mismatch');
    expect((await w.engine.type(box, NOTE)).ok).toBe(true);
    s = await w.snap();
    const done = await w.engine.click(refOf(s, 'button', 'Submit application'));
    expect(done).toMatchObject({ ok: true, status: 'sent', code: 'applied' });
    expect(applications(w)).toEqual([{ job_id: JOB_ID, platform: 'wellfound', method: 'native', status: 'submitted' }]);
    expect(ceiling(w, 'wellfound_apply')).toBe(1);
    expect(w.intents.peek('wellfound')).toBeNull();
  });

  it('applies without a note: nothing may be typed, Submit with an empty field is fine', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    applyFlow(w);
    expect((await w.armApply()).status).toBe('armed');
    await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    const s = await w.snap();
    const box = refOf(s, 'textbox', 'Write a note to the team');
    expect((await w.engine.type(box, NOTE)).code).toBe('text_not_allowed');
    expect(w.page.log.filter((l) => l.startsWith('fill'))).toEqual([]);
    expect(await w.engine.click(refOf(s, 'button', 'Submit application'))).toMatchObject({ status: 'sent', code: 'applied' });
    expect(applications(w)).toHaveLength(1);
  });

  it('a note field changed behind the armed note blocks the Submit click', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    applyFlow(w);
    await w.armApply({ job_id: JOB_ID, note: NOTE });
    await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    w.page.setHtml(jobHtml({ form: true, note: 'sneaked in text' }));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Submit application'));
    expect(r).toMatchObject({ ok: false, code: 'intent_text_mismatch' });
    expect(clicks(w)).toHaveLength(1);
    expect(applications(w)).toEqual([]);
  });

  it('Submit application before the counted Apply click is refused', async () => {
    const w = mk({ html: jobHtml({ form: true }), url: JOB_URL, env: LIVE_ENV });
    await w.armApply();
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Submit application'));
    expect(r).toMatchObject({ ok: false, code: 'apply_not_started' });
    expect(clicks(w)).toEqual([]);
    expect(ceiling(w, 'wellfound_apply')).toBe(0);
  });

  it('an apply that needs no form is confirmed straight after the Apply click', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    applyFlow(w, { noForm: true });
    await w.armApply();
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(jobHtml({ confirm: 'Application sent', applied: true })); };
    expect(await w.engine.click(refOf(await w.snap(), 'button', 'Apply'))).toMatchObject({ ok: true, status: 'sent', code: 'applied' });
    expect(applications(w)).toHaveLength(1);
  });

  it('no confirmation and no form after the click is unconfirmed: counters stay spent, never retried', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    await w.armApply();
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed', code: 'unconfirmed' });
    expect(ceiling(w, 'wellfound_apply')).toBe(1);
    expect(applications(w)).toEqual([]);
    expect(w.intents.peek('wellfound')).toBeNull();
  });

  it('a job description that already says "applied to ..." never confirms itself', async () => {
    const w = mk({ html: jobHtml({ body: 'Application sent to 400 people. Applied to by many.' }), url: JOB_URL, env: LIVE_ENV });
    await w.armApply();
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(r.status).toBe('unconfirmed');
    expect(applications(w)).toEqual([]);
  });

  it('the wellfound_apply ceiling at commit time refuses before the click and leaves both counters unspent', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    await w.armApply();
    const apply = refOf(await w.snap(), 'button', 'Apply');
    for (let i = 0; i < 20; i++) recordEvent(w.db, 'wellfound_apply', NOW);
    expect(await w.engine.click(apply)).toMatchObject({ ok: false, status: 'rate_limited' });
    expect(clicks(w)).toEqual([]);
    expect(w.db.prepare("SELECT count FROM daily_counters WHERE key = 'easy_apply'").get()).toBeUndefined();
  });

  it('the shared daily cap at commit time rolls the wellfound_apply event back', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: { ...LIVE_ENV, MAX_APPLIES_PER_DAY: '1' } });
    await w.armApply();
    const apply = refOf(await w.snap(), 'button', 'Apply');
    w.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'easy_apply', 1)").run();
    expect(await w.engine.click(apply)).toMatchObject({ ok: false, status: 'rate_limited' });
    expect(clicks(w)).toEqual([]);
    expect(ceiling(w, 'wellfound_apply')).toBe(0);
  });

  it('a veto that lands after arming blocks the click', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    await w.armApply();
    const apply = refOf(await w.snap(), 'button', 'Apply');
    w.db.prepare('UPDATE jobs SET excluded_reason = ? WHERE id = ?').run('late veto', JOB_ID);
    expect(await w.engine.click(apply)).toMatchObject({ ok: false, code: 'vetoed' });
    expect(clicks(w)).toEqual([]);
  });

  it('a different job page than the armed one blocks the click', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    await w.armApply();
    const apply = refOf(await w.snap(), 'button', 'Apply');
    w.page.currentUrl = 'https://wellfound.com/jobs/111111-other';
    expect(await w.engine.click(apply)).toMatchObject({ ok: false, code: 'job_mismatch' });
    expect(clicks(w)).toEqual([]);
  });

  it('dry run: the Apply click records and clicks nothing, no counter is spent', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: DRY_ENV });
    await w.armApply({ job_id: JOB_ID, note: NOTE });
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(r).toMatchObject({ ok: true, status: 'dry_run' });
    expect(clicks(w)).toEqual([]);
    expect(ceiling(w, 'wellfound_apply')).toBe(0);
    expect(listDryRun(w.db).map((x) => x.action)).toContain('wellfound_apply');
  });

  it('a wellfound intent never lets a naukri-class control through, and a stale intent expires', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    await w.armApply();
    const apply = refOf(await w.snap(), 'button', 'Apply');
    w.clock.t += 121_000;
    expect(await w.engine.click(apply)).toMatchObject({ ok: false, code: 'no_armed_intent' });
    expect(clicks(w)).toEqual([]);
  });
});
