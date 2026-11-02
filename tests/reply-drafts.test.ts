// LinkedIn reply drafts: the lifecycle (drafted, approved, sent), the gates on the text, the staleness rule, the owner CLI and the
// outreach MCP tool. Fakes only: in-memory db, invented people.
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { addEscalation, hashInboundText, recordInbound } from '../src/outreach/service.js';
import {
  approveReplyDraft, approvedReplyDrafts, bindDraftTouch, countDraftsByStatus, getReplyDraft, listReplyDrafts, markReplyDraftFailed,
  markReplyDraftSent, saveReplyDraft, skipReplyDraft, type SaveDeps,
} from '../src/outreach/replyDrafts.js';
import { renderReplyDraftLines, runRepliesCli } from '../src/outreach/replyDraftsCli.js';
import { handleSaveReplyDraft } from '../src/mcp/outreach.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const LATER = new Date('2026-10-15T09:00:00.000Z');
const TEXT = 'Thanks for reaching out, Jane. My resume is attached. Happy to answer any questions about my work.';
const deps = (o: Partial<SaveDeps> = {}): SaveDeps => ({
  now: NOW, env: {}, styleCfg: DEFAULT_STYLE_CONFIG, cfg: { allowedUrls: [], allowedEmails: [] },
  factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), ...o,
});

function world() {
  const db = openDb(':memory:');
  const person = upsertPerson(db, { platform: 'linkedin', profileKey: 'linkedin.com/in/jane-example', name: 'Jane Example', headline: 'Recruiter at Acme', company: 'Acme', category: 'recruiter' });
  const inbound = (thread: string, klass: Parameters<typeof recordInbound>[1]['klass'], at = NOW, text = 'please send your cv'): void => {
    recordInbound(db, { platform: 'linkedin', threadRef: thread, personId: person, textHash: hashInboundText(text), klass, escalated: true }, at);
  };
  const escalate = (reason: string, thread = '2-abc', klass: Parameters<typeof recordInbound>[1]['klass'] = 'reply'): number => {
    inbound(thread, klass);
    return addEscalation(db, { runId: null, platform: 'linkedin', personId: person, threadRef: thread, reason, detail: 'asks for the resume', excerpt: 'please send your cv' }, NOW);
  };
  return { db, person, escalate, inbound };
}

describe('saveReplyDraft', () => {
  it('stores one drafted reply; documents sets attach_resume, a plain request does not', () => {
    const w = world();
    const e1 = w.escalate('documents');
    const r1 = saveReplyDraft(w.db, { escalationId: e1, text: TEXT }, deps());
    expect(r1).toMatchObject({ ok: true, attach_resume: true });
    const d = getReplyDraft(w.db, (r1 as { id: number }).id)!;
    expect(d).toMatchObject({ status: 'drafted', kind: 'reply', attach_resume: 1, person_id: w.person, thread_ref: '2-abc', escalation_id: e1 });
    expect(d.body).toBe(TEXT);
    const e2 = w.escalate('linkedin_reply_needed', '2-def');
    expect(saveReplyDraft(w.db, { escalationId: e2, text: 'Thanks Jane, happy to talk about the role.' }, deps())).toMatchObject({ ok: true, attach_resume: false });
  });

  it('refuses a second live draft for the same escalation, but allows one after a skip', () => {
    const w = world();
    const e = w.escalate('documents');
    const first = saveReplyDraft(w.db, { escalationId: e, text: TEXT }, deps()) as { id: number };
    expect(saveReplyDraft(w.db, { escalationId: e, text: TEXT }, deps())).toMatchObject({ ok: false, code: 'draft_exists' });
    skipReplyDraft(w.db, first.id);
    expect(saveReplyDraft(w.db, { escalationId: e, text: TEXT }, deps())).toMatchObject({ ok: true });
  });

  it('refuses reasons that are not draftable, salary and interview asks, flagged text, resolved and unknown escalations, other platforms', () => {
    const w = world();
    expect(saveReplyDraft(w.db, { escalationId: w.escalate('salary', '2-s'), text: TEXT }, deps())).toMatchObject({ code: 'reason_not_draftable' });
    expect(saveReplyDraft(w.db, { escalationId: w.escalate('linkedin_reply_needed', '2-i', 'interview'), text: TEXT }, deps())).toMatchObject({ code: 'owner_only' });
    expect(saveReplyDraft(w.db, { escalationId: 9999, text: TEXT }, deps())).toMatchObject({ code: 'unknown_escalation' });
    const blocked = addEscalation(w.db, { runId: null, platform: 'linkedin', personId: w.person, threadRef: '2-b', reason: 'documents', blockedCode: 'injection', rawText: 'x' }, NOW);
    expect(saveReplyDraft(w.db, { escalationId: blocked, text: TEXT }, deps())).toMatchObject({ code: 'flagged_text' });
    const done = w.escalate('documents', '2-r');
    w.db.prepare('UPDATE escalations SET resolved_at = ? WHERE id = ?').run(NOW.toISOString(), done);
    expect(saveReplyDraft(w.db, { escalationId: done, text: TEXT }, deps())).toMatchObject({ code: 'already_resolved' });
    const nk = addEscalation(w.db, { runId: null, platform: 'naukri', reason: 'documents' }, NOW);
    expect(saveReplyDraft(w.db, { escalationId: nk, text: TEXT }, deps())).toMatchObject({ code: 'not_linkedin' });
    const noPerson = addEscalation(w.db, { runId: null, platform: 'linkedin', threadRef: '2-n', reason: 'documents' }, NOW);
    expect(saveReplyDraft(w.db, { escalationId: noPerson, text: TEXT }, deps())).toMatchObject({ code: 'no_person' });
  });

  it('runs the length, style, fact and output gates', () => {
    const w = world();
    const e = w.escalate('documents');
    expect(saveReplyDraft(w.db, { escalationId: e, text: '   ' }, deps())).toMatchObject({ code: 'empty_text' });
    expect(saveReplyDraft(w.db, { escalationId: e, text: 'x'.repeat(1801) }, deps())).toMatchObject({ code: 'message_too_long' });
    expect(saveReplyDraft(w.db, { escalationId: e, text: 'Hello Jane, my resume is attached. Reach me at jane@evil.example for details.' }, deps())).toMatchObject({ code: 'output_gate_text' });
    expect(saveReplyDraft(w.db, { escalationId: e, text: TEXT }, deps({ factCheck: () => ({ verdict: 'block', normalized_text: TEXT }) }))).toMatchObject({ code: 'fact_gate_block' });
    expect(saveReplyDraft(w.db, { escalationId: e, text: TEXT }, deps({ factCheck: () => { throw new Error('x'); } }))).toMatchObject({ code: 'fact_gate_error' });
    const many = Array.from({ length: 120 }, () => 'word').join(' ');
    expect(saveReplyDraft(w.db, { escalationId: e, text: many }, deps())).toMatchObject({ code: 'style_gate' });
    expect(countDraftsByStatus(w.db).drafted).toBe(0);
  });
});

describe('approval and the send hand-off', () => {
  const drafted = () => {
    const w = world();
    const e = w.escalate('documents');
    const id = (saveReplyDraft(w.db, { escalationId: e, text: TEXT }, deps()) as { id: number }).id;
    return { ...w, e, id };
  };

  it('only an approved draft is offered to the lane; approve and skip change status only', () => {
    const w = drafted();
    expect(approvedReplyDrafts(w.db)).toHaveLength(0);
    expect(approveReplyDraft(w.db, w.id, LATER)).toEqual({ ok: true });
    expect(getReplyDraft(w.db, w.id)).toMatchObject({ status: 'approved', approved_at: LATER.toISOString() });
    expect(approvedReplyDrafts(w.db).map((d) => d.id)).toEqual([w.id]);
    expect(approveReplyDraft(w.db, w.id, LATER)).toMatchObject({ ok: false }); // already approved
    expect(skipReplyDraft(w.db, w.id)).toEqual({ ok: true });
    expect(approvedReplyDrafts(w.db)).toHaveLength(0);
    expect(skipReplyDraft(w.db, w.id)).toMatchObject({ ok: false });
    expect(approveReplyDraft(w.db, 999, LATER)).toMatchObject({ ok: false, reason: 'no such draft' });
    // nothing was sent and the escalation is untouched
    expect((w.db.prepare('SELECT resolved_at FROM escalations WHERE id = ?').get(w.e) as { resolved_at: string | null }).resolved_at).toBeNull();
  });

  it('a newer inbound message makes the draft stale: it is not approvable and not offered', () => {
    const w = drafted();
    approveReplyDraft(w.db, w.id, LATER);
    w.inbound('2-abc', 'reply', new Date(NOW.getTime() + 30 * 60_000), 'actually, also send a portfolio');
    expect(getReplyDraft(w.db, w.id)?.stale).toBe(true);
    expect(approvedReplyDrafts(w.db).map((d) => d.id)).toEqual([w.id]); // still approved; the lane skips stale ones
    const w2 = drafted();
    w2.inbound('2-abc', 'reply', new Date(NOW.getTime() + 30 * 60_000), 'one more thing');
    expect(approveReplyDraft(w2.db, w2.id, LATER)).toMatchObject({ ok: false });
  });

  it('a confirmed send marks the draft sent and the escalation handled with a note; the person stays paused', () => {
    const w = drafted();
    approveReplyDraft(w.db, w.id, LATER);
    const t = Number(w.db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status) VALUES (?, 'reply', 'k1', 'sent')").run(w.person).lastInsertRowid);
    bindDraftTouch(w.db, w.id, t);
    expect(markReplyDraftSent(w.db, t, LATER)).toBe(true);
    expect(getReplyDraft(w.db, w.id)).toMatchObject({ status: 'sent', sent_at: LATER.toISOString(), touch_id: t });
    const esc = w.db.prepare('SELECT resolved_at, resolved_note FROM escalations WHERE id = ?').get(w.e) as { resolved_at: string; resolved_note: string };
    expect(esc.resolved_at).toBe(LATER.toISOString());
    expect(esc.resolved_note).toMatch(/drip lane/);
    expect((w.db.prepare('SELECT paused_reason FROM contact_state WHERE person_id = ?').get(w.person) as { paused_reason: string }).paused_reason).toBe('replied');
    expect(markReplyDraftSent(w.db, t, LATER)).toBe(false); // only once
  });

  it('a failed or unconfirmed send makes the draft failed; the owner can approve it again', () => {
    const w = drafted();
    approveReplyDraft(w.db, w.id, LATER);
    bindDraftTouch(w.db, w.id, 77);
    markReplyDraftFailed(w.db, 77);
    expect(getReplyDraft(w.db, w.id)?.status).toBe('failed');
    expect(approvedReplyDrafts(w.db)).toHaveLength(0);
    expect(approveReplyDraft(w.db, w.id, LATER)).toEqual({ ok: true });
  });

  it('an approved draft whose escalation was handled by the owner is not offered', () => {
    const w = drafted();
    approveReplyDraft(w.db, w.id, LATER);
    w.db.prepare('UPDATE escalations SET resolved_at = ? WHERE id = ?').run(LATER.toISOString(), w.e);
    expect(approvedReplyDrafts(w.db)).toHaveLength(0);
  });
});

describe('npm run replies (runRepliesCli)', () => {
  it('lists, approves and skips; bad usage exits 2; a refused change exits 1', () => {
    const w = world();
    const e = w.escalate('documents');
    const id = (saveReplyDraft(w.db, { escalationId: e, text: TEXT }, deps()) as { id: number }).id;
    const list = runRepliesCli(w.db, ['list'], NOW);
    expect(list.code).toBe(0);
    expect(list.lines.join('\n')).toMatch(new RegExp(`#${id} DRAFTED to Jane Example \\(Acme\\)`));
    expect(list.lines.join('\n')).toMatch(/attaches the tailored resume/);
    expect(runRepliesCli(w.db, ['approve', String(id)], LATER)).toMatchObject({ code: 0 });
    expect(getReplyDraft(w.db, id)?.status).toBe('approved');
    expect(runRepliesCli(w.db, ['approve', String(id)], LATER)).toMatchObject({ code: 1 });
    expect(runRepliesCli(w.db, ['skip', String(id)], LATER)).toMatchObject({ code: 0 });
    expect(getReplyDraft(w.db, id)?.status).toBe('skipped');
    expect(runRepliesCli(w.db, ['approve'], NOW).code).toBe(2);
    expect(runRepliesCli(w.db, ['approve', 'x'], NOW).code).toBe(2);
    expect(runRepliesCli(w.db, ['nope'], NOW).code).toBe(2);
    expect(runRepliesCli(w.db, ['list', 'weird'], NOW).code).toBe(2);
    expect(runRepliesCli(w.db, ['list', 'skipped'], NOW).lines.join('\n')).toContain(`#${id} SKIPPED`);
    expect(runRepliesCli(world().db, ['list'], NOW).lines).toEqual(['No reply drafts.']);
  });

  it('cleans model and third-party text to one line, and the /escalations screen shows waiting drafts only', () => {
    const w = world();
    w.db.prepare("UPDATE people SET name = 'Jane <b>Example</b>\nINJECT' WHERE id = ?").run(w.person);
    const e = w.escalate('documents');
    saveReplyDraft(w.db, { escalationId: e, text: TEXT }, deps());
    const lines = renderReplyDraftLines(w.db);
    expect(lines.join('\n')).toContain('Reply drafts (1)');
    expect(lines.join('\n')).not.toMatch(/<b>|<\/b>/);
    expect(lines.filter((l) => l.startsWith('#'))).toHaveLength(1);
    approveReplyDraft(w.db, 1, LATER);
    markReplyDraftSent(w.db, 1, LATER);
    expect(renderReplyDraftLines(world().db)).toEqual([]);
  });
});

describe('outreach MCP save_reply_draft', () => {
  it('stores through the same gates, with the injected fact gate and style config', () => {
    const w = world();
    const e = w.escalate('documents');
    const r = handleSaveReplyDraft(
      { db: w.db, now: () => NOW, env: {}, styleCfg: DEFAULT_STYLE_CONFIG, factCheck: (t) => ({ verdict: 'pass', normalized_text: t }) },
      { escalation_id: e, text: TEXT },
    );
    expect(r).toMatchObject({ ok: true, attach_resume: true });
    expect(listReplyDrafts(w.db)).toHaveLength(1);
    const again = handleSaveReplyDraft({ db: w.db, now: () => NOW, env: {}, styleCfg: DEFAULT_STYLE_CONFIG, factCheck: (t) => ({ verdict: 'pass', normalized_text: t }) }, { escalation_id: e, text: TEXT });
    expect(again).toMatchObject({ ok: false, code: 'draft_exists' });
  });
});
