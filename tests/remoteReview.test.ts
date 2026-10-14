import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyVetoes } from '../src/vetoes.js';
import { DEFAULT_TARGET_REGIONS, type TargetRegions } from '../src/targetRegions.js';
import { findRestriction, isRemotePosting } from '../src/remotePolicy.js';
import { locationAllowed } from '../src/sources/boards/filters.js';
import { locationLine } from '../src/sources/boards/index.js';
import { parseHnHeader } from '../src/sources/boards/hackernews.js';
import { normalizeHimalayas } from '../src/sources/boards/himalayas.js';
import { getJson, BOARD_USER_AGENT } from '../src/sources/boards/transport.js';

const spy = vi.fn();
vi.mock('../src/sources/boards/registry.js', () => ({
  FETCHERS: { greenhouse: (c: any, ctx: any) => spy(c, ctx), lever: vi.fn(), ashby: vi.fn() },
}));
afterEach(() => { spy.mockReset(); vi.unstubAllGlobals(); });

const on: TargetRegions = { ...DEFAULT_TARGET_REGIONS, remote_anywhere: true };
const veto = (job: { title: string; description: string; location?: string }) =>
  applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, job, [], { targetRegions: on });
const REMOTE_FLAG = 'location FLAG: remote role based elsewhere: verify eligibility';

describe('1. the location reaches the veto backstop through the first description line', () => {
  it('locationLine: "Location: a; b (remote)", prefix at most 300 chars, empty when nothing is known', () => {
    expect(locationLine(['Remote, India', 'Remote, US only'], true)).toBe('Location: Remote, India; Remote, US only (remote)\n\n');
    expect(locationLine(['Berlin'], false)).toBe('Location: Berlin\n\n');
    expect(locationLine([''], false)).toBe('');
    expect(locationLine([''], true)).toBe('Location: (remote)\n\n');
    const long = locationLine(['x'.repeat(1000)], true);
    expect(long.split('\n')[0].length).toBeLessThanOrEqual(300);
    expect(long.split('\n')[0].endsWith(' (remote)')).toBe(true);
  });
  const file = (allow: string[]) => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'rr-')), 'portals.json');
    writeFileSync(f, JSON.stringify({ tracked_companies: [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }], title_filter: { positive: ['frontend'], negative: [] }, location_filter: { allow, global: ['remote'], remote_anywhere: true } }));
    return f;
  };
  const gh = (id: string, locations: string[], description: string) =>
    ({ id, source: 'greenhouse', title: 'Frontend Engineer', company: 'A', url: 'u', apply_url: 'u', description, locations, remote: true });
  it('fetchBoards prepends the line (cap applied after it), then apply_vetoes keeps a FAIL for "Remote, US only" and downgrades "Remote, Brazil"', async () => {
    const { fetchBoards } = await import('../src/sources/boards/index.js');
    spy.mockResolvedValue([
      gh('gh:a:1', ['Remote, India', 'Remote, US only'], 'Build React apps.'),
      gh('gh:a:2', ['Remote, Brazil'], 'Build React apps. ' + 'z'.repeat(9000)),
    ]);
    const r = await fetchBoards({ configPath: file(['india']) });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:1', 'gh:a:2']);
    expect(r.jobs[0].description.startsWith('Location: Remote, India; Remote, US only (remote)\n\nBuild React apps.')).toBe(true);
    expect(r.jobs[1].description.length).toBeLessThanOrEqual(8000);
    expect(r.jobs[1].description.startsWith('Location: Remote, Brazil (remote)\n\n')).toBe(true);
    // apply_vetoes sees only title and description (the gates tool is fed the Job objects as they are)
    expect(veto({ title: r.jobs[0].title, description: r.jobs[0].description })).toMatchObject({ excluded: true, reason: 'location FAIL' });
    expect(veto({ title: r.jobs[1].title, description: r.jobs[1].description })).toMatchObject({ excluded: false, flags: [REMOTE_FLAG] });
  });
});

describe('2. Himalayas and Hacker News location handling', () => {
  const him = (restr: string[]) => normalizeHimalayas({ jobs: [{ title: 'Dev', companyName: 'A', applicationLink: 'https://himalayas.app/jobs/x', description: 'text', locationRestrictions: restr }] }, { name: 'H', ats: 'himalayas', slug: 'himalayas', enabled: true } as any).jobs[0].locations;
  const lf = { allow: ['india'], global: ['remote', 'anywhere', 'worldwide', 'global'], remote_anywhere: true };
  it('every restriction entry becomes "<region> only"; allow-listed India still passes first', () => {
    expect(him(['United States'])).toEqual(['United States only']);
    expect(locationAllowed(him(['United States']), true, lf)).toBe(false);
    expect(locationAllowed(him(['Germany', 'France']), true, lf)).toBe(false);
    expect(locationAllowed(him(['India', 'United States']), true, lf)).toBe(true);
    expect(locationAllowed(him([]), true, lf)).toBe(true);
    expect(locationAllowed(him(['Worldwide']), true, lf)).toBe(true);
  });
  it('HN: an on-site segment makes the posting not remote, "REMOTE (US)" is a region restriction', () => {
    const a = parseHnHeader('Acme | Eng | ONSITE Berlin | REMOTE')!;
    expect(a.remote).toBe(false);
    expect(locationAllowed(a.locations, a.remote, lf)).toBe(false);
    const b = parseHnHeader('Acme | Eng | REMOTE (US)')!;
    expect(b.remote).toBe(false);
    expect(b.locations).toContain('REMOTE (US) only');
    expect(locationAllowed(b.locations, b.remote, lf)).toBe(false);
    const c = parseHnHeader('Acme | Eng | REMOTE')!;
    expect(c.remote).toBe(true);
    expect(locationAllowed(c.locations, c.remote, lf)).toBe(true);
    const d = parseHnHeader('Acme | Eng | Hybrid Berlin / Remote')!;
    expect(d.remote).toBe(false);
    expect(locationAllowed(d.locations, d.remote, lf)).toBe(false);
  });
});

describe('3. broadened restriction markers', () => {
  const probes = [
    'Remote within the US.', 'Open to candidates in the US and Canada.', 'We can only hire in Germany.', 'No candidates from India.', 'We do not hire in India.',
    'Applicants from India will not be considered.', 'Contractors in India are not supported.', 'Must be a US person.', 'EEA nationals.',
    'Candidates based in the US.', 'Must be in the EU time zone.',
  ];
  it.each(probes)('posting text %j is a restriction and a model FAIL stays', (p) => {
    expect(findRestriction(p, { scope: 'posting', targets: ['UAE', 'India'] })).not.toBeNull();
    expect(veto({ title: 'Frontend Engineer', description: `Fully remote role. ${p}` })).toMatchObject({ excluded: true, reason: 'location FAIL' });
  });
  const locs = ['Remote, No India', 'Remote (Not India)', 'Remote (US residents)', 'Remote - EU residency required', 'Remote, work permit required'];
  it.each(locs)('location string %j is a restriction', (l) => {
    expect(findRestriction(l, { scope: 'location' })).not.toBeNull();
    expect(veto({ title: 'Frontend Engineer', description: 'Fully remote role.', location: l })).toMatchObject({ excluded: true });
  });
  it('legitimate remote wording is not refused when the named place is home or a target', () => {
    const ex = ['India', 'UAE'];
    for (const t of ['Remote within India.', 'Open to candidates in India.', 'Candidates based in the UAE.', 'Candidates from all backgrounds are welcome.', 'Candidates from anywhere are welcome.', 'We welcome applicants from diverse places.']) {
      expect(findRestriction(t, { scope: 'posting', targets: ex })).toBeNull();
    }
    expect(veto({ title: 'Frontend Engineer', description: 'Fully remote role. Candidates from anywhere are welcome.', location: 'Remote, Germany' })).toMatchObject({ excluded: false, flags: [REMOTE_FLAG] });
    expect(veto({ title: 'Frontend Engineer', description: 'Fully remote. Open to candidates in India.' })).toMatchObject({ excluded: false });
  });
  it('a bare continent in the location keeps the FAIL, worldwide does not', () => {
    expect(veto({ title: 'Engineer', description: 'Remote.', location: 'Remote, Europe' })).toMatchObject({ excluded: true });
    expect(veto({ title: 'Engineer', description: 'Remote.', location: 'Worldwide (Europe, Asia, Africa)' })).toMatchObject({ excluded: false });
  });
});

describe('4. on-site wording anywhere in the capped text means not remote', () => {
  it.each(['on site', 'in person', 'on-premises', 'on-premise', 'in the office', 'in-office', 'in-person'])('"%s" deep in the description', (w) => {
    const d = `Fully remote role. ${'We build things. '.repeat(400)} Some days ${w} work is needed.`;
    expect(d.indexOf(w)).toBeGreaterThan(2000);
    expect(isRemotePosting({ title: 'Engineer', description: d })).toBe(false);
    expect(veto({ title: 'Engineer', description: d })).toMatchObject({ excluded: true });
  });
  it('plain remote text is remote', () => {
    expect(isRemotePosting({ title: 'Engineer', description: 'Fully remote role.' })).toBe(true);
  });
});

describe('minor: transport headers in any letter case', () => {
  it('a caller cannot set user-agent, accept or content-type in lower case', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    await getJson('https://api.lever.co/v0/postings/a', 'x', { headers: { 'user-agent': 'evil', accept: 'text/evil', 'content-type': 'x', Referer: 'https://a.example/' } });
    const h = f.mock.calls[0][1].headers;
    expect(Object.keys(h).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'referer', 'user-agent']);
    expect(h['User-Agent']).toBe(BOARD_USER_AGENT);
    expect(h.Accept).toBe('application/json');
  });
});
