// LinkedIn attachments and owner-approved replies: the code-owned file resolver, the arm tool (kinds reply / attachment), linkedin_attach_file,
// and a Send that is confirmed only when the page shows the text AND the file name. Fakes only: temp repo root, fake page, in-memory db.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ATTACH_MAX_BYTES, attachmentFileName, dmAttachAllowed, lexicallyAllowed, resolveJobResume,
} from '../src/linkedin/attachment.js';
import { answerFileChooser } from '../src/browserctl/fileChooser.js';
import { realBcPage } from '../src/browserctl/driver.js';
import { attachmentShown } from '../src/browserctl/commit.js';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { classify } from '../src/browserctl/guard.js';
import { addEscalation } from '../src/outreach/service.js';
import { approveReplyDraft, getReplyDraft, saveReplyDraft } from '../src/outreach/replyDrafts.js';
import { dueTouchesFor } from '../src/outreach/dueTouches.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { LIVE_ENV, MSG, NOW, URL_, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';

const NAME = 'Rahat-Sayyed-Resume.pdf';
const TEXT = 'Thanks for reaching out, Jane. My resume is attached. Happy to answer any questions about my work.';
const roots: string[] = [];
const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A temp repo root with renderer/automation/job1/resume.pdf (and resume.html). */
function repoRoot(o: { pdf?: boolean; bytes?: number } = {}): { root: string; pdf: string; html: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'li-attach-'));
  roots.push(root);
  const dir = path.join(root, 'renderer', 'automation', 'job1');
  mkdirSync(dir, { recursive: true });
  const pdf = path.join(dir, 'resume.pdf');
  const html = path.join(dir, 'resume.html');
  writeFileSync(html, '<html></html>');
  if (o.pdf !== false) writeFileSync(pdf, Buffer.alloc(o.bytes ?? 64, 1));
  return { root, pdf, html };
}

const overlay = (o: { name?: string; text?: string; chip?: boolean; bubble?: boolean; attachLabel?: string } = {}): string => `<div role="dialog" aria-label="Messaging" class="msg-overlay">
<h2>${o.name ?? 'Jane Example'}</h2>
${o.bubble ? `<p>${TEXT}</p><p>${NAME}</p>` : ''}
${o.chip ? `<p>${NAME}</p><button aria-label="Remove attachment ${NAME}">x</button>` : ''}
<button aria-label="${o.attachLabel ?? 'Attach a file to your conversation with Jane Example'}">Attach</button>
<textarea>${o.bubble ? '' : o.text ?? TEXT}</textarea>
<footer><button>Send</button></footer></div>`;

interface Setup { w: World; root: string; draftId: number; escalationId: number; personId: number }

/** A connected recipient with a tailored resume on file and an owner-approved reply draft (paused as `replied`, as an inbound reply leaves them). */
function mk(o: { env?: Record<string, string>; html?: string; approve?: boolean; attachResume?: boolean; resumePdf?: boolean; noJob?: boolean } = {}): Setup {
  const r = repoRoot({ pdf: o.resumePdf });
  const w = world({
    html: o.html ?? profileHtml({ status: 'connected', dialog: overlay() }), env: o.env ?? LIVE_ENV,
    attach: { root: r.root, resumeName: () => 'Rahat Sayyed' },
  });
  worlds.push(w);
  const person = (w.db.prepare('SELECT id FROM people').get() as { id: number }).id;
  if (!o.noJob) {
    w.db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('job1', 't', 'T', 'Acme', 'u')").run();
    w.db.prepare("INSERT INTO outreach_queue (job_id, resume_pdf_path) VALUES ('job1', ?)").run(path.relative(r.root, r.pdf));
    w.db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status, sent_at) VALUES (?, 'job1', 'connect', 'old0', 'sent', ?)").run(person, new Date(NOW.getTime() - 12 * 86400_000).toISOString());
    w.db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status, sent_at) VALUES (?, 'job1', 'role_ask', 'old', 'sent', ?)").run(person, new Date(NOW.getTime() - 5 * 86400_000).toISOString());
  }
  w.db.prepare("UPDATE contact_state SET stage = 'active', paused_reason = 'replied', cycle_started_at = ?, last_touch_at = ? WHERE person_id = ?")
    .run(new Date(NOW.getTime() - 14 * 86400_000).toISOString(), new Date(NOW.getTime() - 5 * 86400_000).toISOString(), person);
  const escalationId = addEscalation(w.db, { runId: null, platform: 'linkedin', personId: person, threadRef: '2-abc', reason: o.attachResume === false ? 'linkedin_reply_needed' : 'documents', detail: 'asks for the resume', excerpt: 'please send your cv' }, NOW);
  const saved = saveReplyDraft(w.db, { escalationId, text: TEXT }, {
    now: NOW, env: {}, styleCfg: DEFAULT_STYLE_CONFIG, cfg: { allowedUrls: [], allowedEmails: [] }, factCheck: (t) => ({ verdict: 'pass', normalized_text: t }),
  });
  if (!saved.ok) throw new Error(`draft not saved: ${saved.code}`);
  // A saved draft is auto-approved now; `approve: false` puts it back to drafted for the refusal cases.
  if (o.approve === false) w.db.prepare("UPDATE reply_drafts SET status = 'drafted', approved_at = NULL WHERE id = ?").run(saved.id);
  return { w, root: r.root, draftId: saved.id, escalationId, personId: person };
}

const reply = (s: Setup, extra: Record<string, unknown> = {}) => s.w.arm({ kind: 'reply', profile_url: URL_, reply_draft_id: s.draftId, ...extra } as never);

describe('attachmentFileName', () => {
  it('builds a generic ASCII name from resume.json name', () => {
    expect(attachmentFileName('Rahat Sayyed')).toBe(NAME);
    expect(attachmentFileName('Zoë  O\'Brien-Smith')).toBe('Zoe-O-Brien-Smith-Resume.pdf');
    expect(attachmentFileName('  ')).toBe('Resume.pdf');
    expect(attachmentFileName(null)).toBe('Resume.pdf');
    expect(attachmentFileName('../../etc/passwd')).toBe('etc-passwd-Resume.pdf');
  });
  it('first-DM attachment is off unless LINKEDIN_DM_ATTACH_RESUME is exactly true', () => {
    expect(dmAttachAllowed({})).toBe(false);
    expect(dmAttachAllowed({ LINKEDIN_DM_ATTACH_RESUME: 'yes' })).toBe(false);
    expect(dmAttachAllowed({ LINKEDIN_DM_ATTACH_RESUME: ' TRUE ' })).toBe(true);
  });
});

describe('resolveJobResume (code resolves the file)', () => {
  const db = (root: string, rel: string | null, opts: { pdfPath?: string } = {}) => {
    void root;
    const d = world({ html: '<html></html>' });
    worlds.push(d);
    const person = (d.db.prepare('SELECT id FROM people').get() as { id: number }).id;
    d.db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('job1', 't', 'T', 'Acme', 'u')").run();
    if (rel !== null) d.db.prepare("INSERT INTO outreach_queue (job_id, resume_pdf_path) VALUES ('job1', ?)").run(opts.pdfPath ?? rel);
    d.db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status) VALUES (?, 'job1', 'role_ask', 'k', 'sent')").run(person);
    return { d, person };
  };

  it('resolves the tailored resume of the latest job tied to the person', async () => {
    const r = repoRoot();
    const { d, person } = db(r.root, path.relative(r.root, r.pdf));
    const res = await resolveJobResume(d.db, person, { root: r.root, resumeName: () => 'Rahat Sayyed' });
    expect(res).toMatchObject({ ok: true, attachment: { name: NAME, bytes: 64, rendered: false } });
  });

  it('takes the newest job that has a resume on file', async () => {
    const r = repoRoot();
    const { d, person } = db(r.root, path.relative(r.root, r.pdf));
    d.db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('job2', 't', 'T2', 'Acme', 'u')").run();
    d.db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status) VALUES (?, 'job2', 'followup', 'k2', 'sent')").run(person);
    expect(await resolveJobResume(d.db, person, { root: r.root, resumeName: () => 'A B' })).toMatchObject({ ok: true });
  });

  it('re-renders a missing PDF from resume.html in the same folder', async () => {
    const r = repoRoot({ pdf: false });
    const { d, person } = db(r.root, path.relative(r.root, r.pdf));
    const calls: string[] = [];
    const res = await resolveJobResume(d.db, person, {
      root: r.root, resumeName: () => 'Rahat Sayyed',
      render: async (h, p) => { calls.push(`${path.relative(r.root, h)} -> ${path.relative(r.root, p)}`); writeFileSync(p, Buffer.alloc(10, 2)); },
    });
    expect(calls).toEqual(['renderer/automation/job1/resume.html -> renderer/automation/job1/resume.pdf']);
    expect(res).toMatchObject({ ok: true, attachment: { rendered: true, bytes: 10 } });
  });

  it('refuses a missing PDF with no resume.html, a failing re-render and a missing resume record', async () => {
    const r = repoRoot({ pdf: false });
    rmSync(r.html);
    const a = db(r.root, path.relative(r.root, r.pdf));
    expect(await resolveJobResume(a.d.db, a.person, { root: r.root })).toMatchObject({ ok: false, code: 'attachment_missing' });
    const r2 = repoRoot({ pdf: false });
    const b = db(r2.root, path.relative(r2.root, r2.pdf));
    expect(await resolveJobResume(b.d.db, b.person, { root: r2.root, render: async () => { throw new Error('chrome gone'); } })).toMatchObject({ ok: false, code: 'attachment_render_failed' });
    const c = db(r.root, null);
    expect(await resolveJobResume(c.d.db, c.person, { root: r.root })).toMatchObject({ ok: false, code: 'attachment_no_resume' });
  });

  it('refuses anything outside renderer/automation or not a .pdf, whatever the record says', async () => {
    const r = repoRoot();
    const outside = path.join(r.root, 'secrets.pdf');
    writeFileSync(outside, 'x');
    writeFileSync(path.join(r.root, 'renderer', 'notes.pdf'), 'x');
    writeFileSync(path.join(r.root, 'renderer', 'automation', 'job1', 'resume.txt'), 'x');
    for (const bad of ['secrets.pdf', '../../../etc/passwd.pdf', 'renderer/notes.pdf', 'renderer/automation/../notes.pdf', '/etc/hosts.pdf', 'renderer/automation/job1/resume.txt', 'renderer/automation', '']) {
      const { d, person } = db(r.root, 'x', { pdfPath: bad });
      const res = await resolveJobResume(d.db, person, { root: r.root });
      expect(res.ok, bad).toBe(false);
      worlds.pop()?.cleanup();
    }
    expect(lexicallyAllowed('renderer/automation/job1/resume.pdf', r.root)).toBe(true);
    expect(lexicallyAllowed('renderer/automation/job1/RESUME.PDF', r.root)).toBe(true);
    expect(lexicallyAllowed('renderer/automation/job1/resume.pdf\0.png', r.root)).toBe(false);
  });

  it('refuses a symlink that escapes the folder and a file over 2 MB', async () => {
    const r = repoRoot();
    const target = path.join(r.root, 'private.pdf');
    writeFileSync(target, 'secret');
    const link = path.join(r.root, 'renderer', 'automation', 'job1', 'link.pdf');
    symlinkSync(target, link);
    const a = db(r.root, path.relative(r.root, link));
    expect(await resolveJobResume(a.d.db, a.person, { root: r.root })).toMatchObject({ ok: false, code: 'attachment_outside_dir' });
    const big = repoRoot({ bytes: ATTACH_MAX_BYTES + 1 });
    const b = db(big.root, path.relative(big.root, big.pdf));
    expect(await resolveJobResume(b.d.db, b.person, { root: big.root })).toMatchObject({ ok: false, code: 'attachment_too_large' });
    const exact = repoRoot({ bytes: ATTACH_MAX_BYTES });
    const c = db(exact.root, path.relative(exact.root, exact.pdf));
    expect(await resolveJobResume(c.d.db, c.person, { root: exact.root })).toMatchObject({ ok: true });
  });

  it('no tool or argument can pass a path: the arm schema has no path field', async () => {
    const { schemas } = await import('../src/mcp/linkedin.js');
    expect(Object.keys(schemas.linkedin_arm_send)).toEqual(expect.arrayContaining(['attachment', 'reply_draft_id']));
    expect(Object.keys(schemas.linkedin_arm_send).filter((k) => k !== 'profile_url' && /path|file/i.test(k))).toEqual([]);
    expect(schemas.linkedin_attach_file).toEqual({});
    expect(schemas.linkedin_arm_send.attachment.safeParse('/etc/passwd').success).toBe(false);
    expect(schemas.linkedin_arm_send.attachment.safeParse('job_resume').success).toBe(true);
  });
});

describe('arm: kind reply and attachment', () => {
  it('arms an approved reply with the stored text and the resolved attachment; the paused person is allowed only for the reply', async () => {
    const s = mk();
    const a = await reply(s);
    expect(a).toMatchObject({ status: 'armed', text: TEXT, attachment: { name: NAME, bytes: 64 }, dry_run: false });
    expect(getReplyDraft(s.w.db, s.draftId)?.touch_id).toBe(a.touch_id);
    expect(s.w.intents.peek('linkedin')).toMatchObject({ kind: 'reply', replyDraftId: s.draftId, attachment: { name: NAME, attached: false } });
    // any other kind to the same (replied, paused) person is still refused
    s.w.intents.disarm('linkedin');
    expect(await s.w.arm({ kind: 'followup', profile_url: URL_, text: MSG })).toMatchObject({ status: 'refused', code: 'contact_paused' });
  });

  it('a draft that does not ask for the resume arms without a file, and an explicit attachment is then refused', async () => {
    const s = mk({ attachResume: false });
    const a = await reply(s);
    expect(a).toMatchObject({ status: 'armed', text: TEXT });
    expect(a.attachment).toBeUndefined();
    s.w.intents.disarm('linkedin');
    expect(await reply(s, { attachment: 'job_resume' })).toMatchObject({ status: 'refused', code: 'attachment_not_approved' });
  });

  it('refuses without an approved draft, with a closed escalation, with other text and for another person', async () => {
    const s = mk({ approve: false });
    expect(await reply(s)).toMatchObject({ status: 'refused', code: 'reply_not_approved' });
    expect(await s.w.arm({ kind: 'reply', profile_url: URL_ } as never)).toMatchObject({ code: 'reply_draft_required' });
    expect(await s.w.arm({ kind: 'reply', profile_url: URL_, reply_draft_id: 999 } as never)).toMatchObject({ code: 'reply_draft_unknown' });
    approveReplyDraft(s.w.db, s.draftId, NOW);
    expect(await reply(s, { text: 'something else entirely, no resume' })).toMatchObject({ status: 'refused', code: 'reply_text_mismatch' });
    expect(await s.w.arm({ kind: 'followup', profile_url: URL_, text: MSG, reply_draft_id: s.draftId } as never)).toMatchObject({ code: 'reply_draft_not_allowed' });
    s.w.db.prepare('UPDATE escalations SET resolved_at = ? WHERE id = ?').run(NOW.toISOString(), s.escalationId);
    expect(await reply(s)).toMatchObject({ status: 'refused', code: 'reply_escalation_closed' });
    const t = s.w.db.prepare('SELECT COUNT(*) AS n FROM touches WHERE kind = ?').get('reply') as { n: number };
    expect(t.n).toBe(0); // nothing reserved by a refusal before the guard
  });

  it('refuses a reply for a person who is paused for another reason, and when the resume cannot be resolved', async () => {
    const s = mk();
    s.w.db.prepare("UPDATE contact_state SET paused_reason = 'injection_suspected' WHERE person_id = ?").run(s.personId);
    expect(await reply(s)).toMatchObject({ status: 'refused', code: 'contact_paused' });
    s.w.db.prepare("UPDATE contact_state SET paused_reason = 'replied' WHERE person_id = ?").run(s.personId);
    const noResume = mk({ noJob: true });
    expect(await reply(noResume)).toMatchObject({ status: 'refused', code: 'attachment_no_resume' });
    expect((noResume.w.db.prepare("SELECT status FROM touches WHERE kind = 'reply'").get() as { status: string }).status).toBe('failed'); // the reserved touch is released
  });

  it('first DMs carry the file only when LINKEDIN_DM_ATTACH_RESUME is true; other kinds never', async () => {
    const off = mk({ html: profileHtml({ status: 'connected', dialog: overlay() }) });
    expect(await off.w.arm({ kind: 'role_ask', profile_url: URL_, text: MSG, attachment: 'job_resume' })).toMatchObject({ code: 'attachment_disabled' });
    expect(await off.w.arm({ kind: 'connect_note', profile_url: URL_, text: 'Hi Jane, I would like to connect.', attachment: 'job_resume' })).toMatchObject({ code: 'attachment_not_allowed' });
    expect(await off.w.arm({ kind: 'feedback', profile_url: URL_, text: MSG, attachment: 'job_resume' })).toMatchObject({ code: 'attachment_not_allowed' });
    expect(await off.w.arm({ kind: 'role_ask', profile_url: URL_, text: MSG, attachment: '/etc/passwd' as never })).toMatchObject({ code: 'bad_attachment' });
    const on = mk({ env: { ...LIVE_ENV, LINKEDIN_DM_ATTACH_RESUME: 'true' } });
    on.w.db.prepare("UPDATE contact_state SET paused_reason = NULL WHERE person_id = ?").run(on.personId);
    expect(await on.w.arm({ kind: 'role_ask', profile_url: URL_, text: MSG, attachment: 'job_resume' })).toMatchObject({ status: 'armed', attachment: { name: NAME } });
  });
});

describe('linkedin_attach_file (engine.attachFile)', () => {
  it('refuses without an armed intent and without an armed attachment', async () => {
    const s = mk();
    expect(await s.w.engine.attachFile()).toMatchObject({ ok: false, code: 'no_armed_intent' });
    s.w.db.prepare("UPDATE contact_state SET paused_reason = NULL WHERE person_id = ?").run(s.personId);
    expect((await s.w.arm({ kind: 'role_ask', profile_url: URL_, text: MSG })).status).toBe('armed');
    expect(await s.w.engine.attachFile()).toMatchObject({ ok: false, code: 'no_attachment_armed' });
    expect(s.w.page.attachFiles).toEqual([]);
  });

  it('attaches the resolved file under the generic name once the chip shows in this person\'s window', async () => {
    const s = mk();
    expect((await reply(s)).status).toBe('armed');
    s.w.page.onAct = (what) => { if (what.startsWith('attach')) s.w.page.setHtml(profileHtml({ status: 'connected', dialog: overlay({ chip: true }) })); };
    await s.w.snap();
    const r = await s.w.engine.attachFile();
    expect(r).toMatchObject({ ok: true, code: 'attached' });
    expect(s.w.page.attachFiles).toEqual([{ n: expect.any(Number), name: NAME, mimeType: 'application/pdf', bytes: 64 }]);
    expect(s.w.intents.peek('linkedin')?.attachment?.attached).toBe(true);
  });

  it('fails closed when the chip never shows, and Send is then refused', async () => {
    const s = mk();
    await reply(s);
    await s.w.snap();
    const r = await s.w.engine.attachFile();
    expect(r).toMatchObject({ ok: false, status: 'failed', code: 'attachment_not_shown' });
    expect(s.w.intents.peek('linkedin')?.attachment?.attached).toBe(false);
    const send = refOf(await s.w.snap(), 'button', 'Send');
    expect(await s.w.engine.click(send)).toMatchObject({ ok: false, code: 'attachment_not_attached' });
    expect(s.w.intents.peek('linkedin')).not.toBeNull(); // the arm stays valid
  });

  it('refuses when the person\'s window is not open, when two windows name them, and when the control names someone else', async () => {
    const other = mk({ html: profileHtml({ status: 'connected', dialog: overlay({ name: 'Someone Else' }) }) });
    await reply(other);
    await other.w.snap();
    expect(await other.w.engine.attachFile()).toMatchObject({ code: 'dialog_not_open' });
    const two = mk({ html: profileHtml({ status: 'connected', dialog: overlay() + overlay() }) });
    await reply(two);
    await two.w.snap();
    expect(await two.w.engine.attachFile()).toMatchObject({ code: 'ambiguous_dialog' });
    const wrong = mk({ html: profileHtml({ status: 'connected', dialog: overlay({ attachLabel: 'Attach a file to your conversation with Mallory Other' }) }) });
    await reply(wrong);
    await wrong.w.snap();
    expect(await wrong.w.engine.attachFile()).toMatchObject({ code: 'attach_control_mismatch' });
    const none = mk({ html: profileHtml({ status: 'connected', dialog: overlay({ attachLabel: 'Emoji' }) }) });
    await reply(none);
    await none.w.snap();
    expect(await none.w.engine.attachFile()).toMatchObject({ code: 'attach_control_missing' });
    for (const x of [other, two, wrong, none]) expect(x.w.page.attachFiles).toEqual([]);
  });

  it('re-validates the file right before reading it (a path swapped after arm is refused)', async () => {
    const s = mk();
    await reply(s);
    const intent = s.w.intents.peek('linkedin')!;
    intent.attachment!.path = '/etc/hosts';
    await s.w.snap();
    expect(await s.w.engine.attachFile()).toMatchObject({ ok: false, code: 'attachment_outside_dir' });
    expect(s.w.page.attachFiles).toEqual([]);
  });

  it('a dry run records and attaches nothing', async () => {
    const s = mk({ env: { JOBBER_DRY_RUN: 'true' } });
    expect(await reply(s)).toMatchObject({ status: 'armed', dry_run: true, attachment: { name: NAME } });
    await s.w.snap();
    expect(await s.w.engine.attachFile()).toMatchObject({ ok: true, status: 'dry_run' });
    expect(s.w.page.attachFiles).toEqual([]);
    expect((s.w.db.prepare("SELECT COUNT(*) AS n FROM dry_run_actions WHERE action = 'linkedin_attach_file'").get() as { n: number }).n).toBe(1);
  });

  it('the model can never click the attach control itself', async () => {
    const s = mk();
    await reply(s);
    const ref = refOf(await s.w.snap(), 'button', 'Attach a file to your conversation with Jane Example');
    expect(await s.w.engine.click(ref)).toMatchObject({ ok: false, code: 'irreversible_refused' });
    expect(s.w.page.log.some((l) => l.startsWith('click '))).toBe(false);
    expect(classify({ platform: 'linkedin', role: 'button', name: 'Attach a file', dialogName: 'Messaging' })).toBe('irreversible_other');
  });
});

describe('Send with a file: confirmation needs the text AND the file name in the sent bubble', () => {
  const run = async (after: string, opts: { network?: boolean } = {}) => {
    const s = mk();
    await reply(s);
    s.w.page.onAct = (what) => { if (what.startsWith('attach')) s.w.page.setHtml(profileHtml({ status: 'connected', dialog: overlay({ chip: true }) })); };
    await s.w.snap();
    expect((await s.w.engine.attachFile()).code).toBe('attached');
    s.w.page.onAct = (what) => { if (what.startsWith('click')) s.w.page.setHtml(after); };
    s.w.page.responseOk = opts.network !== false;
    const send = refOf(await s.w.snap(), 'button', 'Send');
    const res = await s.w.engine.click(send);
    return { s, res };
  };
  const bubbleHtml = profileHtml({ status: 'connected', dialog: overlay({ bubble: true }) });
  const textOnly = profileHtml({ status: 'connected', dialog: `<div role="dialog" aria-label="Messaging"><h2>Jane Example</h2><p>${TEXT}</p><textarea></textarea><footer><button>Send</button></footer></div>` });

  it('text and file name both shown: sent; the draft is sent, the escalation handled, the cadence untouched, no connections row', async () => {
    const before = { stage: 'active', last: new Date(NOW.getTime() - 5 * 86400_000).toISOString() };
    const { s, res } = await run(bubbleHtml);
    expect(res).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(getReplyDraft(s.w.db, s.draftId)).toMatchObject({ status: 'sent', touch_id: res.touch_id });
    const esc = s.w.db.prepare('SELECT resolved_at, resolved_note FROM escalations WHERE id = ?').get(s.escalationId) as { resolved_at: string | null; resolved_note: string | null };
    expect(esc.resolved_at).not.toBeNull();
    expect(esc.resolved_note).toMatch(/reply draft/);
    const cs = s.w.db.prepare('SELECT stage, paused_reason, last_touch_at FROM contact_state WHERE person_id = ?').get(s.personId) as { stage: string; paused_reason: string; last_touch_at: string };
    expect(cs).toEqual({ stage: before.stage, paused_reason: 'replied', last_touch_at: before.last });
    expect((s.w.db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }).n).toBe(0);
    expect((s.w.db.prepare("SELECT status FROM touches WHERE kind = 'reply'").get() as { status: string }).status).toBe('sent');
    // a sent reply never counts as a cadence message: the person (paused) has nothing due, and unpausing would not skip a step
    s.w.db.prepare('UPDATE contact_state SET paused_reason = NULL WHERE person_id = ?').run(s.personId);
    const due = dueTouchesFor(s.w.db, new Date(NOW.getTime() + 30 * 86400_000), TUNING_DEFAULTS).filter((d) => d.person_id === s.personId);
    expect(due.every((d) => d.kind !== 'connect')).toBe(true);
    expect(due[0]?.kind).toBe('followup'); // the step after role_ask: the reply did not advance it
  });

  it('the text without the file name is unconfirmed even with a network response; the draft is failed', async () => {
    const { s, res } = await run(textOnly);
    expect(res).toMatchObject({ ok: false, status: 'unconfirmed' });
    expect(getReplyDraft(s.w.db, s.draftId)?.status).toBe('failed');
    expect((s.w.db.prepare('SELECT resolved_at FROM escalations WHERE id = ?').get(s.escalationId) as { resolved_at: string | null }).resolved_at).toBeNull();
  });

  it('a pending attachment chip (still removable) does not count as the sent file', async () => {
    const chipStill = profileHtml({ status: 'connected', dialog: overlay({ chip: true, text: '' }) });
    const { res } = await run(chipStill);
    expect(res).toMatchObject({ ok: false, status: 'unconfirmed' });
  });

  it('attachmentShown reads the tree: file name present and no remove control', () => {
    const t = (html: string) => buildTreeFromHtml(html, URL_);
    const dlg = (html: string) => { const tree = t(html); return { tree, n: tree.nodes.find((x) => x.role === 'dialog')!.n }; };
    const sent = dlg(overlay({ bubble: true }));
    expect(attachmentShown(sent.tree, sent.n, NAME)).toBe(true);
    const pending = dlg(overlay({ chip: true }));
    expect(attachmentShown(pending.tree, pending.n, NAME)).toBe(false);
    const none = dlg(overlay());
    expect(attachmentShown(none.tree, none.n, NAME)).toBe(false);
    expect(attachmentShown(sent.tree, sent.n, '')).toBe(false);
  });
});

describe('file chooser plumbing', () => {
  it('answerFileChooser clicks while waiting for the chooser and hands over the in-memory file', async () => {
    const calls: string[] = [];
    const page = {
      waitForEvent: async (name: string) => { calls.push(`wait ${name}`); return { setFiles: async (f: { name: string; mimeType: string; buffer: Buffer }) => { calls.push(`set ${f.name} ${f.mimeType} ${f.buffer.length}`); } }; },
    };
    await answerFileChooser(page, async () => { calls.push('click'); }, { name: NAME, mimeType: 'application/pdf', buffer: Buffer.alloc(3) });
    expect(calls).toEqual(['wait filechooser', 'click', `set ${NAME} application/pdf 3`]);
    await expect(answerFileChooser({}, async () => undefined, { name: 'a', mimeType: 'b', buffer: Buffer.alloc(1) })).rejects.toThrow(/file chooser/);
    await expect(answerFileChooser({ waitForEvent: async () => { throw new Error('timeout'); } }, async () => undefined, { name: 'a', mimeType: 'b', buffer: Buffer.alloc(1) })).rejects.toThrow(/timeout/);
  });

  it('realBcPage.attachFile clicks the stamped control and answers the chooser', async () => {
    const calls: string[] = [];
    const loc = { count: async () => 1, first: () => loc, click: async () => { calls.push('click'); } };
    const page: any = {
      url: () => URL_, locator: (s: string) => { calls.push(`locator ${s}`); return loc; }, waitForTimeout: async () => undefined,
      waitForEvent: async () => ({ setFiles: async (f: { name: string }) => { calls.push(`set ${f.name}`); } }),
    };
    await realBcPage(page).attachFile!(7, { name: NAME, mimeType: 'application/pdf', buffer: Buffer.alloc(1) });
    expect(calls).toContain('locator [data-bc="7"]');
    expect(calls.slice(-2)).toEqual(['click', `set ${NAME}`]);
  });
});

describe('tests do not leave files behind', () => {
  it('uses temp roots only', () => {
    expect(existsSync(path.join(process.cwd(), 'renderer', 'automation', 'job1'))).toBe(false);
  });
});
