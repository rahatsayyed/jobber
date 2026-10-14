import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReplyDetail, decideReply, type ReplyClass, type ReplyMatch } from '../src/replies.js';

// Two permanent synthetic fixtures: the 103-mail unseen set (used for tuning in fix round 1) and the 79-mail holdout written independently BEFORE the
// classifier was read (before fix round 2 it produced 3 false auto-records out of 22). After round-2 tuning the holdout is no longer an independent
// measurement: these tests are regression guards, not accuracy claims.
interface Mail { id: string; subject: string; from: string; body_text: string | null; body_html: string | null; ours: string | null; expected: string[]; expected_auto_record: boolean }
const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f: string): Mail[] => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'));
const UNSEEN = load('replies-unseen.json');
const HOLDOUT = load('replies-holdout.json');
const HIGH: ReplyMatch = { job_id: 'j1', confidence: 'high', via: 'thread' };
const ENABLED = { auto_record_enabled: true };
const acceptable = (m: Mail): ReplyClass[] => m.expected.map((e) => (e === 'out_of_office' ? 'auto_ack' : e)) as ReplyClass[];
const run = (m: Mail) => {
  const d = classifyReplyDetail(m.subject, m.body_text ?? m.body_html ?? '', m.from, m.ours ?? '');
  return { ...d, decision: decideReply(d.cls, HIGH, null, ENABLED, d.eligible) };
};
const hold = (id: string) => { const m = HOLDOUT.find((x) => x.id === id); if (!m) throw new Error(id); return { m, r: run(m) }; };

describe.each([['unseen (103)', UNSEEN], ['holdout (79)', HOLDOUT]] as Array<[string, Mail[]]>)('%s', (_name, mails) => {
  it('with auto-record ENABLED: zero false auto-records (not expected to auto-record, or wrong class)', () => {
    const bad = mails.filter((m) => { const r = run(m); return r.decision.action === 'auto_record' && (!m.expected_auto_record || !acceptable(m).includes(r.cls)); }).map((m) => `${m.id}:${run(m).cls}`);
    expect(bad).toEqual([]);
  });
  it('never ignores a mail that expects a human-relevant class (rejected/interview/offer/replied) unless it is an auto-ack/noise/out-of-office/bounce', () => {
    const bad = mails.filter((m) => run(m).decision.action === 'ignore' && acceptable(m).some((c) => ['rejected', 'interview', 'offer'].includes(c)) && !acceptable(m).some((c) => ['auto_ack', 'noise', 'unknown'].includes(c))).map((m) => `${m.id}:${run(m).cls}`);
    expect(bad).toEqual([]);
  });
});

describe('holdout pinned cases (fix round 2)', () => {
  it('h32 "interviewer is unwell ... interview stands cancelled" is a plain reply, never an eligible rejection', () => {
    const { r } = hold('h32');
    expect(r.cls).toBe('replied'); expect(r.eligible).toBe(false); expect(r.decision.action).toBe('propose');
  });
  it('h16 hiring freeze "can\'t move on anything right now ... reconnect in January" is never auto-recorded', () => {
    const { r } = hold('h16');
    expect(['replied', 'rejected']).toContain(r.cls); expect(r.eligible).toBe(false); expect(r.decision.action).not.toBe('auto_record');
  });
  it('h74 "got your availability" is not an interview', () => {
    const { r } = hold('h74');
    expect(r.cls).not.toBe('interview'); expect(r.decision.action).not.toBe('auto_record');
  });
  it('h11 Workday "Current status: No longer under consideration" is a rejection, not ignored', () => {
    const { r } = hold('h11');
    expect(r.cls).toBe('rejected'); expect(r.decision.action).not.toBe('ignore');
  });
  it('h28 Ashby "interview ... has been scheduled" is shown to the user, never ignored and never auto-recorded (automated sender)', () => {
    const { r } = hold('h28');
    expect(['interview', 'replied']).toContain(r.cls); expect(r.decision.action).toBe('propose');
  });
  it('h66 human "our team will review it there" is a plain reply, not an auto-ack', () => {
    const { r } = hold('h66');
    expect(r.cls).toBe('replied'); expect(r.decision.action).toBe('propose');
  });
  it.each(['h29', 'h30', 'h31', 'h32', 'h33', 'h34'])('reschedule/cancellation family %s is never eligible and never auto-recorded', (id) => {
    const { r } = hold(id);
    expect(r.eligible).toBe(false); expect(r.decision.action).not.toBe('auto_record'); expect(r.cls).not.toBe('rejected');
  });
  it('weak phrases classify rejected but stay proposals (h12 internal candidate, h59 cannot make an offer, h77 lamentablemente, h06 pursue candidates with)', () => {
    for (const id of ['h12', 'h59', 'h77', 'h06']) { const { r } = hold(id); expect(r.cls).toBe('rejected'); expect(r.eligible).toBe(false); expect(r.decision.action).toBe('propose'); }
  });
  it('German and French out-of-office terms are out-of-office', () => {
    for (const id of ['h44', 'h45']) expect(hold(id).r.cls).toBe('auto_ack');
  });
});

describe('known gaps are listed and bounded', () => {
  it('prints class disagreements for both sets; all are safe (no auto_record) and bounded', () => {
    const gaps: string[] = [];
    for (const [name, mails] of [['unseen', UNSEEN], ['holdout', HOLDOUT]] as Array<[string, Mail[]]>) {
      for (const m of mails) { const r = run(m); if (!acceptable(m).includes(r.cls)) gaps.push(`${name} ${m.id} expected ${m.expected.join('|')} got ${r.cls} (${r.decision.action})`); }
    }
    console.error(`[repliesHoldout] agreement unseen ${UNSEEN.length - gaps.filter((g) => g.startsWith('unseen')).length}/${UNSEEN.length}, holdout ${HOLDOUT.length - gaps.filter((g) => g.startsWith('holdout')).length}/${HOLDOUT.length}; known gaps:\n  ${gaps.join('\n  ')}`);
    expect(gaps.filter((g) => g.endsWith('(auto_record)'))).toEqual([]);
    // 7 observed (unseen X5 X6 X7: reschedule/pivot mails routed to replied; holdout h28 reschedule footer, h36 h38 promo mails, h43 "On a break" OOO), plus 2 headroom.
    expect(gaps.length).toBeLessThanOrEqual(9);
  });
});
