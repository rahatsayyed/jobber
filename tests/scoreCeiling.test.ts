import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { openDb, saveJob, saveMatchResultsChecked } from '../src/db.js';
import { normalizeMatchRow, normalizeRequirements, hardStops } from '../src/score.js';
import { handleSaveMatchResults, matchResultsInputShape } from '../src/matchTool.js';

const desc = 'We need 3+ years of React. Strong TypeScript required. Kubernetes is a plus. Must be based in India.';
const dims = { skills: 20, seniority: 18, domain: 12, location: 25 }; // sum 75
const full = { skills: 25, seniority: 25, domain: 25, location: 25 };
const Q1 = '3+ years of React';
const Q2 = 'Strong TypeScript required';
const req = (importance: string, evidence: string, match: string, quote: string | null = null, name = `r-${Math.random()}`) =>
  ({ req: name, importance, evidence, jd_quote: quote, match });
const run = (d: any, reqs: any[]) => {
  const r = normalizeMatchRow({ job_id: 'j', score: 1, reasons: '', missing_keywords: [], score_dims: d, requirements: reqs } as any, desc);
  if (!r.ok) throw new Error(r.error);
  return r.row;
};

describe('evidence ceiling caps the score (dims 20/18/12/25 = 75 unless stated)', () => {
  it('1. all required met, stated: score = dims sum', () => {
    const x = run(dims, [req('critical', 'stated', 'strong', Q1), req('high', 'stated', 'strong', Q2)]);
    expect([x.score, x.score_cap_reason]).toEqual([75, null]);
  });
  it('2. a critical stated requirement missing: ceiling 69', () => {
    const x = run(dims, [req('critical', 'stated', 'missing', Q1), req('meaningful', 'stated', 'strong', Q2)]);
    expect([x.score, x.score_cap_reason]).toEqual([69, 'evidence-ceiling:69']);
  });
  it('3. all inferred and met cannot exceed 75 (even with dims 100)', () => {
    const rs = [req('meaningful', 'inferred', 'strong'), req('critical', 'inferred', 'strong')];
    expect(run(dims, rs).score).toBe(75);
    const x = run(full, rs);
    expect([x.score, x.score_cap_reason]).toEqual([75, 'evidence-ceiling:75']);
  });
  it('4. mixed tiers and partial matches: ceiling 74', () => {
    const x = run(dims, [req('critical', 'structural', 'partial'), req('high', 'stated', 'partial', Q1), req('meaningful', 'stated', 'missing', Q2)]);
    expect([x.score, x.score_cap_reason]).toEqual([74, 'evidence-ceiling:74']);
  });
  it('5. empty table: ceiling 70 and confidence low', () => {
    const x = run(dims, []);
    expect([x.score, x.score_cap_reason, x.confidence]).toEqual([70, 'empty-table:70', 'low']);
  });
  it('6. duplicate ids in one batch: first wins, second is an error and not counted', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: desc });
    const mk = (d: any) => ({ job_id: 'j1', reasons: 'r', missing_keywords: [], score_dims: d, requirements: [req('critical', 'stated', 'strong', Q1)] });
    const out = saveMatchResultsChecked(db, [mk(dims), mk({ ...dims, skills: 5 })] as any);
    expect(out).toMatchObject({ saved: 1, errors: [{ job_id: 'j1', error: 'duplicate job_id' }], hard_stops: [], injection_suspects: [], scores: [{ job_id: 'j1', score: 75 }] });
    expect((db.prepare("SELECT score FROM jobs WHERE id = 'j1'").get() as any).score).toBe(75);
  });
  it('7. dims 25/25/25/25 with all stated and met: 100; with an empty table: 70', () => {
    expect(run(full, [req('critical', 'stated', 'strong', Q1)]).score).toBe(100);
    expect(run(full, []).score).toBe(70);
  });
  it('8. unknown importance defaults to meaningful (stated + missing => ceiling 59)', () => {
    const x = run(dims, [req('huge', 'stated', 'missing', Q1)]);
    expect([x.score, x.score_cap_reason]).toEqual([59, 'evidence-ceiling:59']);
  });
  it('only low-importance rows count as no weighted evidence (70)', () => {
    const x = run(dims, [req('preferred', 'stated', 'strong', Q1)]);
    expect([x.score, x.score_cap_reason]).toEqual([70, 'no-weighted-rows:70']);
  });
  // Changed deliberately (final review M1): a legacy row without dims is no longer accepted uncapped; only an expired row is.
  it('legacy rows without dims are rejected unless expired; the cap reason is stored for dims rows', () => {
    expect(normalizeMatchRow({ job_id: 'j', score: 90, reasons: '', missing_keywords: [] }, desc)).toEqual({ ok: false, error: 'missing score_dims' });
    const l = normalizeMatchRow({ job_id: 'j', score: 0, reasons: 'expired', missing_keywords: [] }, desc);
    expect(l.ok && [l.row.score, l.row.score_cap_reason]).toEqual([0, null]);
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: desc });
    saveMatchResultsChecked(db, [{ job_id: 'j1', reasons: '', missing_keywords: [], score_dims: dims, requirements: [] } as any]);
    expect((db.prepare("SELECT score, score_cap_reason FROM jobs WHERE id = 'j1'").get() as any)).toEqual({ score: 70, score_cap_reason: 'empty-table:70' });
  });
});

describe('quote length rules', () => {
  const ev = (quote: string, d = desc) => normalizeRequirements([req('critical', 'stated', 'strong', quote, 'x')], d)[0];
  it('a one-char and an 11-char quote downgrade to structural; a 12-char quote stays stated', () => {
    expect(ev('a').evidence).toBe('structural');
    expect(ev('Strong Type').evidence).toBe('structural'); // 11 chars, present in the posting
    expect(ev('Strong Types').evidence).toBe('stated'); // 12 chars
  });
  it('a 5000-char quote is stored truncated to 300 and checked on its first 300 chars', () => {
    const first = 'We need many things including react and typescript and node. '.repeat(6).slice(0, 300);
    const out = ev(first + 'y'.repeat(4700), `Intro. ${first} Outro.`);
    expect(out.jd_quote).toHaveLength(300);
    expect(out.evidence).toBe('stated');
    expect(ev('z'.repeat(5000), desc)).toMatchObject({ evidence: 'structural' });
  });
});

describe('per-row batch handling', () => {
  const setup = () => {
    const db = openDb(':memory:');
    for (const id of ['j1', 'j2']) saveJob(db, { id, source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: desc });
    return db;
  };
  const good = (id: string) => ({ job_id: id, reasons: 'r', missing_keywords: [], score_dims: dims, requirements: [req('critical', 'stated', 'strong', Q1)] });
  it('an unknown job_id is an error and not saved', () => {
    const out = saveMatchResultsChecked(setup(), [good('nope'), good('j1')] as any);
    expect(out.saved).toBe(1);
    expect(out.errors).toEqual([{ job_id: 'nope', error: 'unknown job_id' }]);
  });
  it('an error row followed by a valid row for the same id: first wins, later is a duplicate error', () => {
    const db = setup();
    const out = saveMatchResultsChecked(db, [{ job_id: 'j1', error: 'batch over 5' }, good('j1')] as any);
    expect(out).toEqual({ saved: 0, errors: [{ job_id: 'j1', error: 'batch over 5' }, { job_id: 'j1', error: 'duplicate job_id' }], hard_stops: [], injection_suspects: [], scores: [] });
    expect((db.prepare("SELECT score FROM jobs WHERE id = 'j1'").get() as any).score).toBeNull();
  });
  it('an error row is any row with a string error, even when it carries a score', () => {
    const db = setup();
    const out = saveMatchResultsChecked(db, [{ ...good('j1'), score: 90, error: 'matcher gave up' }] as any);
    expect(out.saved).toBe(0);
    expect(out.errors).toEqual([{ job_id: 'j1', error: 'matcher gave up' }]);
  });
  it('null rows and rows without a string job_id are rejected per row, by the tool too', () => {
    const db = setup();
    const args = z.object(matchResultsInputShape).parse({ results: [null, { score: 5 }, { job_id: 7 }, good('j2')] });
    const out = JSON.parse(handleSaveMatchResults(db, args).content[0].text);
    expect(out.saved).toBe(1);
    expect(out.errors).toEqual([
      { job_id: '', error: 'invalid row: missing string job_id' },
      { job_id: '', error: 'invalid row: missing string job_id' },
      { job_id: '7', error: 'invalid row: missing string job_id' },
    ]);
  });
  it('hard stops are deduped by requirement text', () => {
    const r = (n: string) => ({ req: n, importance: 'critical', evidence: 'stated', jd_quote: 'q', match: 'missing' } as any);
    expect(hardStops([r('React'), r('React'), r('Go')])).toEqual(['React', 'Go']);
  });
});
