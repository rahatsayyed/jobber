import { describe, it, expect } from 'vitest';
import { cleanJobTitle } from '../src/lib/jobTitle.js';
import { openDb, saveJob } from '../src/db.js';
import { parseJobCards } from '../src/linkedin/searchJobs.js';

describe('cleanJobTitle', () => {
  it('strips the verified badge text', () => {
    expect(cleanJobTitle('Senior Engineer - Remote with verification')).toBe('Senior Engineer - Remote');
    expect(cleanJobTitle('Staff Engineer, Security with verification')).toBe('Staff Engineer, Security');
    expect(cleanJobTitle('Dev With Verification')).toBe('Dev');
  });
  it('collapses a doubled title', () => {
    expect(cleanJobTitle('Backend Engineer Backend Engineer')).toBe('Backend Engineer');
    expect(cleanJobTitle('Backend Engineer with verification Backend Engineer')).toBe('Backend Engineer');
  });
  it('leaves normal titles alone', () => {
    expect(cleanJobTitle('Full Stack Developer')).toBe('Full Stack Developer');
    expect(cleanJobTitle(null)).toBe('');
  });
});

describe('badge text never reaches the saved title', () => {
  it('parseJobCards cleans the title', () => {
    const r = parseJobCards({ jobCards: [{ title: 'React Dev with verification', company: 'Acme', href: '/jobs/view/4485686194/', snippet: 's', easyApply: false }] } as any, 10);
    expect(r.jobs[0]!.title).toBe('React Dev');
  });
  it('saveJob cleans the title and keeps the key in step', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'li-job:1', source: 'linkedin-jobs', title: 'React Dev with verification', company: 'Acme', url: 'https://x', apply_url: 'https://x', description: 'd' } as any);
    const row = db.prepare('SELECT title, title_key FROM jobs WHERE id = ?').get('li-job:1') as any;
    expect(row.title).toBe('React Dev');
    expect(row.title_key).toBe('dev react');
  });
});
