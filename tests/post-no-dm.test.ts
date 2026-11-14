// LinkedIn hiring posts that say "no DMs / email only / link only": the detector, the stored flag, and the hard gates.
// The email path is not blocked by the flag. All posts and people here are synthetic.
import { describe, it, expect, vi } from 'vitest';
import { openDb, saveJob, type Job } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { nextPosterContacts } from '../src/outreach/service.js';
import { detectNoDm, posterNoDmForProfile, POSTER_NO_DM } from '../src/lib/postNoDm.js';
import { postEmailContact } from '../src/lib/postEmail.js';
import { channelsFor } from '../src/lib/channels.js';
import { extractApplyRoute } from '../src/linkedin/postExtract.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { preSendGuard, type GuardInput } from '../src/linkedin/guard.js';

describe('detectNoDm', () => {
  it.each([
    'We are hiring a React dev. No DMs please.',
    'Please do not DM me, apply below.',
    "Please don't message me about this role.",
    'DMs are closed. Apply on the careers page.',
    'Email only: hr@acme.io',
    'Please apply only via email.',
    'Apply through the link only.',
    'Send your CV to hr@acme.io',
    'Hiring React dev. DM mat karo, sirf email bhejo: hr@acme.io',
    'Sirf email pe apply karo.',
    'Message mat karna please',
    'Do not contact me via DM',
  ])('flags: %s', (t) => {
    expect(detectNoDm(t).noDm).toBe(true);
  });

  it.each([
    'We are hiring a React developer. DMs are welcome!',
    'Feel free to DM me or drop your CV.',
    "Don't hesitate to DM me with questions.",
    'Not only email, DMs are welcome too.',
    'Interested? Comment below or message me.',
    'Send your CV to me in a DM.',
    'We hire in Bangalore. 3+ years React. Apply on our site.',
    '',
  ])('does not flag: %s', (t) => {
    expect(detectNoDm(t).noDm).toBe(false);
  });
});

describe('post email extraction is independent of the flag', () => {
  it('keeps the address when the post says email only', () => {
    const text = 'React developer needed. No DMs. Email only: Careers@Acme.io';
    expect(detectNoDm(text).noDm).toBe(true);
    expect(extractApplyRoute(text).email).toBe('careers@acme.io');
  });
});

type D = ReturnType<typeof openDb>;
const NOW = new Date('2026-10-23T08:00:00.000Z');

function post(db: D, n: string, description: string, o: Partial<Job> = {}) {
  const poster = `https://www.linkedin.com/in/poster-${n}/`;
  const job: Job = {
    id: `li-post:${n}`, source: 'linkedin-posts', title: 'React Developer', company: 'Acme',
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`, apply_url: `https://www.linkedin.com/feed/update/urn:li:activity:${n}/`,
    description, poster_url: poster, ...o,
  };
  saveJob(db, job);
  db.prepare('UPDATE jobs SET score = 4.5 WHERE id = ?').run(job.id);
  const personId = upsertPerson(db, { platform: 'linkedin', profileKey: `linkedin.com/in/poster-${n}`, name: `Poster ${n}`, company: 'Acme', category: 'hiring_manager', employerMatch: 1 });
  return { id: job.id, personId, url: poster };
}

describe('saved flag and poster outreach gates', () => {
  it('saveJob stores poster_no_dm 1 or 0 for posts and leaves other sources NULL', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111', 'Hiring. No DMs, email only: hr@acme.io');
    const b = post(db, '222222', 'Hiring. DMs are welcome. 3 years React.');
    saveJob(db, { id: 'x1', source: 'remotive', title: 'T', company: 'C', url: 'u', apply_url: 'u', description: 'No DMs' });
    const flag = (id: string) => (db.prepare('SELECT poster_no_dm AS f FROM jobs WHERE id = ?').get(id) as { f: number | null }).f;
    expect(flag(a.id)).toBe(1);
    expect(flag(b.id)).toBe(0);
    expect(flag('x1')).toBeNull();
    expect(posterNoDmForProfile(db, a.url)).toBe(true);
    expect(posterNoDmForProfile(db, b.url)).toBe(false);
  });

  it('old rows with a NULL flag are judged from the stored text', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111', 'Hiring. Please do not DM me.');
    db.prepare('UPDATE jobs SET poster_no_dm = NULL WHERE id = ?').run(a.id);
    expect(posterNoDmForProfile(db, a.url)).toBe(true);
  });

  it('next_contacts for posters skips the flagged post and returns the other', () => {
    const db = openDb(':memory:');
    const a = post(db, '111111', 'Hiring React dev. DM mat karo, sirf email: hr@acme.io');
    const b = post(db, '222222', 'Hiring React dev. DMs welcome.');
    const cfg = { companyContactLimit: 5 };
    const all = nextPosterContacts(db, cfg, 'linkedin', { minScore: 3, now: NOW });
    expect(all.map((x) => x.job_id)).toEqual([b.id]);
    expect(nextPosterContacts(db, cfg, 'linkedin', { minScore: 3, jobId: a.id, now: NOW })).toEqual([]);
  });

  it.each(['connect', 'role_ask', 'rapport'] as const)('arm guard refuses %s to a flagged poster with poster_no_dm, and consumes nothing', (kind) => {
    const db = openDb(':memory:');
    const a = post(db, '111111', 'Hiring. No DMs. Email only: hr@acme.io');
    const b = post(db, '222222', 'Hiring. DMs are welcome.');
    const mk = (url: string, over: Partial<GuardInput> = {}): GuardInput => ({
      db, now: new Date('2026-10-14T06:00:00Z'), env: {}, action: kind === 'connect' ? 'invite' : 'message', kind, profileUrl: url,
      text: 'Hi, I saw your post about the React role and would like to connect.',
      factCheck: (t) => ({ verdict: 'pass' as const, normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
      cfg: loadLinkedinConfig({ JOBBER_DRY_RUN: 'false' }), ...over,
    });
    const r = preSendGuard(mk(a.url));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(POSTER_NO_DM);
    // plain invites are refused too
    const plain = preSendGuard(mk(a.url, { kind: 'connect', action: 'invite', plain: true, text: '' }));
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.code).toBe(POSTER_NO_DM);
    expect((db.prepare('SELECT COUNT(*) AS n FROM touches').get() as { n: number }).n).toBe(0);
    // a poster whose post has no such statement is not refused for this reason
    const ok = preSendGuard(mk(b.url));
    if (!ok.ok) expect(ok.code).not.toBe(POSTER_NO_DM);
  });
});

describe('the email path is not blocked by the flag', () => {
  const flaggedPost = { source: 'linkedin-posts', apply_email: 'hr@acme.io', company: 'Acme' };
  it('a flagged post with a verifying address still yields a verified post contact', async () => {
    expect(detectNoDm('No DMs. Email only: hr@acme.io').noDm).toBe(true);
    const c = await postEmailContact(flaggedPost, 'Acme', async () => true);
    expect(c).toMatchObject({ email: 'hr@acme.io', source: 'post', verified: true });
  });
  it('a gmail.com address from a post is never verified and never probed', async () => {
    const v = vi.fn(async () => true);
    const c = await postEmailContact({ ...flaggedPost, apply_email: 'recruiter@gmail.com' }, 'Acme', v);
    expect(c).toMatchObject({ source: 'post', verified: false });
    expect(v).not.toHaveBeenCalled();
  });
  it('a company-less post with an address has an eligible email channel; without an address it does not', () => {
    const base = { source: 'linkedin-posts', company: '', apply_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/' };
    const withMail = channelsFor({ ...base, apply_email: 'hr@acme.io' });
    expect(withMail.find((c) => c.channel === 'email')?.eligible).toBe(true);
    const without = channelsFor(base);
    expect(without.find((c) => c.channel === 'email')?.eligible).toBe(false);
  });
});
