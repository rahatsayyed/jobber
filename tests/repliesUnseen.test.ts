import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReplyDetail, decideReply, type ReplyClass, type ReplyMatch } from '../src/replies.js';

// 103 synthetic mails (no real people or data; "Jane Doe" is the user's own name inside synthetic quotes) written by a reviewer who
// did NOT see the classifier. Permanent regression fixture. `expected` lists the acceptable classes; `expected_auto_record` says whether
// the mail may be auto-recorded (high-confidence match, nothing recorded yet) when auto-record is ENABLED.
interface Mail { id: string; subject: string; from: string; body_text: string | null; body_html: string | null; ours: string | null; expected: ReplyClass[]; expected_auto_record: boolean; description: string }
const here = path.dirname(fileURLToPath(import.meta.url));
const MAILS: Mail[] = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'replies-unseen.json'), 'utf8'));
const HIGH: ReplyMatch = { job_id: 'j1', confidence: 'high', via: 'thread' };
const ENABLED = { auto_record_enabled: true };

const run = (m: Mail) => {
  const d = classifyReplyDetail(m.subject, m.body_text ?? m.body_html ?? '', m.from, m.ours ?? '');
  const decision = decideReply(d.cls, HIGH, null, ENABLED, d.eligible);
  return { cls: d.cls, decision };
};
const byId = (id: string) => { const m = MAILS.find((x) => x.id === id); if (!m) throw new Error(`no mail ${id}`); return m; };

describe('unseen reply set (103 synthetic mails)', () => {
  it('has the 103 mails', () => expect(MAILS).toHaveLength(103));

  it('with auto-record ENABLED, no mail that must not be auto-recorded ever comes out auto_record (either direction)', () => {
    const bad = MAILS.filter((m) => !m.expected_auto_record && run(m).decision.action === 'auto_record').map((m) => `${m.id}:${run(m).cls}`);
    expect(bad).toEqual([]);
  });

  it('every auto_record decision carries an acceptable class (no wrong-class auto-record)', () => {
    const bad = MAILS.filter((m) => { const r = run(m); return r.decision.action === 'auto_record' && !m.expected.includes(r.cls); }).map((m) => `${m.id}:${run(m).cls}`);
    expect(bad).toEqual([]);
  });

  it('bounce, out-of-office, auto-ack and noise mails never carry an auto-recordable class', () => {
    const quiet = MAILS.filter((m) => m.expected.every((e) => ['bounce', 'auto_ack', 'noise'].includes(e)));
    const bad = quiet.filter((m) => ['interview', 'rejected', 'offer', 'replied'].includes(run(m).cls)).map((m) => `${m.id}:${run(m).cls}`);
    expect(bad).toEqual([]);
  });

  it('with auto-record DISABLED (the default) nothing is ever auto_record', () => {
    for (const m of MAILS) {
      const d = classifyReplyDetail(m.subject, m.body_text ?? m.body_html ?? '', m.from, m.ours ?? '');
      expect(decideReply(d.cls, HIGH, null, { auto_record_enabled: false }, d.eligible).action).not.toBe('auto_record');
    }
  });

  it.each([
    ['R16', ['rejected']], ['R12', ['rejected']], ['X5', ['replied', 'interview']], ['X6', ['replied', 'interview']], ['X7', ['replied', 'interview']],
    ['H2', ['noise']], ['H8', ['auto_ack']], ['H9', ['noise']], ['X13', ['noise']], ['O3', ['auto_ack']], ['O4', ['auto_ack']],
  ] as Array<[string, ReplyClass[]]>)('pinned %s', (id, allowed) => {
    const r = run(byId(id));
    expect(allowed).toContain(r.cls);
    if (!['R16', 'R12'].includes(id)) expect(r.decision.action).not.toBe('auto_record');
  });

  it('R16 ("will not be extending an offer") is never an offer', () => expect(run(byId('R16')).cls).not.toBe('offer'));

  it('reports overall agreement and lists known gaps; disagreements are bounded and all on the safe side', () => {
    const gaps: string[] = [];
    for (const m of MAILS) { const r = run(m); if (!m.expected.includes(r.cls)) gaps.push(`${m.id} expected ${m.expected.join('|')} got ${r.cls} (${r.decision.action})`); }
    const pct = (((MAILS.length - gaps.length) / MAILS.length) * 100).toFixed(1);
    console.error(`[repliesUnseen] class agreement ${MAILS.length - gaps.length}/${MAILS.length} (${pct}%); known gaps: ${gaps.length ? '\n  ' + gaps.join('\n  ') : 'none'}`);
    // Bound: 3 gaps today (X5, X6, X7: reschedule / pivot mails that AG1 deliberately routes to replied, a proposal) plus 2 of headroom. Before the fix
    // there were 26 disagreements (77/103). Every gap must also be safe (no auto_record), asserted above.
    expect(gaps.length).toBeLessThanOrEqual(5);
  });
});
