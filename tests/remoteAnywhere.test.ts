import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyVetoes } from '../src/vetoes.js';
import { DEFAULT_TARGET_REGIONS, loadTargetRegionsStatus, type TargetRegions } from '../src/targetRegions.js';
import { findRestriction, isRemotePosting } from '../src/remotePolicy.js';
import { loadPortals, locationAllowed } from '../src/sources/boards/filters.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const lfOff = { allow: ['india', 'bengaluru'], global: ['remote', 'anywhere', 'worldwide', 'global'] };
const lfOn = { ...lfOff, remote_anywhere: true };

// [locations, remote flag, passes with remote_anywhere on, passes with it off (plan 4 behaviour)]
const TABLE: Array<[string[], boolean, boolean, boolean]> = [
  [['Remote, US'], true, true, false],
  [['Remote, United States'], true, true, false],
  [['Remote - Germany'], true, true, false],
  [['Germany (Remote)'], true, true, false],
  [['Remote, US only'], true, false, false],
  [['Remote, US-based'], true, false, false],
  [['Remote, must reside in the EU'], true, false, false],
  [['Remote (must be located in Canada)'], true, false, false],
  [['Remote - Worldwide (excl. India)'], true, false, false],
  [['Worldwide (excl. India)'], true, false, false],
  [['Remote, excluding Brazil'], true, false, false],
  [['Remote, except Spain'], true, false, false],
  [['Remote, citizens of Brazil'], true, false, false],
  [['Remote, right to work in UK required'], true, false, false],
  [['Remote, work authorization required'], true, false, false],
  [['Remote, authorized to work in the US'], true, false, false],
  [['Remote, eligible to work in Spain'], true, false, false],
  [['Remote, visa required'], true, false, false],
  [['Remote, no visa sponsorship'], true, false, false],
  [['Remote, relocation not offered'], true, false, false],
  [['Remote, not open to Brazil'], true, false, false],
  [['Remote, not available in Spain'], true, false, false],
  [['Remote, outside India'], true, false, false],
  [['Remote, other than India'], true, false, true], // the plan 4 filter lets this through on the word India; with the option on it is refused
  [['Remote, not open to India'], true, false, true],
  [['Remote'], true, true, true],
  [['Remote, India'], true, true, true],
  [['Bengaluru'], false, true, true],
  [['Berlin'], false, false, false],
  [['Berlin'], true, true, false], // remote flag set by the vendor
  [['Singapore (Remote)'], false, true, false],
  [['Remote, Sweden/Austria/Switzerland'], true, true, false],
  [['Work from home, Poland'], false, true, false],
  [['Distributed, Portugal'], false, true, false],
  [['Anywhere in Europe'], false, false, false], // a bare continent is a restriction
  [['Remote, Canada; Remote, India'], true, true, true],
  [['Remote, US;'], true, true, false],
  [['Remote, Canada; Berlin'], true, true, false],
  [['Austin, TX (Hybrid)'], false, false, false],
  [['Remote - Brazil only'], true, false, false],
  [['Remote, Ukraine'], true, true, false],
  [['Remote, Israel'], true, true, false],
  [['US-based, remote'], true, false, false],
  [['Remote, EMEA'], true, false, false],
  [['Remote, Europe'], true, false, false],
  [['Remote - Americas'], true, false, false],
  [['Remote, Germany; excl. India'], true, false, false],
  [['Hybrid - Berlin (Remote 1 day)'], true, false, false],
  [['Remote-first, Berlin HQ'], true, false, false],
  [['Berlin (Hybrid/Remote)'], true, false, false],
  [['Remote; Berlin; Onsite'], true, false, true], // off: the bare remote segment passes as in plan 4
  [['Bengaluru (Hybrid)'], false, true, true],
  [['Remote, No India'], true, false, true],
  [['Remote (Not India)'], true, false, true],
  [['Remote (US residents)'], true, false, false],
  [['Remote - EU residency required'], true, false, false],
  [['Remote, work permit required'], true, false, false],
  [['Remote within India'], true, true, true],
  [['Remote, Germany'], true, true, false],
  [['Remote, residents of Texas'], true, false, false],
  [['Remote, Canada; Remote, United States'], true, true, false],
  [['Remote (US/Canada)'], true, true, false],
  [['New York'], false, false, false],
  [[''], false, false, false],
];

describe('board location filter with remote_anywhere', () => {
  it('the table has at least 40 rows', () => { expect(TABLE.length).toBeGreaterThanOrEqual(40); });
  it.each(TABLE)('%j remote=%s: on=%s off=%s', (locs, remote, on, off) => {
    expect(locationAllowed(locs, remote, lfOn)).toBe(on);
    expect(locationAllowed(locs, remote, lfOff)).toBe(off);
    expect(locationAllowed(locs, remote, { ...lfOff, remote_anywhere: false })).toBe(off);
    expect(locationAllowed(locs, remote, { ...lfOff, remote_anywhere: 'yes' as any })).toBe(off); // only the boolean true switches it on
  });
});

describe('shipped config: both flags are on and stay in step', () => {
  it('portals.json location_filter.remote_anywhere equals target-regions.json remote_anywhere, both true', () => {
    const portals = loadPortals().config!.location_filter;
    const tr = loadTargetRegionsStatus().config!;
    expect(portals.remote_anywhere).toBe(true);
    expect(tr.remote_anywhere).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, 'config', 'target-regions.json'), 'utf8')).remote_anywhere).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, 'config', 'portals.json'), 'utf8')).location_filter.remote_anywhere).toBe(true);
    expect(locationAllowed(['Remote, Brazil'], true, portals)).toBe(true);
    expect(locationAllowed(['Remote, US only'], true, portals)).toBe(false);
  });
  it('absent or invalid means false', () => {
    expect(DEFAULT_TARGET_REGIONS.remote_anywhere).toBe(false);
  });
});

describe('one shared restriction-marker implementation', () => {
  it('the board filter and the veto backstop import findRestriction from src/remotePolicy.ts, and nothing else defines the list', () => {
    const filters = readFileSync(path.join(root, 'src', 'sources', 'boards', 'filters.ts'), 'utf8');
    const vetoes = readFileSync(path.join(root, 'src', 'vetoes.ts'), 'utf8');
    expect(filters).toMatch(/import \{[^}]*findRestriction[^}]*\} from '\.\.\/\.\.\/remotePolicy\.js'/);
    expect(vetoes).toMatch(/import \{[^}]*findRestriction[^}]*\} from '\.\/remotePolicy\.js'/);
    for (const src of [filters, vetoes]) expect(src).not.toMatch(/right\\s\+to\\s\+work|must\\s\+\(\?:reside/);
    expect(typeof findRestriction).toBe('function');
  });
});

const on: TargetRegions = { ...DEFAULT_TARGET_REGIONS, remote_anywhere: true };
const run = (job: { title: string; description: string; location?: string; remote?: boolean }, tr: TargetRegions | null | undefined = on, verdict: 'FAIL' | 'FLAG' | 'PASS' = 'FAIL', invalid?: string) =>
  applyVetoes({ job_id: 'a', score: 80, location_verdict: verdict }, job, [], tr === undefined ? { facts: {} } : { targetRegions: tr, targetRegionsInvalid: invalid });
const REMOTE_FLAG = 'location FLAG: remote role based elsewhere: verify eligibility';

describe('vetoes backstop with remote_anywhere', () => {
  it('1. a model FAIL on a remote posting with no marker becomes the remote flag', () => {
    expect(run({ title: 'Engineer', description: 'Fully remote role. Work from anywhere you like.', location: 'Remote, Germany' })).toMatchObject({ excluded: false, flags: [REMOTE_FLAG] });
  });
  it('2. the same posting with the option off keeps the FAIL', () => {
    expect(run({ title: 'Engineer', description: 'Fully remote role.', location: 'Remote, Germany' }, { ...on, remote_anywhere: false })).toMatchObject({ excluded: true, reason: 'location FAIL' });
  });
  it('3. a config without the flag keeps the FAIL (default false)', () => {
    const noFlag = { home: ['India'], targets: [], remote: true } as unknown as TargetRegions;
    expect(run({ title: 'Engineer', description: 'Fully remote role.', location: 'Remote, Germany' }, noFlag)).toMatchObject({ excluded: true });
  });
  it('4. a marker in the location string keeps the FAIL', () => {
    expect(run({ title: 'Engineer', description: 'Fully remote role.', location: 'Remote, US only' })).toMatchObject({ excluded: true, reason: 'location FAIL' });
  });
  it('5. residency wording in the description keeps the FAIL', () => {
    expect(run({ title: 'Engineer', description: 'Remote. Must reside in the EU.' })).toMatchObject({ excluded: true });
  });
  it('6. right-to-work wording keeps the FAIL', () => {
    expect(run({ title: 'Engineer', description: 'Remote role. Candidates need the right to work in the UK.' })).toMatchObject({ excluded: true });
  });
  it('7. on-site elsewhere stays FAIL', () => {
    expect(run({ title: 'Engineer', description: 'Onsite in Berlin, no remote.' })).toMatchObject({ excluded: true, reason: 'location FAIL' });
  });
  it('8. hybrid wins over a remote word', () => {
    expect(run({ title: 'Engineer', description: 'Hybrid role in London, remote Fridays.' })).toMatchObject({ excluded: true });
  });
  it('9. a Gulf on-site role is still the Gulf flag, not the remote flag', () => {
    const r = run({ title: 'Engineer', description: 'On-site role in Dubai, UAE.' });
    expect(r.excluded).toBe(false);
    expect(r.flags).toEqual([expect.stringMatching(/^location FLAG: the matcher said FAIL but the posting names target region "UAE"/)]);
  });
  it('10. an invalid target-regions config keeps the FAIL and flags it', () => {
    expect(run({ title: 'Engineer', description: 'Fully remote.' }, null, 'FAIL', 'home must be a non-empty array of short strings'))
      .toMatchObject({ excluded: true, reason: 'location FAIL', gate_flags: ['target regions config invalid: home must be a non-empty array of short strings'] });
  });
  it('11. no config passed (old callers) keeps the FAIL', () => {
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, { title: 'Engineer', description: 'Fully remote.' }, [])).toMatchObject({ excluded: true, reason: 'location FAIL' });
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, { title: 'Engineer', description: 'Fully remote.' }, [], { facts: {} })).toMatchObject({ excluded: true });
  });
  it('12. PASS and FLAG verdicts are untouched', () => {
    expect(run({ title: 'Engineer', description: 'Fully remote.' }, on, 'PASS').flags).toEqual([]);
    expect(run({ title: 'Engineer', description: 'Fully remote.' }, on, 'FLAG').flags).toEqual(['location FLAG']);
  });
  it('13. the remote flag of the job counts', () => {
    expect(run({ title: 'Engineer', description: 'Great team.', location: 'Brazil', remote: true })).toMatchObject({ excluded: false, flags: [REMOTE_FLAG] });
  });
  it('14. a remote flag does not beat relocation wording', () => {
    expect(run({ title: 'Engineer', description: 'Relocation to our Austin office is required.', remote: true })).toMatchObject({ excluded: true });
  });
  it('15. a marker deep in a long description still keeps the FAIL', () => {
    expect(run({ title: 'Engineer', description: `Fully remote. ${'We build things. '.repeat(500)} Must reside in Canada.` })).toMatchObject({ excluded: true });
  });
  it('16. an ordinary "only" in the description is not a marker', () => {
    expect(run({ title: 'Engineer', description: 'Fully remote. We are the only team that ships weekly.' })).toMatchObject({ excluded: false, flags: [REMOTE_FLAG] });
  });
  it('17. a posting with no remote word at all keeps the FAIL', () => {
    expect(run({ title: 'Engineer', description: 'Join our team in Toronto.' })).toMatchObject({ excluded: true });
  });
});

describe('time and robustness', () => {
  it('a 5 MB description is handled in under 200 ms', () => {
    const big = 'We are hiring. onsite remote only citizens '.repeat(Math.ceil(5_000_000 / 43)).slice(0, 5_000_000);
    const t0 = performance.now();
    run({ title: 'Engineer', description: big, location: 'Remote, Brazil' });
    run({ title: 'Engineer', description: 'a'.repeat(5_000_000) });
    findRestriction(big, { scope: 'posting' });
    isRemotePosting({ title: 'x', description: big });
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('pathological repeated markers stay linear', () => {
    const t0 = performance.now();
    findRestriction('must reside '.repeat(5000), { scope: 'posting', targets: ['UAE'] });
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
