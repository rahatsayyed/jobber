import { describe, it, expect } from 'vitest';
import { openDb, saveJob, saveMatchResultsChecked } from '../src/db.js';
import { hardStops, normalizeMatchRow, normalizeRequirements, type Requirement } from '../src/score.js';

const desc = 'We need 3+ years of React. Strong TypeScript required. Kubernetes is a plus. Must be based in India.';
const dims = { skills: 20, seniority: 18, domain: 12, location: 25 };
// default table: one stated-and-met critical row, so the evidence ceiling does not bite (empty-table ceiling is covered in scoreCeiling.test.ts)
const okReqs = [{ req: 'React', importance: 'critical', evidence: 'stated', jd_quote: '3+ years of React', match: 'strong' }];
const row = (over: any = {}) => ({ job_id: 'j1', score: 1, reasons: 'r', missing_keywords: [], score_dims: dims, requirements: okReqs, ...over });

describe('normalizeRequirements', () => {
  it('caps inferred evidence below critical/high and demotes an unverifiable quote', () => {
    const reqs: Requirement[] = [
      { req: 'React', importance: 'critical', evidence: 'stated', jd_quote: '3+ years of React', match: 'strong' },
      { req: 'Go', importance: 'high', evidence: 'inferred', jd_quote: null, match: 'missing' },
      { req: 'GraphQL', importance: 'critical', evidence: 'stated', jd_quote: 'GraphQL expertise', match: 'missing' },
    ];
    const out = normalizeRequirements(reqs, desc);
    expect(out.find((r) => r.req === 'Go')).toMatchObject({ importance: 'meaningful', evidence: 'inferred' });
    expect(out.find((r) => r.req === 'GraphQL')).toMatchObject({ evidence: 'structural' }); // quote not in the posting
    expect(out.find((r) => r.req === 'React')).toMatchObject({ evidence: 'stated' });
  });
  it('sorts by importance then unmet first, keeps <=12 but never drops critical/high', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ req: `p${i}`, importance: 'preferred', evidence: 'structural', jd_quote: null, match: 'strong' }));
    const reqs = [...many, { req: 'late-critical', importance: 'critical', evidence: 'structural', jd_quote: null, match: 'partial' }];
    const out = normalizeRequirements(reqs, desc);
    expect(out[0].req).toBe('late-critical');
    expect(out).toHaveLength(12);
  });
  it('drops malformed rows and defaults unknown enums safely', () => {
    expect(normalizeRequirements([null, { req: '  ' }, { req: 'x', importance: 'huge', evidence: 'vibes', match: '??' }], desc)).toEqual([
      { req: 'x', importance: 'meaningful', evidence: 'inferred', jd_quote: null, match: 'missing' },
    ]);
    expect(normalizeRequirements('nope', desc)).toEqual([]);
  });
  it('checks quotes against raw HTML text too (tags and numeric entities do not break a real quote)', () => {
    const html = '<ul><li>Strong TypeScript required</li><li>You&#8217;ll own the React app</li></ul>';
    const out = normalizeRequirements([
      { req: 'TypeScript', importance: 'critical', evidence: 'stated', jd_quote: 'Strong TypeScript required', match: 'strong' },
      { req: 'React', importance: 'high', evidence: 'stated', jd_quote: 'You’ll own the React app', match: 'strong' },
    ], html);
    expect(out.map((r) => r.evidence)).toEqual(['stated', 'stated']);
  });
  it('keeps a valid category and drops an unknown one', () => {
    const out = normalizeRequirements([
      { req: 'on-site Bengaluru', importance: 'critical', evidence: 'structural', jd_quote: null, match: 'missing', category: 'location' },
      { req: 'x', importance: 'preferred', evidence: 'structural', jd_quote: null, match: 'strong', category: 'vibes' },
    ], desc);
    expect(out.find((r) => r.req === 'on-site Bengaluru')!.category).toBe('location');
    expect('category' in out.find((r) => r.req === 'x')!).toBe(false);
  });
});

describe('hardStops', () => {
  it('only critical + missing + stated (AE1: structural and inferred rows never create a hard stop)', () => {
    expect(hardStops([
      { req: 'A', importance: 'critical', evidence: 'stated', jd_quote: 'q', match: 'missing' },
      { req: 'B', importance: 'critical', evidence: 'structural', jd_quote: null, match: 'partial' },
      { req: 'D', importance: 'critical', evidence: 'structural', jd_quote: null, match: 'missing' },
      { req: 'E', importance: 'critical', evidence: 'inferred', jd_quote: null, match: 'missing' },
      { req: 'C', importance: 'high', evidence: 'stated', jd_quote: 'q', match: 'missing' },
    ])).toEqual(['A']);
  });
  it('never a location or language row (dedicated gates own those), by category or by wording', () => {
    const miss = (req: string, category?: any): Requirement =>
      ({ req, importance: 'critical', evidence: 'stated', jd_quote: 'q', match: 'missing', ...(category ? { category } : {}) });
    expect(hardStops([
      miss('on-site Bengaluru'), miss('Relocate to Berlin'), miss('fluent German'), miss('Hindi'), miss('anything', 'location'), miss('anything else', 'language'),
      miss('Go (5+ years)', 'skill'), miss('Kubernetes'),
    ])).toEqual(['Go (5+ years)', 'Kubernetes']);
  });
});

describe('normalizeMatchRow', () => {
  it('computes score from dims (code wins over the model)', () => {
    const r = normalizeMatchRow(row({ score: 99 }), desc);
    expect(r.ok && r.row.score).toBe(75);
  });
  it.each([[26], [-1], [12.5], ['20'], [Number.NaN], [true]])('rejects invalid dim %s', (bad) => {
    const r = normalizeMatchRow(row({ score_dims: { ...dims, skills: bad } }), desc);
    expect(r).toEqual({ ok: false, error: `invalid score_dims.skills: ${String(bad)}` });
  });
  // Changed deliberately (final review M1): a legacy row without dims used to be accepted with its own score; now only an expired row is.
  it('a row without dims is accepted only as an expired row (score 0); any other score is "missing score_dims"', () => {
    const r = normalizeMatchRow({ job_id: 'j', score: 0, reasons: 'expired', missing_keywords: [] }, desc);
    expect(r.ok && r.row.score).toBe(0);
    expect(normalizeMatchRow({ job_id: 'j', score: 72.5, reasons: '', missing_keywords: [] }, desc)).toEqual({ ok: false, error: 'missing score_dims' });
    expect(normalizeMatchRow({ job_id: 'j', score: 101, reasons: '', missing_keywords: [] }, desc)).toEqual({ ok: false, error: 'missing score_dims' });
  });
  it('caps strengths/gaps at 3, stores them verbatim, keeps deadline as given', () => {
    const r = normalizeMatchRow(row({ strengths: ['a', ' b ', 'c', 'd'], gaps: ['<script>x</script>'], deadline: 'ASAP' }), desc);
    expect(r.ok && r.row.strengths).toEqual(['a', 'b', 'c']);
    expect(r.ok && r.row.gaps).toEqual(['<script>x</script>']);
    expect(r.ok && r.row.deadline).toBe('ASAP');
  });
  it('confidence: low without requirements or with a thin posting', () => {
    expect((normalizeMatchRow(row(), desc) as any).row.confidence).toBe('low');
  });
  it('rejects a row with neither dims nor a numeric score, and sanitizes loose enum/text fields instead of failing', () => {
    expect(normalizeMatchRow({ job_id: 'j', reasons: 'r', missing_keywords: [] } as any, desc)).toEqual({ ok: false, error: 'missing score_dims' });
    const r = normalizeMatchRow(row({ reasons: 42, missing_keywords: 'x', location_verdict: 'medium', language_gate: 'PASS' }), desc);
    expect(r.ok && [r.row.reasons, r.row.missing_keywords, r.row.location_verdict, r.row.language_gate]).toEqual(['', [], undefined, 'PASS']);
  });
});

describe('saveMatchResultsChecked', () => {
  const setup = () => {
    const db = openDb(':memory:');
    for (const id of ['j1', 'j2']) saveJob(db, { id, source: 'test', title: 'Dev', company: 'Acme', url: 'u', apply_url: 'u', description: desc });
    return db;
  };
  it('writes valid rows, reports invalid ones, leaves invalid rows untouched', () => {
    const db = setup();
    const out = saveMatchResultsChecked(db, [row({ job_id: 'j1', strengths: ['React'] }), row({ job_id: 'j2', score_dims: { ...dims, domain: 30 } })]);
    expect(out.saved).toBe(1);
    expect(out.errors).toEqual([{ job_id: 'j2', error: 'invalid score_dims.domain: 30' }]);
    const j1 = db.prepare('SELECT * FROM jobs WHERE id = ?').get('j1') as any;
    expect(j1.score).toBe(75);
    expect(JSON.parse(j1.score_dims)).toEqual(dims);
    expect(JSON.parse(j1.strengths)).toEqual(['React']);
    expect((db.prepare('SELECT score FROM jobs WHERE id = ?').get('j2') as any).score).toBeNull();
  });
  it('a null deadline never erases a stored one', () => {
    const db = setup();
    saveMatchResultsChecked(db, [row({ deadline: '2026-11-01' })]);
    saveMatchResultsChecked(db, [row({ deadline: null })]);
    expect((db.prepare('SELECT deadline FROM jobs WHERE id = ?').get('j1') as any).deadline).toBe('2026-11-01');
  });
  it('returns hard stops for rows that have them', () => {
    const db = setup();
    const reqs = [{ req: 'React', importance: 'critical', evidence: 'stated', jd_quote: '3+ years of React', match: 'missing' }];
    expect(saveMatchResultsChecked(db, [row({ requirements: reqs })]).hard_stops).toEqual([{ job_id: 'j1', hard_stops: ['React'] }]);
  });
  it('a critical missing location row is not a hard stop', () => {
    const db = setup();
    const reqs = [{ req: 'on-site Bengaluru', importance: 'critical', evidence: 'stated', jd_quote: 'Must be based in India', match: 'missing', category: 'location' }];
    expect(saveMatchResultsChecked(db, [row({ requirements: reqs })]).hard_stops).toEqual([]);
  });
  it('a {job_id, error} overflow row is reported in errors and does not fail the other rows', () => {
    const db = setup();
    const out = saveMatchResultsChecked(db, [row({ job_id: 'j1' }), { job_id: 'j2', error: 'batch over 5; resend in a new batch' } as any]);
    expect(out.saved).toBe(1);
    expect(out.errors).toEqual([{ job_id: 'j2', error: 'batch over 5; resend in a new batch' }]);
  });
  it('verifies quotes against description plus the stored snapshot', () => {
    const db = setup();
    db.prepare("UPDATE jobs SET jd_snapshot = ? WHERE id = 'j1'").run('Full page text. We also need GraphQL expertise. ' + 'x'.repeat(300));
    const reqs = [
      { req: 'GraphQL', importance: 'critical', evidence: 'stated', jd_quote: 'GraphQL expertise', match: 'strong' },
      { req: 'React', importance: 'critical', evidence: 'stated', jd_quote: '3+ years of React', match: 'strong' },
    ];
    saveMatchResultsChecked(db, [row({ requirements: reqs })]);
    const stored = JSON.parse((db.prepare("SELECT requirements FROM jobs WHERE id = 'j1'").get() as any).requirements);
    expect(stored.map((r: any) => r.evidence)).toEqual(['stated', 'stated']);
  });
});
