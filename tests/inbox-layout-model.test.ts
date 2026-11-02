import { describe, expect, it } from 'vitest';
import {
  blockIds, buildSummary, groupApplyByHost, hostGroupTitle, openSectionCounts, pageBlocks, SECTION_ORDER, sectionAnchor, sectionOfItem, splitSections, summaryTotal,
} from '../apps/dashboard/src/lib/inbox-layout-model.js';
import type { InboxItem } from '../apps/dashboard/src/lib/inbox-model.js';

let n = 0;
function item(over: Partial<InboxItem>): InboxItem {
  n += 1;
  return {
    id: n, ids: [n], count: 1, platform: 'linkedin', reason: 'layout_drift', detail: null, group: 'platform', flag: null,
    created_at: '2026-10-30T10:00:00Z', first_at: '2026-10-30T10:00:00Z', last_at: `2026-10-30T10:${String(n % 60).padStart(2, '0')}:00Z`, threadRef: null, threadUrl: null,
    personId: null, personName: null, personCompany: null, jobId: null, jobTitle: null, resolved_at: null, snoozed_until: null,
    senderName: null, senderHeadline: null, excerpt: null, messageAt: null, askKind: 'other', label: 'Platform problem', todo: '', updates: 1,
    rawText: null, resolvedNote: null, ...over,
  };
}
const applyCard = (reason: string, host: string | null, title: string | null = null): InboxItem => item({
  platform: 'apply', group: 'platform', reason: `apply:${reason}`,
  applyJob: { jobId: title ? `j-${title}` : null, title, company: title ? 'Acme' : null, host, url: null, questions: [] },
});

describe('inbox layout model: order and summary', () => {
  it('puts the groups in the fixed order replies, needs your answer, platform problems, apply by hand, flagged and other', () => {
    expect(SECTION_ORDER).toEqual(['replies', 'needs-answer', 'platform', 'manual', 'other']);
    const s = buildSummary({ replies: 3, needsAnswer: 2, platform: 5, manual: 78, other: 1 });
    expect(s.map((e) => e.id)).toEqual(SECTION_ORDER);
    expect(s.map((e) => e.count)).toEqual([3, 2, 5, 78, 1]);
    expect(s.map((e) => e.href)).toEqual(SECTION_ORDER.map((id) => `#${sectionAnchor(id)}`));
    expect(s[0].label).toBe('Replies and recruiters');
    expect(summaryTotal(s)).toBe(89);
  });

  it('sends replies and recruiters first, platform and apply problems next, flagged and other last', () => {
    const reply = item({ group: 'human', askKind: 'reply', platform: 'linkedin' });
    const recruiter = item({ group: 'human', askKind: 'recruiter_inquiry' });
    const platform = item({ group: 'platform', reason: 'session_expired' });
    const apply = applyCard('drift', 'acme.io');
    const flagged = item({ group: 'noise' });
    const other = item({ group: 'human', askKind: 'other' });
    expect([reply, recruiter].map(sectionOfItem)).toEqual(['replies', 'replies']);
    expect([platform, apply].map(sectionOfItem)).toEqual(['platform', 'platform']);
    expect([flagged, other].map(sectionOfItem)).toEqual(['other', 'other']);
    const split = splitSections([flagged, apply, other, reply, platform, recruiter]);
    expect(split.replies.map((i) => i.id).sort()).toEqual([reply.id, recruiter.id].sort());
    expect(split.platform).toHaveLength(2);
    expect(split.other).toHaveLength(2);
  });

  it('counts only open cards per group', () => {
    const open = item({ group: 'human', askKind: 'reply' });
    const done = item({ group: 'human', askKind: 'reply', resolved_at: '2026-10-31T00:00:00Z' });
    expect(openSectionCounts([open, done, item({ group: 'noise' })])).toEqual({ replies: 1, platform: 0, other: 1 });
  });

  it('pages a list of blocks with the rest count', () => {
    expect(pageBlocks([1, 2, 3, 4, 5], 2)).toEqual({ visible: [1, 2], rest: 3 });
    expect(pageBlocks([1], 5)).toEqual({ visible: [1], rest: 0 });
  });
});

describe('inbox layout model: apply problems grouped by site', () => {
  it('turns identical problems of one site into one group with a count and a short reason', () => {
    const a = applyCard('drift', 'kompatibleminds.com', 'A');
    const b = applyCard('drift', 'kompatibleminds.com', 'B');
    const c = applyCard('drift', 'kompatibleminds.com', 'C');
    const lone = applyCard('drift', 'other.io', 'D');
    const blocks = groupApplyByHost([a, lone, b, c]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'host', host: 'kompatibleminds.com', title: 'kompatibleminds.com: 3 jobs, page structure changed' });
    expect(blocks[0].kind === 'host' && blocks[0].items.map((i) => i.id)).toEqual([a.id, b.id, c.id]);
    expect(blocks[1]).toMatchObject({ kind: 'card' });
    expect(blockIds(blocks[0])).toEqual([a.id, b.id, c.id]);
  });

  it('keeps different reasons or sites apart and never groups other cards or the needs-answer cards', () => {
    const drift = applyCard('drift', 'x.io', 'A');
    const captcha = applyCard('captcha', 'x.io', 'B');
    const other = item({ group: 'platform', reason: 'layout_drift' });
    const other2 = item({ group: 'platform', reason: 'layout_drift' });
    const na1 = applyCard('needs_answer', 'x.io');
    const na2 = applyCard('needs_answer', 'x.io');
    const blocks = groupApplyByHost([drift, captcha, other, other2, na1, na2]);
    expect(blocks.every((b) => b.kind === 'card')).toBe(true);
    expect(blocks).toHaveLength(6);
  });

  it('groups old cards that have only a host, and cards with no host under an unknown site', () => {
    const blocks = groupApplyByHost([applyCard('drift', 'old.example'), applyCard('drift', 'old.example'), applyCard('other', null), applyCard('other', null)]);
    expect(blocks.map((b) => (b.kind === 'host' ? b.title : 'card'))).toEqual(['old.example: 2 jobs, page structure changed', 'Unknown site: 2 jobs, it stopped for another reason']);
  });

  it('builds the title with a singular and a plural', () => {
    expect(hostGroupTitle('a.io', 1, 'captcha')).toBe('a.io: 1 job, a CAPTCHA blocks it');
    expect(hostGroupTitle(null, 4, 'mystery_code')).toBe('Unknown site: 4 jobs, mystery code');
  });
});
