import { describe, it, expect } from 'vitest';
import { openDb, saveJob } from '../src/db.js';
import { withStoredDescriptions } from '../src/gateFacts.js';

const long = 'We build developer tools with React and TypeScript for teams across India and remote. '.repeat(5);

function setup() {
  const db = openDb(':memory:');
  saveJob(db, { id: 'gh:a:1', source: 'greenhouse', title: 'React Developer', company: 'Acme', url: 'https://example.test/1', apply_url: 'https://boards.greenhouse.io/a/jobs/1', description: long, posted_at: '2026-10-01' });
  return db;
}

describe('apply_vetoes falls back to the stored description', () => {
  it('fills an empty, blank, null or missing description from the jobs table', () => {
    const db = setup();
    const out = withStoredDescriptions(db, [
      { id: 'gh:a:1', title: 'React Developer', description: '' },
      { id: 'gh:a:1', title: 'React Developer', description: '   ' },
      { id: 'gh:a:1', title: 'React Developer', description: null },
      { id: 'gh:a:1', title: 'React Developer' },
    ]);
    for (const j of out) expect(j.description).toBe(long);
  });

  it('keeps a description the caller passed', () => {
    const db = setup();
    const [j] = withStoredDescriptions(db, [{ id: 'gh:a:1', title: 'React Developer', description: 'caller text' }]);
    expect(j.description).toBe('caller text');
  });

  it('leaves an unknown job as it was', () => {
    const db = setup();
    const [j] = withStoredDescriptions(db, [{ id: 'nope', title: 'X', description: '' }]);
    expect(j.description).toBe('');
  });
});
