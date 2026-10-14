import { describe, it, expect } from 'vitest';
import { openDb, saveJob, sweepDeadlines, unexcludeJob, getExcludedReason, getFirstHardStop } from '../src/db.js';
import { jobFactsFromDb } from '../src/gateFacts.js';
import { vetoResults } from '../src/vetoes.js';

const long = 'We build developer tools with React and TypeScript for teams across India and remote. '.repeat(5);
const now = new Date('2026-10-12T00:00:00Z');
const langs = { declared: [{ language: 'English', level: 'fluent' as const }], confirmed: true };

function setup() {
  const db = openDb(':memory:');
  for (const id of ['a', 'b']) {
    saveJob(db, { id, source: 'naukri', title: 'Dev', company: 'Co', url: `https://example.test/${id}`, apply_url: 'https://boards.greenhouse.io/a/jobs/1', description: long });
    db.prepare("UPDATE jobs SET deadline = '2026-10-01', score = 80 WHERE id = ?").run(id);
  }
  return db;
}

describe('a manual un-exclude is a durable override (round 2, I3 follow-up)', () => {
  it('sweep excludes, unexclude, sweep again: still not excluded; a job without a log row is still swept', () => {
    const db = setup();
    expect(sweepDeadlines(db, now).expired.map((e) => e.job_id).sort()).toEqual(['a', 'b']);
    expect(unexcludeJob(db, 'a').ok).toBe(true);
    const again = sweepDeadlines(db, now);
    expect(again.expired).toEqual([]); // a is overridden, b is already excluded
    expect(getExcludedReason(db, 'a')).toBeNull();
    expect(getExcludedReason(db, 'b')).toBe('deadline passed: 2026-10-01');
  });
  it('a different never-excluded job without a log row is still swept after another job was overridden', () => {
    const db = setup();
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-10-01' WHERE id = 'a'").run();
    expect(unexcludeJob(db, 'a').ok).toBe(true);
    sweepDeadlines(db, now);
    expect(getExcludedReason(db, 'a')).toBeNull();
    expect(getExcludedReason(db, 'b')).toBe('deadline passed: 2026-10-01');
  });
  it('apply_vetoes deadline rule is skipped for an overridden job but not for others', () => {
    const db = setup();
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-10-01' WHERE id = 'a'").run();
    unexcludeJob(db, 'a');
    const facts = new Map(['a', 'b'].map((id) => [id, jobFactsFromDb(db, id)]));
    const out = vetoResults([{ job_id: 'a', score: 80 }, { job_id: 'b', score: 80 }],
      ['a', 'b'].map((id) => ({ id, title: 'Dev', description: long })), [], { facts, now, languages: langs });
    expect(out.map((o) => [o.job_id, o.excluded])).toEqual([['a', false], ['b', true]]);
  });
});

describe('getFirstHardStop fails closed on any non-string item (round 2 minor)', () => {
  const mk = (v: string) => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j', source: 't', title: 'D', company: 'C', url: 'u', apply_url: 'u', description: 'd' });
    db.prepare("UPDATE jobs SET hard_stops = ? WHERE id = 'j'").run(v);
    return db;
  };
  it.each(['[1]', '["Go", 2]', '[null]', '[{"a":1}]'])('%s is unreadable', (v) => {
    expect(getFirstHardStop(mk(v), 'j')).toBe('unreadable hard_stops data');
  });
  it('valid arrays still work', () => {
    expect(getFirstHardStop(mk('["Go"]'), 'j')).toBe('Go');
    expect(getFirstHardStop(mk('[]'), 'j')).toBeNull();
  });
});
