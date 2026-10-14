import { describe, it, expect } from 'vitest';
import { applyVetoes, vetoResults } from '../src/vetoes.js';
import { openDb, saveGateResults, saveJob, saveMatchResultsChecked } from '../src/db.js';
import { jobFactsFromDb } from '../src/gateFacts.js';

const long = 'We build developer tools with React and TypeScript for teams across India and remote. '.repeat(5);
const job = { title: 'React Developer', description: long };
const now = new Date('2026-10-08T00:00:00Z');
const langs = { declared: [{ language: 'English', level: 'fluent' as const }], confirmed: true };
const facts = { source: 'remotive', url: 'https://remotive.com/1', apply_url: 'https://boards.greenhouse.io/a/jobs/1', posted_at: '2026-10-01', hard_stops: [], repost_count: 0, snapshot_chars: 0 };

describe('applyVetoes with extras', () => {
  it('passes a clean job with legitimacy attached', () => {
    expect(applyVetoes({ job_id: 'a', score: 70 }, job, [], { facts, now, languages: langs })).toEqual({ excluded: false, flags: [], legitimacy: { tier: 'high', signals: [] }, language_note: null });
  });
  it('TS language FAIL excludes even when the model said PASS, with the quote', () => {
    const r = applyVetoes({ job_id: 'a', score: 90, language_gate: 'PASS' }, { ...job, description: `${long} Fluent German is required.` }, [], { facts, now, languages: langs });
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe('language FAIL: requires German (fluent): "Fluent German is required."');
  });
  it('while languages.json is unconfirmed a required undeclared language only flags', () => {
    const r = applyVetoes({ job_id: 'a', score: 90 }, { ...job, description: `${long} Fluent German is required.` }, [], { facts, now, languages: { ...langs, confirmed: false } });
    expect(r.excluded).toBe(false);
    expect(r.flags).toEqual(['language FLAG: unconfirmed languages.json: requires German (fluent): "Fluent German is required."']);
  });
  it('a missing languages.json raises a flag instead of silently skipping the gate', () => {
    const r = applyVetoes({ job_id: 'a', score: 90 }, job, [], { facts, now, languages: null });
    expect(r.excluded).toBe(false);
    expect(r.flags).toEqual(['language gate config missing']);
    expect(applyVetoes({ job_id: 'a', score: 90 }, job, [], { facts, now }).flags).toEqual([]);
  });
  it('a hard stop excludes', () => {
    expect(applyVetoes({ job_id: 'a', score: 80 }, job, [], { facts: { ...facts, hard_stops: ['Go (5+ years)'] }, now, languages: langs }).reason).toBe('hard stop: Go (5+ years)');
  });
  it('suspicious legitimacy excludes, caution only flags', () => {
    expect(applyVetoes({ job_id: 'a', score: 80 }, { ...job, description: `${long} Pay a registration fee to start.` }, [], { facts, now, languages: langs }).reason).toBe('legitimacy: asks the applicant for a fee or deposit');
    const c = applyVetoes({ job_id: 'a', score: 80 }, job, [], { facts: { ...facts, repost_count: 3 }, now, languages: langs });
    expect(c.excluded).toBe(false);
    expect(c.flags).toEqual(['legitimacy caution: reposted 3 times in 90 days on the same board']);
  });
  it('stale postings are flagged, never excluded', () => {
    const r = applyVetoes({ job_id: 'a', score: 80 }, job, [], { facts: { ...facts, posted_at: '2026-08-01' }, now, languages: langs });
    expect(r.excluded).toBe(false);
    expect(r.flags).toEqual(['stale: posted 68 days ago', 'legitimacy caution: posted 68 days ago']);
  });
  it('without extras the result shape is unchanged', () => {
    expect(applyVetoes({ job_id: 'a', score: 70, language_gate: 'FLAG' }, job, [])).toEqual({ excluded: false, flags: ['language FLAG'] });
  });
});

describe('vetoResults ctx + db facts', () => {
  it('reads hard stops and dates from the db and persists gate results', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 'remotive', title: 'React Developer', company: 'Acme', url: 'https://remotive.com/1', apply_url: 'https://boards.greenhouse.io/a/jobs/1', description: long, posted_at: '2026-10-01' });
    saveMatchResultsChecked(db, [{ job_id: 'j1', score: 0, reasons: '', missing_keywords: [], score_dims: { skills: 20, seniority: 20, domain: 10, location: 25 },
      // AE1: a hard stop needs a verified stated quote (this row was structural before AE1, which no longer creates one).
      requirements: [{ req: 'Go', importance: 'critical', evidence: 'stated', jd_quote: 'We build developer tools', match: 'missing' }] } as any]);
    const f = jobFactsFromDb(db, 'j1');
    expect(f).toEqual({ source: 'remotive', url: 'https://remotive.com/1', apply_url: 'https://boards.greenhouse.io/a/jobs/1', posted_at: '2026-10-01', deadline: null, acted: false, overridden: false, hard_stops: ['Go'], repost_count: 0, snapshot_chars: 0 });
    const out = vetoResults([{ job_id: 'j1', score: 75 }], [{ id: 'j1', title: 'React Developer', description: long }], [], { facts: new Map([['j1', f]]), now, languages: langs });
    expect(out[0]).toMatchObject({ job_id: 'j1', excluded: true, reason: 'hard stop: Go' });
    expect(saveGateResults(db, out)).toBe(1);
    expect((db.prepare("SELECT legitimacy, gate_flags FROM jobs WHERE id = 'j1'").get() as any)).toEqual({ legitimacy: 'high', gate_flags: '[]' });
  });
});

describe('fix round 1 (AD1)', () => {
  const mk = () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 'remotive', title: 'React Developer', company: 'Acme', url: 'https://remotive.com/1', apply_url: 'https://boards.greenhouse.io/a/jobs/1', description: long, posted_at: '2026-10-01' });
    return db;
  };
  const run = (db: any, languages: any = langs, extra: any = {}) =>
    vetoResults([{ job_id: 'j1', score: 75 }], [{ id: 'j1', title: 'React Developer', description: long }], [], { facts: new Map([['j1', jobFactsFromDb(db, 'j1')]]), now, languages, ...extra });

  it.each(['{bad json', '"Go"', '5', '{"a":1}'])('corrupt or non-array hard_stops %s excludes (fail closed)', (bad) => {
    const db = mk();
    db.prepare("UPDATE jobs SET hard_stops = ? WHERE id = 'j1'").run(bad);
    expect(run(db)[0]).toMatchObject({ excluded: true, reason: 'gate data unreadable: hard_stops' });
  });
  it.each([null, '', '[]'])('hard_stops %j means no hard stops', (ok) => {
    const db = mk();
    db.prepare("UPDATE jobs SET hard_stops = ? WHERE id = 'j1'").run(ok);
    expect(run(db)[0]).toMatchObject({ excluded: false, flags: [] });
  });
  it('null config combined with an exclusion still excludes and keeps the flag in gate_flags', () => {
    const db = mk();
    db.prepare("UPDATE jobs SET hard_stops = '[\"Go\"]' WHERE id = 'j1'").run();
    const out = run(db, null);
    expect(out[0]).toMatchObject({ excluded: true, reason: 'hard stop: Go', flags: [], gate_flags: ['language gate config missing'] });
    saveGateResults(db, out);
    expect((db.prepare("SELECT gate_flags FROM jobs WHERE id = 'j1'").get() as any).gate_flags).toBe('["language gate config missing"]');
  });
  it('invalid config entry is distinguished from a missing file', () => {
    const db = mk();
    expect(run(db, null, { languagesInvalid: '{"language":"","level":"x"}' })[0].flags).toEqual(['language gate config invalid: {"language":"","level":"x"}']);
  });
  it('stale flag survives an exclusion in gate_flags', () => {
    const db = mk();
    db.prepare("UPDATE jobs SET hard_stops = '[\"Go\"]', posted_at = '2026-08-01' WHERE id = 'j1'").run();
    expect(run(db)[0].gate_flags).toEqual(['stale: posted 68 days ago', 'legitimacy caution: posted 68 days ago']);
  });
  it('second saveGateResults is idempotent and never touches excluded_reason', () => {
    const db = mk();
    db.prepare("UPDATE jobs SET excluded_reason = 'manual' WHERE id = 'j1'").run();
    const out = run(db);
    saveGateResults(db, out);
    const a = db.prepare("SELECT legitimacy, legitimacy_signals, gate_flags, excluded_reason FROM jobs WHERE id = 'j1'").get();
    expect(saveGateResults(db, out)).toBe(1);
    expect(db.prepare("SELECT legitimacy, legitimacy_signals, gate_flags, excluded_reason FROM jobs WHERE id = 'j1'").get()).toEqual(a);
    expect((a as any).excluded_reason).toBe('manual');
  });
  it('an unknown job id gets no fact-based flags and no legitimacy', () => {
    const db = openDb(':memory:');
    expect(jobFactsFromDb(db, 'nope')).toEqual({});
    const out = vetoResults([{ job_id: 'nope', score: 70 }], [{ id: 'nope', title: 'X', description: null }], [], { facts: new Map([['nope', jobFactsFromDb(db, 'nope')]]), now, languages: langs });
    expect(out[0]).toEqual({ job_id: 'nope', excluded: false, flags: [], legitimacy: undefined, language_note: null });
    expect(saveGateResults(db, out)).toBe(0);
  });
  it('a real row with a null description still gets the thin-description caution', () => {
    const r = applyVetoes({ job_id: 'a', score: 70 }, { title: 'React Developer', description: '' }, [], { facts, now, languages: langs });
    expect(r.legitimacy?.tier).toBe('caution');
  });
});
