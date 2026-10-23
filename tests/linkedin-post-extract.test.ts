import { describe, it, expect } from 'vitest';
import { openDb, saveJob } from '../src/db.js';
import {
  classifyPost, extractApplyRoute, extractCompany, extractLocation, extractRole, postRefFrom, relativeToIso, splitCardLines,
} from '../src/linkedin/postExtract.js';
import { applyVetoes } from '../src/vetoes.js';
import { jobFactsFromDb } from '../src/gateFacts.js';
import { channelsFor } from '../src/lib/channels.js';
import { fixLinkedinPosts, BAD_EXTRACTION_STATUS } from '../scripts/fix-linkedin-posts.js';

const NOW = new Date('2026-10-16T10:00:00Z');

describe('post permalink', () => {
  it('derives a canonical url and id from feed/update, /posts/ and data-urn, never a profile', () => {
    const want = { id: 'li-post:7123456789012345678', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/' };
    expect(postRefFrom('/feed/update/urn:li:activity:7123456789012345678/?trk=x', '')).toEqual(want);
    expect(postRefFrom('https://www.linkedin.com/posts/jo-demo_hiring-activity-7123456789012345678-aBcD?utm=1', '')).toEqual(want);
    expect(postRefFrom('', 'urn:li:activity:7123456789012345678')).toEqual(want);
    expect(postRefFrom('/in/jo-demo/', '')).toBeNull();
    expect(postRefFrom('https://evil.example.com/feed/update/urn:li:activity:7123456789012345678/', '')).toBeNull();
  });
});

describe('relative time', () => {
  it('computes an absolute day from the fetch time', () => {
    expect(relativeToIso('2d • Edited', NOW)).toBe('2026-10-14');
    expect(relativeToIso('5h', NOW)).toBe('2026-10-16');
    expect(relativeToIso('3w', NOW)).toBe('2026-09-25');
    expect(relativeToIso('1mo', NOW)).toBe('2026-09-16');
    expect(relativeToIso('Promoted', NOW)).toBeNull();
  });
});

describe('classifyPost', () => {
  it('accepts hiring posts that name a role', () => {
    expect(classifyPost('We are hiring a React developer in Pune.').hiring).toBe(true);
    expect(classifyPost('Looking for a backend engineer to join our team. Send your CV to hr@x.example').hiring).toBe(true);
  });
  it('rejects job seekers, non-hiring chatter and role-less promotion', () => {
    expect(classifyPost('#OpenToWork. I am looking for a new role as a React developer.')).toEqual({ hiring: false, reason: 'seeker' });
    expect(classifyPost('If you are hiring a developer, DM me.')).toEqual({ hiring: false, reason: 'seeker' });
    expect(classifyPost('Great weekend hiking with the family.')).toEqual({ hiring: false, reason: 'not_hiring' });
    expect(classifyPost('We are hiring! Watch our brand video.')).toEqual({ hiring: false, reason: 'no_role' });
    expect(classifyPost('Looking for ideas for the weekend').hiring).toBe(false);
  });
});

describe('field extraction', () => {
  it('company: text pattern, then headline, else empty', () => {
    expect(extractCompany('We are hiring at Acme Robotics. React dev.', '')).toEqual({ company: 'Acme Robotics', from: 'text' });
    expect(extractCompany('Brightloom is hiring! Full stack engineer.', 'EM at Other')).toEqual({ company: 'Brightloom', from: 'text' });
    expect(extractCompany('We are hiring a React developer for our team.', 'Talent Partner at Northwind Labs | Hiring')).toEqual({ company: 'Northwind Labs', from: 'headline' });
    expect(extractCompany('We are hiring a React developer.', 'Freelance recruiter')).toEqual({ company: '', from: 'none' });
  });
  it('role: labelled line, phrase, else null', () => {
    expect(extractRole(['Hello', 'Role: Staff Node.js Engineer', 'Pune'])).toBe('Staff Node.js Engineer');
    expect(extractRole(['We are hiring a Senior React Developer at Acme.'])).toBe('Senior React Developer');
    expect(extractRole(['We are hiring, details soon.'])).toBeNull();
  });
  it('location and remote hint', () => {
    expect(extractLocation(['Location: Pune, India'])).toEqual({ location: 'Pune, India', remote: false });
    expect(extractLocation(['Fully remote role.'])).toEqual({ location: '', remote: true });
    expect(extractLocation(['We hire people.'])).toBeNull();
  });
  it('apply route: email and external link only, linkedin links ignored', () => {
    expect(extractApplyRoute('Mail Jobs@Acme.example or https://acme.example/apply.')).toEqual({ email: 'jobs@acme.example', link: 'https://acme.example/apply' });
    expect(extractApplyRoute('see https://www.linkedin.com/jobs/view/1/ and http://plain.example/x')).toEqual({ email: null, link: null });
  });
  it('card layout: headline, time and body split by position, action bar cut', () => {
    const l = splitCardLines(['Jo Demo', '3rd+', 'Recruiter at Acme', '2d • Edited', 'We are hiring a dev.', '…more', 'Like', 'Comment'], 'Jo Demo');
    expect(l).toEqual({ headline: 'Recruiter at Acme', timeText: '2d • Edited', bodyLines: ['We are hiring a dev.'] });
  });
});

describe('gate for thin posts', () => {
  const m = { job_id: 'li-post:1', score: 80 };
  const facts = (company: string) => ({ facts: { source: 'linkedin-posts', company }, now: NOW });
  it('flags a post with no company, and one with no requirement signal', () => {
    const noCo = applyVetoes(m, { title: 'Senior React Developer', description: '3+ years React' }, [], facts(''));
    expect(noCo).toMatchObject({ excluded: false });
    expect(noCo.flags).toContain('thin post: no company or no requirements');
    const noReq = applyVetoes(m, { title: 'Designer', description: 'Join the fun team, great vibes.' }, [], facts('Acme'));
    expect(noReq.flags).toContain('thin post: no company or no requirements');
    const ok = applyVetoes(m, { title: 'Designer', description: '3+ years of Figma experience' }, [], facts('Acme'));
    expect(ok.flags).not.toContain('thin post: no company or no requirements');
  });
  it('excludes only when both company and role are missing', () => {
    const r = applyVetoes(m, { title: 'Hiring post by Jo Demo', description: 'We are hiring.' }, [], facts(''));
    expect(r).toMatchObject({ excluded: true, reason: 'post has no identifiable company or role' });
    expect(r.gate_flags).toBeDefined();
    expect(applyVetoes(m, { title: 'Hiring post by Jo Demo', description: 'x' }, [], facts('Acme')).excluded).toBe(false);
  });
  it('other sources are untouched', () => {
    const r = applyVetoes(m, { title: 'x', description: 'x' }, [], { facts: { source: 'greenhouse', company: '', url: 'https://boards.greenhouse.io/x/jobs/1', apply_url: 'https://boards.greenhouse.io/x/jobs/1' }, now: NOW });
    expect(r.flags).toEqual([]);
  });
  it('posted date feeds the staleness flag; facts read the company from the db', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'li-post:9', source: 'linkedin-posts', title: 'Designer', company: '', url: 'u', apply_url: 'u', description: 'Figma', posted_at: '2026-08-01' });
    const f = jobFactsFromDb(db, 'li-post:9');
    expect(f.company).toBe('');
    const r = applyVetoes({ job_id: 'li-post:9', score: 80 }, { title: 'Designer', description: 'Figma' }, [], { facts: f, now: NOW });
    expect(r.flags.some((x) => x.startsWith('stale: posted'))).toBe(true);
  });
  it('a poster-only post (no company) still reaches linkedin outreach', () => {
    const v = channelsFor({ source: 'linkedin-posts', company: '' });
    expect(v.find((c) => c.channel === 'linkedin')?.eligible).toBe(true);
    expect(v.find((c) => c.channel === 'email')?.eligible).toBe(false);
  });
});

describe('scripts/fix-linkedin-posts', () => {
  it('marks old profile-url rows once and leaves good rows alone', () => {
    const db = openDb(':memory:');
    const bad = { source: 'linkedin-posts', title: 'Jane', company: '', apply_url: 'https://www.linkedin.com/in/jane/', description: 'We are hiring' };
    saveJob(db, { id: 'li-post:aaaa', url: 'https://www.linkedin.com/in/jane/', ...bad });
    saveJob(db, { id: 'li-post:bbbb', url: 'https://www.linkedin.com/in/omar/', ...bad });
    saveJob(db, { id: 'li-post:7123456789012345678', source: 'linkedin-posts', title: 'Dev', company: 'Acme', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/', apply_url: 'u', description: 'd' });
    saveJob(db, { id: 'g1', source: 'greenhouse', title: 'x', company: '', url: 'https://www.linkedin.com/in/x/', apply_url: 'u', description: 'd' });
    expect(fixLinkedinPosts(db, { dry: true })).toMatchObject({ matched: 2, marked: 0 });
    expect(fixLinkedinPosts(db)).toMatchObject({ matched: 2, marked: 2 });
    expect(fixLinkedinPosts(db)).toMatchObject({ matched: 2, marked: 0 });
    const rows = db.prepare('SELECT id, status, excluded_reason FROM jobs ORDER BY id').all() as Array<{ id: string; status: string | null; excluded_reason: string | null }>;
    expect(rows.filter((r) => r.status === BAD_EXTRACTION_STATUS).map((r) => r.id)).toEqual(['li-post:aaaa', 'li-post:bbbb']);
    expect(rows.find((r) => r.id === 'li-post:aaaa')!.excluded_reason).toMatch(/^bad extraction/);
    expect(rows.find((r) => r.id === 'g1')!.excluded_reason).toBeNull();
    expect(rows.find((r) => r.id === 'li-post:7123456789012345678')!.excluded_reason).toBeNull();
  });
});
