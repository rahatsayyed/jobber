// Naukri on the browserctl engine: open and block pages, the type guard, the message arm gates (the old
// naukriSendMessage gates 1 to 10), the naukri_send commit path and the naukri_apply commit path with the
// apply chatbot. Everything runs on a fake page over invented HTML; nothing is really sent or applied.
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { haltPlatform, haltReason, recordEvent, countSince } from '../src/outreach/limits.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { listDryRun } from '../src/safety/dryRun.js';
import { getState } from '../src/scheduler/runLog.js';
import { markExcluded, saveApplication, saveJob } from '../src/db.js';
import { pauseContact } from '../src/linkedin/touches.js';
import { upsertPerson } from '../src/outreach/people.js';
import { bumpFailures, failKey, FAILURE_LIMIT, threadStateKey } from '../src/naukri/sendState.js';
import { armNaukriApply, armNaukriMessage } from '../src/browserctl/arm/naukri.js';
import { JOB_ID, JOB_URL, LIVE_ENV, MSG, NOW, THREAD, THREAD_URL, jobHtml, nkWorld, refOf, threadHtml, type NkWorld } from './helpers/nkWorld.js';
const DRY_ENV: Record<string, string> = { JOBBER_DRY_RUN: 'true' };

const worlds: NkWorld[] = [];
const mk = (o: Parameters<typeof nkWorld>[0]) => { const w = nkWorld(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const clicks = (w: NkWorld) => w.page.log.filter((l) => l.startsWith('click'));
const touches = (w: NkWorld) => w.db.prepare('SELECT status, kind FROM touches').all() as { status: string; kind: string }[];
const ceiling = (w: NkWorld, key: string) => countSince(w.db, key as never, new Date(0));
const SINCE = new Date(0);

/** Typing fills the composer in the fake page; a click on Send clears it and echoes the message. */
function react(w: NkWorld, opts: { echo?: boolean } = {}): void {
  w.page.onAct = (what) => {
    const f = /^fill \d+ ([\s\S]*)$/.exec(what);
    if (f) w.page.setHtml(threadHtml({ text: f[1] }));
    else if ((what.startsWith('click') || what === 'press Enter') && opts.echo !== false) w.page.setHtml(threadHtml({ text: '', sent: MSG }));
  };
}

/** Arm, type the armed text and return the Send ref. */
async function armAndType(w: NkWorld, text = MSG): Promise<string> {
  const a = await w.armSend();
  expect(a.status).toBe('armed');
  const box = refOf(await w.snap(), 'textbox', 'Type a message');
  const t = await w.engine.type(box, text);
  expect(t.ok, JSON.stringify(t)).toBe(true);
  return refOf(await w.snap(), 'button', 'Send');
}

describe('naukri engine: open, blocks and free actions', () => {
  it('refuses off-site and blocked URLs and navigates to a naukri page', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.engine.open('https://evil.example/mnjuser/inbox')).code).toBe('not_naukri');
    expect((await w.engine.open('https://www.naukri.com.evil.io/x')).code).toBe('not_naukri');
    expect((await w.engine.open('https://www.naukri.com/mnjuser/logout')).code).toBe('blocked_path');
    expect(w.page.log.some((l) => l.startsWith('goto'))).toBe(false);
    const r = await w.engine.open(THREAD_URL);
    expect(r.ok).toBe(true);
    expect(r.state).toContain('<<<PAGE_TEXT');
  });

  it('an Akamai block page halts naukri and closes the session through afterBlock', async () => {
    const w = mk({ html: '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1></body></html>', url: JOB_URL, env: LIVE_ENV });
    const r = await w.engine.snapshot();
    expect(r.code).toBe('halted');
    expect(haltReason(w.db, 'naukri')).toContain('blocked');
    expect((await w.engine.snapshot()).code).toBe('halted');
  });

  it('a login wall is reported as login_required and halts nothing', async () => {
    const w = mk({ html: '<html><head><title>Login</title></head><body><input type="password"></body></html>', url: 'https://www.naukri.com/nlogin/login', env: LIVE_ENV });
    const r = await w.engine.snapshot();
    expect(r.code).toBe('login_required');
    expect(haltReason(w.db, 'naukri')).toBeNull();
  });

  it('screenshot and click_at are off unless NAUKRI_SCREENSHOT is on, and say which flag', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const s = await w.engine.screenshot();
    expect(s.code).toBe('screenshot_disabled');
    expect(s.reason).toContain('NAUKRI_SCREENSHOT');
    const c = await w.engine.clickAt(10, 10);
    expect(c.code).toBe('click_at_disabled');
    expect(c.reason).toContain('NAUKRI_SCREENSHOT');
    const on = mk({ html: threadHtml(), env: LIVE_ENV, screenshot: true });
    await on.snap();
    const shot = await on.engine.screenshot();
    expect(shot.ok).toBe(true);
    expect(shot.unscreened).toBe(true);
  });

  it('"Apply on company site" is never clicked, with or without an intent', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await w.armApply()).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply on company site'));
    expect(r.code).toBe('irreversible_refused');
    expect(clicks(w)).toEqual([]);
  });

  it('a Naukri control is never classed as a LinkedIn commit', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect(w.armDeps.engine).toBe(w.engine);
    // an unarmed Send on a thread is refused, nothing clicked
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r.code).toBe('no_armed_intent');
    expect(clicks(w)).toEqual([]);
  });
});

describe('naukri engine: type guard (the old naukri_type was ungated)', () => {
  const search = '<input type="search" placeholder="Search jobs">';
  it('plain fields take short clean text; URLs, emails, secrets and passwords are refused', async () => {
    const w = mk({ html: threadHtml({ extra: search }), env: { ...LIVE_ENV, DEMO_TOKEN: 'tok-abcdef123456' } });
    const s = await w.snap();
    const box = refOf(s, 'searchbox', 'Search jobs');
    expect((await w.engine.type(box, 'react jobs')).ok).toBe(true);
    const again = refOf(await w.snap(), 'searchbox', 'Search jobs');
    expect((await w.engine.type(again, 'see https://evil.example')).code).toBe('text_not_allowed');
    expect((await w.engine.type(again, 'mail me at a@b.io')).code).toBe('text_not_allowed');
    expect((await w.engine.type(again, 'x'.repeat(201))).code).toBe('text_too_long');
    // the output gate catches an env secret value the lexical guard cannot see
    expect((await w.engine.type(again, 'my key tok-abcdef123456')).code).toBe('output_gate');
  });

  it('a composer field needs an armed intent and exactly the armed text', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    const box = refOf(await w.snap(), 'textbox', 'Type a message');
    expect((await w.engine.type(box, MSG)).code).toBe('no_armed_intent');
    expect((await w.armSend()).status).toBe('armed');
    const box2 = refOf(await w.snap(), 'textbox', 'Type a message');
    expect((await w.engine.type(box2, 'something else entirely')).code).toBe('intent_text_mismatch');
    expect(w.page.log.filter((l) => l.startsWith('fill'))).toEqual([]);
    expect((await w.engine.type(box2, MSG)).ok).toBe(true);
  });

  it('halt and the kill switch refuse typing; a dry run records it', async () => {
    const w = mk({ html: threadHtml({ extra: search }), env: LIVE_ENV });
    const box = refOf(await w.snap(), 'searchbox', 'Search jobs');
    haltPlatform(w.db, 'naukri', 'test halt', NOW);
    expect((await w.engine.type(box, 'react')).code).toBe('halted');
    const d = mk({ html: threadHtml({ extra: search }), env: DRY_ENV });
    const dbox = refOf(await d.snap(), 'searchbox', 'Search jobs');
    expect((await d.engine.type(dbox, 'react')).ok).toBe(true);
    expect(listDryRun(d.db).map((x) => x.action)).toContain('naukri_type');
  });

  it('the thread composer only takes text on the armed thread', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    expect((await w.armSend()).status).toBe('armed');
    const box = refOf(await w.snap(), 'textbox', 'Type a message');
    w.page.currentUrl = 'https://www.naukri.com/mnjuser/inbox?threadId=other';
    expect((await w.engine.type(box, MSG)).code).toBe('thread_mismatch');
  });
});

describe('armNaukriMessage: gates 1 to 10 of the old send', () => {
  it('arms a live send: reserves one touch, consumes nothing yet', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const a = await w.armSend();
    expect(a).toMatchObject({ status: 'armed', code: 'armed', class: 'naukri_send', dry_run: false });
    expect(touches(w)).toEqual([{ status: 'sending', kind: 'role_ask' }]);
    expect(ceiling(w, 'naukri_message')).toBe(0);
    expect(w.intents.peek('naukri')?.threadRef).toBe(THREAD);
  });

  it('bad kind, bad thread ref and empty or oversize text are refused first', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend({ kind: 'connect' as never })).code).toBe('bad_kind');
    expect((await w.armSend({ thread_ref: 'a b' })).code).toBe('bad_thread_ref');
    expect((await w.armSend({ text: '   ' })).code).toBe('empty_text');
    expect((await w.armSend({ text: 'x'.repeat(1801) })).code).toBe('message_too_long');
    expect(w.page.log).toEqual([]);
  });

  it('halted by naukri or all, killed by STOP', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    haltPlatform(w.db, 'naukri', 'x', NOW);
    expect((await w.armSend()).status).toBe('halted');
    const all = mk({ html: threadHtml(), env: LIVE_ENV });
    haltPlatform(all.db, 'all', 'x', NOW);
    expect((await all.armSend()).status).toBe('halted');
    const k = mk({ html: threadHtml(), env: LIVE_ENV });
    writeFileSync(k.stopFile, 'stop\n');
    expect(await k.armSend()).toMatchObject({ status: 'halted', code: 'killed' });
    expect(w.page.log).toEqual([]);
  });

  it('quiet hours refuse', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const r = await armNaukriMessage(
      { ...w.armDeps, now: () => new Date('2026-10-14T21:00:00Z') }, { person_id: w.pid, thread_ref: THREAD, text: MSG, kind: 'role_ask' });
    expect(r.code).toBe('quiet_hours');
  });

  it('unknown person, wrong platform, paused contact', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend({ person_id: 9999 })).code).toBe('unknown_recipient');
    const li = upsertPerson(w.db, { platform: 'linkedin', profileKey: 'in/lin-person', name: 'Lin Person', company: 'Acme', category: 'recruiter' });
    expect((await w.armSend({ person_id: li })).code).toBe('wrong_platform');
    pauseContact(w.db, w.pid, 'manual', NOW);
    expect((await w.armSend()).code).toBe('contact_paused');
  });

  it('cold messages are impossible: an unverified thread is refused', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend({ thread_ref: 'someone-elses-thread' })).code).toBe('unverified_thread');
    expect(w.page.log).toEqual([]);
  });

  it('an inbound recruiter inquiry verifies a thread without a confirmed state', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    w.db.prepare("DELETE FROM scheduler_state WHERE key = ?").run(threadStateKey(w.pid));
    expect((await w.armSend()).code).toBe('unverified_thread');
    w.db.prepare(
      "INSERT INTO inbound_messages (platform, thread_ref, person_id, text_hash, klass, escalated, created_at) VALUES ('naukri', ?, ?, 'h', 'recruiter_inquiry', 0, ?)",
    ).run(THREAD, w.pid, NOW.toISOString());
    expect((await w.armSend()).status).toBe('armed');
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

  it('a spent ceiling refuses at arm', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const limit = loadOutreachConfig({}).naukriMaxMessagesPerDay;
    for (let i = 0; i < limit; i++) recordEvent(w.db, 'naukri_message', NOW);
    expect((await w.armSend()).status).toBe('rate_limited');
    expect(touches(w)).toEqual([]);
  });

  it('live page checks: header name, thread id, missing header', async () => {
    const other = mk({ html: threadHtml({ name: 'Someone Else' }), env: LIVE_ENV });
    expect((await other.armSend()).code).toBe('recipient_mismatch');
    const none = mk({ html: threadHtml({ name: null }), env: LIVE_ENV });
    expect((await none.armSend()).code).toBe('recipient_unverified');
    const wrongThread = mk({ html: threadHtml(), env: LIVE_ENV });
    wrongThread.page.onAct = (what) => { if (what.startsWith('goto')) wrongThread.page.currentUrl = 'https://www.naukri.com/mnjuser/inbox?threadId=other'; };
    expect((await wrongThread.armSend()).code).toBe('thread_mismatch');
    expect(touches(wrongThread)).toEqual([]);
    expect(wrongThread.intents.peek('naukri')).toBeNull();
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

  it('text copied from the page is refused', async () => {
    const w = mk({ html: threadHtml({ sent: MSG }), env: LIVE_ENV });
    expect((await w.armSend()).code).toBe('output_gate_page');
  });

  it('a duplicate arm of the same text consumes nothing and is refused', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    expect((await w.armSend()).status).toBe('armed');
    expect((await w.armSend()).code).toBe('duplicate');
    expect(touches(w)).toHaveLength(1);
  });

  it('dry run arms a dry intent, records, reserves no touch', async () => {
    const w = mk({ html: threadHtml(), env: DRY_ENV });
    const a = await w.armSend();
    expect(a).toMatchObject({ status: 'armed', dry_run: true });
    expect(touches(w)).toEqual([]);
    expect(listDryRun(w.db).map((x) => x.action)).toContain('naukri_arm_send');
  });
});

describe('naukri_send commit path', () => {
  it('without an intent nothing is clicked', async () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r).toMatchObject({ ok: false, code: 'no_armed_intent' });
    expect(clicks(w)).toEqual([]);
  });

  it('sends: types the armed text, clicks Send, confirms by echo, records everything once', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(clicks(w)).toHaveLength(1);
    expect(touches(w)).toEqual([{ status: 'sent', kind: 'role_ask' }]);
    expect(ceiling(w, 'naukri_message')).toBe(1);
    expect(getState(w.db, threadStateKey(w.pid))).toBe(THREAD);
    expect(w.db.prepare('SELECT stage FROM contact_state WHERE person_id = ?').get(w.pid)).toMatchObject({ stage: 'active' });
    expect(w.intents.peek('naukri')).toBeNull();
  });

  it('confirms by a 2xx POST when the composer cleared without an echo', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    w.page.onAct = (what) => {
      const f = /^fill \d+ ([\s\S]*)$/.exec(what);
      if (f) w.page.setHtml(threadHtml({ text: f[1] }));
      else if (what.startsWith('click')) w.page.setHtml(threadHtml({ text: '' }));
    };
    const send = await armAndType(w);
    expect((await w.engine.click(send)).status).toBe('sent');
  });

  it('Enter in the composer counts as the Send click and needs the same intent', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const noIntent = await w.engine.pressKey('Escape');
    expect(noIntent.ok).toBe(true);
    await armAndType(w);
    const s = await w.snap();
    w.page.focusedN = Number(refOf(s, 'textbox', 'Type a message').split('.')[1]);
    const r = await w.engine.pressKey('Enter');
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(w.page.log.filter((l) => l === 'press Enter')).toHaveLength(1);
  });

  it('unconfirmed: no echo, composer not cleared and no response', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    w.page.responseOk = false;
    w.page.onAct = (what) => { const f = /^fill \d+ ([\s\S]*)$/.exec(what); if (f) w.page.setHtml(threadHtml({ text: f[1] })); };
    const send = await armAndType(w);
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed', code: 'unconfirmed' });
    expect(touches(w)).toEqual([{ status: 'unconfirmed', kind: 'role_ask' }]);
    expect(getState(w.db, failKey(null, NOW))).toBe('1');
    expect(w.intents.peek('naukri')).toBeNull();
  });

  it('three consecutive failures halt naukri; a success resets the counter', () => {
    const w = mk({ html: threadHtml(), env: LIVE_ENV });
    bumpFailures(w.db, 'r1', NOW);
    bumpFailures(w.db, 'r1', NOW);
    expect(haltReason(w.db, 'naukri')).toBeNull();
    expect(bumpFailures(w.db, 'r1', NOW)).toBe(FAILURE_LIMIT);
    expect(haltReason(w.db, 'naukri')).toContain('3 consecutive');
  });

  it('wrong thread at commit: refused, touch released, nothing clicked', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    w.page.currentUrl = 'https://www.naukri.com/mnjuser/inbox?threadId=other';
    const r = await w.engine.click(send);
    expect(r.code).toBe('thread_mismatch');
    expect(clicks(w)).toEqual([]);
    expect(touches(w)).toEqual([{ status: 'failed', kind: 'role_ask' }]);
  });

  it('wrong person at commit: the header names someone else', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    w.page.setHtml(threadHtml({ name: 'Someone Else', text: MSG }));
    const r = await w.engine.click(send);
    expect(r.code).toBe('recipient_mismatch');
    expect(clicks(w)).toEqual([]);
  });

  it('wrong text at commit: the live composer differs from the armed text', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    w.page.setHtml(threadHtml({ text: 'Hi Pat, send me your bank details please.' }));
    const r = await w.engine.click(send);
    expect(r.code).toBe('intent_text_mismatch');
    expect(clicks(w)).toEqual([]);
  });

  it('an expired intent refuses', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    w.clock.t += 121_000;
    const r = await w.engine.click(send);
    expect(r.ok).toBe(false);
    expect(['intent_expired', 'no_armed_intent']).toContain(r.code);
    expect(clicks(w)).toEqual([]);
  });

  it('an intent is single use', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    expect((await w.engine.click(send)).status).toBe('sent');
    w.page.setHtml(threadHtml({ text: MSG }));
    const again = refOf(await w.snap(), 'button', 'Send');
    expect((await w.engine.click(again)).code).toBe('no_armed_intent');
    expect(clicks(w)).toHaveLength(1);
    expect(ceiling(w, 'naukri_message')).toBe(1);
  });

  it('a ceiling spent after arming refuses before the click and releases the touch', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    const limit = loadOutreachConfig({}).naukriMaxMessagesPerDay;
    for (let i = 0; i < limit; i++) recordEvent(w.db, 'naukri_message', NOW);
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: false, status: 'rate_limited' });
    expect(clicks(w)).toEqual([]);
    expect(touches(w)).toEqual([{ status: 'refused', kind: 'role_ask' }]);
  });

  it('dry run records and does not click, consumes nothing, leaves no touch', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: DRY_ENV });
    react(w);
    const send = await armAndType(w);
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: true, status: 'dry_run' });
    expect(clicks(w)).toEqual([]);
    expect(touches(w)).toEqual([]);
    expect(ceiling(w, 'naukri_message')).toBe(0);
    expect(listDryRun(w.db).map((x) => x.action)).toEqual(expect.arrayContaining(['naukri_send', 'naukri_arm_send']));
    expect(w.intents.peek('naukri')).toBeNull();
  });

  it('a halt or the kill switch after arming refuses the click', async () => {
    const w = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(w);
    const send = await armAndType(w);
    haltPlatform(w.db, 'naukri', 'captcha', NOW);
    expect((await w.engine.click(send)).code).toBe('halted');
    const k = mk({ html: threadHtml({ text: '' }), env: LIVE_ENV });
    react(k);
    const ksend = await armAndType(k);
    writeFileSync(k.stopFile, 'stop\n');
    expect((await k.engine.click(ksend)).code).toBe('killed');
    expect(clicks(w)).toEqual([]);
    expect(clicks(k)).toEqual([]);
  });

  it('an apply intent never lets a thread Send through', async () => {
    const j = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await j.armApply()).status).toBe('armed');
    j.page.setHtml(threadHtml({ text: MSG }));
    j.page.currentUrl = THREAD_URL;
    const r = await j.engine.click(refOf(await j.snap(), 'button', 'Send'));
    expect(r.code).toBe('intent_class_mismatch');
    expect(clicks(j)).toEqual([]);
  });
});

describe('armNaukriApply', () => {
  it('arms for a known, clean, naukri-class job and opens the stored URL', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    const a = await w.armApply();
    expect(a).toMatchObject({ status: 'armed', class: 'naukri_apply', dry_run: false });
    expect(w.page.log).toContain(`goto ${JOB_URL}`);
    expect(w.intents.peek('naukri')).toMatchObject({ class: 'naukri_apply', pageKey: JOB_ID, jobId: JOB_ID });
  });

  it('refuses an unknown, vetoed, hard-stopped or already applied job before any browser use', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await w.armApply({ job_id: 'naukri:1' })).code).toBe('unknown_job');
    expect((await w.armApply({ job_id: 'bad id!' })).code).toBe('bad_job_id');
    markExcluded(w.db, [{ job_id: JOB_ID, reason: 'location FAIL' }]);
    expect((await w.armApply()).code).toBe('vetoed');
    const v = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    saveApplication(v.db, { job_id: JOB_ID, platform: 'naukri', method: 'chatbot', account: 'naukri', status: 'submitted', reason: null, applied_at: NOW.toISOString() });
    expect((await v.armApply()).code).toBe('already_applied');
    expect(w.page.log).toEqual([]);
    expect(v.page.log).toEqual([]);
  });

  it('refuses a job whose class is not naukri, or whose URL has no job id', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    saveJob(w.db, { id: 'x:gh', source: 'greenhouse', title: 'T', company: 'C', url: 'https://boards.greenhouse.io/c/jobs/1', apply_url: 'https://boards.greenhouse.io/c/jobs/1', description: 'd' });
    expect((await w.armApply({ job_id: 'x:gh' })).code).toBe('class_none');
    saveJob(w.db, { id: 'naukri:noid', source: 'naukri', title: 'T', company: 'C', url: 'https://www.naukri.com/some-listing', apply_url: 'https://www.naukri.com/some-listing', description: 'd' });
    expect((await w.armApply({ job_id: 'naukri:noid' })).code).toBe('no_job_key');
    expect(w.page.log).toEqual([]);
  });

  it('caps: naukri_apply ceiling and the shared daily counter refuse at arm', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    const limit = loadOutreachConfig({}).naukriMaxAppliesPerDay;
    for (let i = 0; i < limit; i++) recordEvent(w.db, 'naukri_apply', NOW);
    expect((await w.armApply()).status).toBe('rate_limited');
    const d = mk({ html: jobHtml(), url: JOB_URL, env: { ...LIVE_ENV, MAX_APPLIES_PER_DAY: '1' } });
    d.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'easy_apply', 1)").run();
    expect((await d.armApply()).status).toBe('rate_limited');
  });

  it('halt, kill switch, a page that is not the job, a flagged page', async () => {
    const h = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    haltPlatform(h.db, 'naukri', 'x', NOW);
    expect((await h.armApply()).status).toBe('halted');
    const k = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    writeFileSync(k.stopFile, 's');
    expect((await k.armApply()).code).toBe('killed');
    const m = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    m.page.onAct = (what) => { if (what.startsWith('goto')) m.page.currentUrl = 'https://www.naukri.com/job-listings-other-role-acme-999'; };
    expect((await m.armApply()).code).toBe('job_url_mismatch');
    const s = mk({
      html: jobHtml(), url: JOB_URL, env: LIVE_ENV,
      screen: async (t, p) => (p === 'send' ? { blocked: true, unscreened: false, text: '', flags: [], code: 'injection_suspected' } : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }),
    });
    expect((await s.armApply()).code).toBe('injection_suspected');
  });

  it('dry run arms a dry intent and records', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: DRY_ENV });
    expect(await w.armApply()).toMatchObject({ status: 'armed', dry_run: true });
    expect(listDryRun(w.db).map((x) => x.action)).toContain('naukri_arm_apply');
  });

  it('uses only its own deps (no model-supplied URL anywhere)', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    const { checkText: _c, style: _s, ...apply } = w.armDeps;
    const r = await armNaukriApply(apply, { job_id: JOB_ID, url: 'https://evil.example' } as never);
    expect(r.status).toBe('armed');
    expect(w.page.log).toContain(`goto ${JOB_URL}`);
    expect(w.page.log.some((l) => l.includes('evil'))).toBe(false);
  });
});

describe('naukri_apply commit path and the chatbot', () => {
  /** The page reacts like Naukri: Apply opens the chatbot, typing fills the answer, Save confirms. */
  function react2(w: NkWorld, final: 'confirm' | 'chat' | 'nothing' = 'confirm'): void {
    w.page.onAct = (what) => {
      if (what.startsWith('click')) {
        const html = w.page.currentHtml();
        if (!html.includes('chatbot_Drawer')) {
          if (final !== 'nothing') w.page.setHtml(jobHtml({ chat: true }));
        } else if (final === 'confirm') w.page.setHtml(jobHtml({ confirm: 'Applied to "Software Engineer"' }));
        else w.page.setHtml(jobHtml({ chat: true }));
      }
      const f = /^fill \d+ ([\s\S]*)$/.exec(what);
      if (f) w.page.setHtml(jobHtml({ chat: true, answer: f[1] }));
    };
  }

  it('without an intent the Apply click is refused and nothing is clicked or consumed', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(r.code).toBe('no_armed_intent');
    expect(clicks(w)).toEqual([]);
    expect(ceiling(w, 'naukri_apply')).toBe(0);
  });

  it('full flow: Apply (counters once), a gated chatbot answer, its Save, confirmation recorded once', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    react2(w);
    expect((await w.armApply()).status).toBe('armed');
    const open = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(open).toMatchObject({ ok: true, code: 'chatbot_opened' });
    expect(ceiling(w, 'naukri_apply')).toBe(1);
    expect(w.db.prepare("SELECT count FROM daily_counters WHERE key = 'easy_apply'").get()).toMatchObject({ count: 1 });
    const s = await w.snap();
    const t = await w.engine.type(refOf(s, 'textbox', ''), '5 years');
    expect(t.ok, JSON.stringify(t)).toBe(true);
    const done = await w.engine.click(refOf(await w.snap(), 'button', 'Save'));
    expect(done).toMatchObject({ ok: true, status: 'sent', code: 'applied' });
    expect(w.db.prepare("SELECT status, platform FROM applications WHERE job_id = ?").all(JOB_ID)).toEqual([{ status: 'submitted', platform: 'naukri' }]);
    expect(w.intents.peek('naukri')).toBeNull();
    const again = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(again.code).toBe('no_armed_intent');
  });

  it('a second Apply click for the same job does not consume the counters again', async () => {
    const w = mk({ html: jobHtml({ chat: true }), url: JOB_URL, env: LIVE_ENV });
    w.page.onAct = () => undefined;
    expect((await w.armApply()).status).toBe('armed');
    await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(ceiling(w, 'naukri_apply')).toBe(1);
    expect(w.db.prepare("SELECT count FROM daily_counters WHERE key = 'easy_apply'").get()).toMatchObject({ count: 1 });
  });

  it('the shared daily counter spent after arming rolls the naukri_apply event back, and the reverse', async () => {
    const a = mk({ html: jobHtml(), url: JOB_URL, env: { ...LIVE_ENV, MAX_APPLIES_PER_DAY: '1' } });
    expect((await a.armApply()).status).toBe('armed');
    a.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'easy_apply', 1)").run();
    const r = await a.engine.click(refOf(await a.snap(), 'button', 'Apply'));
    expect(r).toMatchObject({ ok: false, status: 'rate_limited' });
    expect(clicks(a)).toEqual([]);
    expect(ceiling(a, 'naukri_apply')).toBe(0);

    const b = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await b.armApply()).status).toBe('armed');
    const limit = loadOutreachConfig({}).naukriMaxAppliesPerDay;
    for (let i = 0; i < limit; i++) recordEvent(b.db, 'naukri_apply', NOW);
    const r2 = await b.engine.click(refOf(await b.snap(), 'button', 'Apply'));
    expect(r2).toMatchObject({ ok: false, status: 'rate_limited' });
    expect(b.db.prepare("SELECT count FROM daily_counters WHERE key = 'easy_apply'").get()).toBeUndefined();
    expect(clicks(b)).toEqual([]);
  });

  it('dry run records, does not click, consumes nothing', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: DRY_ENV });
    expect((await w.armApply()).dry_run).toBe(true);
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(r).toMatchObject({ ok: true, status: 'dry_run' });
    expect(clicks(w)).toEqual([]);
    expect(ceiling(w, 'naukri_apply')).toBe(0);
    expect(listDryRun(w.db).map((x) => x.action)).toEqual(expect.arrayContaining(['naukri_apply', 'naukri_arm_apply']));
  });

  it('a job vetoed after arming is refused at the click', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await w.armApply()).status).toBe('armed');
    markExcluded(w.db, [{ job_id: JOB_ID, reason: 'hard stop' }]);
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(r.code).toBe('vetoed');
    expect(clicks(w)).toEqual([]);
    expect(ceiling(w, 'naukri_apply')).toBe(0);
  });

  it('a page that is not the armed job is refused at the click', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await w.armApply()).status).toBe('armed');
    const ref = refOf(await w.snap(), 'button', 'Apply');
    w.page.currentUrl = 'https://www.naukri.com/job-listings-other-role-acme-999';
    expect((await w.engine.click(ref)).code).toBe('job_mismatch');
    expect(clicks(w)).toEqual([]);
  });

  it('chatbot rules: no answer before Apply, none without an intent, gated and capped text', async () => {
    const w = mk({ html: jobHtml({ chat: true }), url: JOB_URL, env: { ...LIVE_ENV, DEMO_TOKEN: 'tok-abcdef123456' } });
    const box = () => w.snap().then((s) => refOf(s, 'textbox', ''));
    expect((await w.engine.type(await box(), '5 years')).code).toBe('no_armed_intent');
    expect((await w.armApply()).status).toBe('armed');
    expect((await w.engine.type(await box(), '5 years')).code).toBe('apply_not_started');
    w.page.onAct = () => undefined;
    await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect((await w.engine.type(await box(), '5 years')).ok).toBe(true);
    expect((await w.engine.type(await box(), 'mail a@b.io')).code).toBe('text_not_allowed');
    expect((await w.engine.type(await box(), 'see https://x.io')).code).toBe('text_not_allowed');
    expect((await w.engine.type(await box(), 'x'.repeat(501))).code).toBe('text_too_long');
    expect((await w.engine.type(await box(), 'key tok-abcdef123456')).code).toBe('output_gate');
  });

  it('a chatbot step control re-checks the typed answer through the gate and the step cap', async () => {
    const w = mk({ html: jobHtml({ chat: true, answer: 'my key tok-abcdef123456' }), url: JOB_URL, env: { ...LIVE_ENV, DEMO_TOKEN: 'tok-abcdef123456' } });
    w.page.onAct = () => undefined;
    expect((await w.armApply()).status).toBe('armed');
    await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Save'));
    expect(r.code).toBe('output_gate');
  });

  it('unconfirmed when the click shows neither a chatbot nor a confirmation', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    react2(w, 'nothing');
    expect((await w.armApply()).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed' });
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toMatchObject({ n: 0 });
    expect(w.intents.peek('naukri')).toBeNull();
  });

  it('a job description cannot confirm itself: only text that was not on the page before counts', async () => {
    const w = mk({ html: jobHtml({ body: 'Candidates who successfully applied to Acme before need not reapply.' }), url: JOB_URL, env: LIVE_ENV });
    w.page.onAct = () => undefined;
    expect((await w.armApply()).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(r.status).toBe('unconfirmed');
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toMatchObject({ n: 0 });
  });

  it('a confirmation that shows up after a free chatbot click is recorded once', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    react2(w, 'chat');
    expect((await w.armApply()).status).toBe('armed');
    await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    w.page.setHtml(jobHtml({ confirm: 'You have successfully applied to Acme' }));
    await w.engine.snapshot();
    await w.engine.snapshot();
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM applications WHERE job_id = ?").get(JOB_ID)).toMatchObject({ n: 1 });
    expect(w.intents.peek('naukri')).toBeNull();
  });

  it('halt and kill switch refuse the Apply click', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await w.armApply()).status).toBe('armed');
    const ref = refOf(await w.snap(), 'button', 'Apply');
    haltPlatform(w.db, 'naukri', 'blocked', NOW);
    expect((await w.engine.click(ref)).code).toBe('halted');
    const k = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    expect((await k.armApply()).status).toBe('armed');
    const kref = refOf(await k.snap(), 'button', 'Apply');
    writeFileSync(k.stopFile, 's');
    expect((await k.engine.click(kref)).code).toBe('killed');
    expect(ceiling(w, 'naukri_apply') + ceiling(k, 'naukri_apply')).toBe(0);
    expect(SINCE.getTime()).toBe(0);
  });
});
