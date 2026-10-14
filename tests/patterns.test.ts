import { describe, it, expect } from 'vitest';
import { enqueueOutreach, openDb, recordEmailSent, recordOutcome, saveJob, saveMatchResult } from '../src/db.js';
import { atsVendor, patternStats, remoteBucket, scoreBand, seniority } from '../src/patterns.js';

describe('classifiers', () => {
  it('score band, vendor, remote bucket, seniority', () => {
    expect([scoreBand(null), scoreBand(59), scoreBand(60), scoreBand(79.5), scoreBand(80)]).toEqual(['unscored', '<60', '60-69', '70-79', '80+']);
    expect([atsVendor('https://boards.greenhouse.io/a/jobs/1'), atsVendor('https://jobs.lever.co/a/1'), atsVendor('https://www.linkedin.com/jobs/view/1'), atsVendor('https://x.com'), atsVendor(null)])
      .toEqual(['greenhouse', 'lever', 'linkedin', 'other', 'none']);
    expect(remoteBucket('Fully remote, work from anywhere.')).toBe('remote-global');
    expect(remoteBucket('Remote (US only).')).toBe('remote-restricted');
    expect(remoteBucket('Hybrid, 3 days in our Pune office.')).toBe('hybrid');
    expect(remoteBucket('This is an on-site role in Bengaluru.')).toBe('onsite');
    expect(remoteBucket('We build tools.')).toBe('unknown');
    expect([seniority('Junior React Dev'), seniority('Frontend Engineer'), seniority('Sr. Full Stack Engineer'), seniority('Staff Engineer'), seniority('Tech Lead')]).toEqual(['junior', 'mid', 'senior', 'lead+', 'lead+']);
  });
});

describe('patternStats', () => {
  it('refuses to analyse fewer than 5 contacted jobs', () => {
    const r = patternStats(openDb(':memory:'));
    expect(r).toMatchObject({ contacted: 0, insufficient: true, message: 'Need at least 5 contacted jobs before patterns mean anything (have 0).' });
  });
  it('buckets contacted jobs by latest outcome', () => {
    const db = openDb(':memory:');
    for (let i = 1; i <= 6; i++) {
      saveJob(db, { id: `j${i}`, source: i <= 3 ? 'remotive' : 'adzuna', title: i === 1 ? 'Senior React Dev' : 'React Dev', company: `C${i}`, url: 'u', apply_url: 'https://boards.greenhouse.io/x/jobs/1', description: 'Remote, work from anywhere' });
      saveMatchResult(db, { job_id: `j${i}`, score: 60 + i * 3, reasons: '', missing_keywords: [] });
      const q = enqueueOutreach(db, { job_id: `j${i}`, resume_pdf_path: null, email_subject: 's', email_body: 'b', email_to: `a@c${i}.dev`, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: null, apply_url: null });
      recordEmailSent(db, q, `m${i}`);
    }
    recordOutcome(db, 'j1', 'interview');
    recordOutcome(db, 'j2', 'rejected');
    recordOutcome(db, 'j4', 'replied');
    recordOutcome(db, 'j4', 'rejected');
    const r = patternStats(db);
    expect(r.insufficient).toBe(false);
    expect(r.by.source).toEqual([
      { key: 'adzuna', n: 3, positive: 0, negative: 1, pending: 2, conversion: 0, decided: 0, sufficient: false, note: null },
      { key: 'remotive', n: 3, positive: 1, negative: 1, pending: 1, conversion: 0.333, decided: 0.5, sufficient: false, note: null },
    ]);
    expect(r.by.ats_vendor).toEqual([{ key: 'greenhouse', n: 6, positive: 1, negative: 2, pending: 3, conversion: 0.167, decided: 0.333, sufficient: false, note: null }]);
    expect(r.by.seniority.map((b) => [b.key, b.n])).toEqual([['mid', 5], ['senior', 1]]);
  });
});
