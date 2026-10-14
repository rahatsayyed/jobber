import { describe, it, expect } from 'vitest';
import { openDb, saveJob } from '../src/db.js';
import { jobFactsFromDb } from '../src/gateFacts.js';
import { vetoResults } from '../src/vetoes.js';

const long = 'We build developer tools with React and TypeScript for teams across India and remote. '.repeat(5);
const now = new Date('2026-10-12T00:00:00Z');
const langs = { declared: [{ language: 'English', level: 'fluent' as const }], confirmed: true };

function setup(deadline: string | null) {
  const db = openDb(':memory:');
  saveJob(db, { id: 'naukri:240926037182', source: 'naukri', title: 'React Developer', company: 'Acme', url: 'https://naukri.example/1', apply_url: 'https://boards.greenhouse.io/a/jobs/1', description: long, posted_at: '2026-09-28' });
  db.prepare("UPDATE jobs SET deadline = ?, score = 80 WHERE id = 'naukri:240926037182'").run(deadline);
  return db;
}
const run = (db: ReturnType<typeof openDb>, score = 80) => {
  const facts = new Map([['naukri:240926037182', jobFactsFromDb(db, 'naukri:240926037182')]]);
  return vetoResults([{ job_id: 'naukri:240926037182', score }], [{ id: 'naukri:240926037182', title: 'React Developer', description: long }], [], { facts, now, languages: langs })[0];
};

describe('apply_vetoes excludes a job whose deadline already passed (final review I2)', () => {
  it('naukri-style job with deadline 2026-10-01 on 2026-10-12 is excluded in the first run', () => {
    const r = run(setup('2026-10-01'));
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe('deadline passed: 2026-10-01');
  });
  it('a deadline today or in the future is not excluded', () => {
    expect(run(setup('2026-10-12')).excluded).toBe(false);
    expect(run(setup('2026-10-20')).excluded).toBe(false);
  });
  it('a non-ISO or null deadline is not a veto', () => {
    expect(run(setup('rolling')).excluded).toBe(false);
    expect(run(setup(null)).excluded).toBe(false);
  });
  it('a contacted job (sent email) is not excluded by a passed deadline', () => {
    const db = setup('2026-10-01');
    db.prepare("INSERT INTO outreach_queue (job_id, email_status) VALUES ('naukri:240926037182', 'sent')").run();
    expect(run(db).excluded).toBe(false);
  });
  it('a submitted application or a sent connect also protects the job', () => {
    const a = setup('2026-10-01');
    a.prepare("INSERT INTO applications (job_id, status) VALUES ('naukri:240926037182', 'submitted')").run();
    expect(run(a).excluded).toBe(false);
    const c = setup('2026-10-01');
    c.prepare("INSERT INTO outreach_queue (job_id, connect_status) VALUES ('naukri:240926037182', 'sent')").run();
    expect(run(c).excluded).toBe(false);
  });
  it('a queued-only or failed row does not protect it', () => {
    const db = setup('2026-10-01');
    db.prepare("INSERT INTO outreach_queue (job_id, email_status) VALUES ('naukri:240926037182', 'failed')").run();
    expect(run(db).reason).toBe('deadline passed: 2026-10-01');
  });
});
