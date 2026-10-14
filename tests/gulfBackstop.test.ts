import { describe, it, expect } from 'vitest';
import { applyVetoes } from '../src/vetoes.js';
import { DEFAULT_TARGET_REGIONS, GULF_TERMS, mentionedTargetRegion, targetRegionEvidence } from '../src/targetRegions.js';
import { findRestriction } from '../src/remotePolicy.js';
import { loadPortals, locationAllowed } from '../src/sources/boards/filters.js';

const regions = DEFAULT_TARGET_REGIONS;
const verdict = (job: { title: string; description: string; location?: string }) =>
  applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, job, [], { targetRegions: regions });
const isFlag = (job: { title: string; description: string; location?: string }) => {
  const r = verdict(job);
  return !r.excluded && r.flags.some((f) => f.startsWith('location FLAG: the matcher said FAIL'));
};
const stays = (job: { title: string; description: string; location?: string }) => expect(verdict(job)).toMatchObject({ excluded: true, reason: 'location FAIL' });

describe('Gulf backstop: a target word that merely appears does not downgrade a FAIL', () => {
  it('false positives keep the FAIL', () => {
    stays({ title: 'Engineer', description: 'Onsite in Austin, TX. Team events near Dubai Mall.' });
    stays({ title: 'Engineer', description: 'Candidates must be located in London (Dubai office closed).' });
    stays({ title: 'Engineer', description: 'Remote, must reside in the EU. Our customers are in UAE.' });
    stays({ title: 'Engineer', description: 'Remote US only. We serve MENA clients.' });
    stays({ title: 'Engineer', description: 'Onsite NYC; we sell to the Middle East.' });
    stays({ title: 'Engineer, Dubai', description: 'Onsite in Berlin, no remote.' });
  });
  it('"London or Dubai": stays FAIL unless a target place is in the location field', () => {
    stays({ title: 'Engineer', description: 'Onsite in London or Dubai.' });
    stays({ title: 'Engineer (London or Dubai)', description: 'Join us.' });
    expect(isFlag({ title: 'Engineer', description: 'Join us.', location: 'London; Dubai' })).toBe(true);
  });
  it('true positives still FLAG', () => {
    expect(isFlag({ title: 'Engineer', description: 'On-site role in Dubai, UAE.' })).toBe(true);
    expect(isFlag({ title: 'Engineer', description: 'Riyadh onsite.' })).toBe(true);
    expect(isFlag({ title: 'Engineer', description: 'Join us.', location: 'Doha, Qatar' })).toBe(true);
    expect(isFlag({ title: 'Frontend Engineer - Abu Dhabi', description: 'Great team.' })).toBe(true);
    expect(isFlag({ title: 'Engineer', description: 'Candidates must be located in the UAE.' })).toBe(true);
    expect(isFlag({ title: 'Engineer', description: 'On-site in Manama.' })).toBe(true);
    expect(isFlag({ title: 'Engineer', description: 'Join us.', location: 'دبي' })).toBe(true);
    expect(isFlag({ title: 'Engineer', description: 'مقر العمل في الرياض', location: '' })).toBe(false); // no on-site wording and no location field: not evidence
  });
  it('a restriction marker beats a location-field hit', () => {
    stays({ title: 'Engineer', description: 'Candidates must reside in Germany.', location: 'Dubai' });
  });
  it('region-wide words never trigger', () => {
    expect(targetRegionEvidence({ title: 'Engineer', description: 'On-site across the GCC and MENA, Middle East office.' }, GULF_TERMS)).toBeNull();
    expect(targetRegionEvidence({ title: 'Engineer', description: 'x', location: 'MENA' }, GULF_TERMS)).toBeNull();
  });
});

describe('terms: new cities and Arabic script', () => {
  it('Latin terms are whole words, Arabic terms exact substrings', () => {
    expect(mentionedTargetRegion('Manama office', GULF_TERMS)).toBe('Manama');
    expect(mentionedTargetRegion('Kuwait City', GULF_TERMS)).toBe('Kuwait');
    expect(mentionedTargetRegion('Manamas', GULF_TERMS)).toBeNull();
    for (const a of ['دبي', 'أبوظبي', 'الرياض', 'الدوحة', 'مسقط', 'الكويت', 'المنامة']) expect(mentionedTargetRegion(`المكتب في ${a}`, GULF_TERMS)).toBe(a);
  });
  it('every GULF_TERMS entry passes the portals.json allow list (kept in step)', () => {
    const lf = loadPortals().config!.location_filter;
    for (const t of GULF_TERMS) expect(locationAllowed([t], false, lf)).toBe(true);
  });
});

describe('findRestriction', () => {
  it('target subjects cancel a marker, other places do not', () => {
    const t = ['UAE', 'Dubai'];
    expect(findRestriction('must be located in the UAE', { scope: 'posting', targets: t })).toBeNull();
    expect(findRestriction('UAE citizens only', { scope: 'location', targets: t })).toBeNull();
    expect(findRestriction('must be located in London (Dubai office)', { scope: 'posting', targets: t })).toBe('must reside');
    expect(findRestriction('Remote, US only', { scope: 'location' })).toBe('only');
    expect(findRestriction('We are the only team in town', { scope: 'posting' })).toBeNull();
  });
});
