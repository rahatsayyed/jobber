import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_TARGET_REGIONS, GULF_TERMS, loadTargetRegionsStatus, mentionedTargetRegion } from '../src/targetRegions.js';
import { applyVetoes, vetoResults } from '../src/vetoes.js';
import { languageGate, type LanguageConfig } from '../src/languageGate.js';
import { hardStops, type Requirement } from '../src/score.js';
import { loadPortals, locationAllowed } from '../src/sources/boards/filters.js';

const english = [{ language: 'English', level: 'fluent' as const }];
const req = (r: string, over: Partial<Requirement> = {}): Requirement =>
  ({ req: r, importance: 'critical', evidence: 'stated', jd_quote: null, match: 'missing', category: 'other', ...over });
const regions = DEFAULT_TARGET_REGIONS;

describe('target regions config', () => {
  it('the shipped config/target-regions.json equals the built-in defaults, and every Gulf term is accepted by the portals.json location filter', () => {
    const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'config', 'target-regions.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ home: ['India'], targets: GULF_TERMS, remote: true, remote_anywhere: true });
    // the shipped file differs from the built-in defaults only in remote_anywhere (shipped true, default false)
    expect(loadTargetRegionsStatus(file)).toEqual({ config: { ...DEFAULT_TARGET_REGIONS, remote_anywhere: true } });
    const { config } = loadPortals();
    for (const t of GULF_TERMS) expect(locationAllowed([t], false, config!.location_filter)).toBe(true);
  });
  it('a missing file means the defaults; an invalid file is reported, never silently replaced', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tr-'));
    expect(loadTargetRegionsStatus(path.join(dir, 'none.json')).config).toEqual(DEFAULT_TARGET_REGIONS);
    const bad = (body: string) => { const f = path.join(dir, `b${Math.random()}.json`); writeFileSync(f, body); return loadTargetRegionsStatus(f); };
    expect(bad('{').config).toBeNull();
    expect(bad('{"home":[],"targets":[]}').invalid).toMatch(/home/);
    expect(bad('{"home":["India"],"targets":"UAE"}').invalid).toMatch(/targets/);
    expect(bad('{"home":["India"],"targets":[],"remote":"yes"}').invalid).toMatch(/remote/);
    expect(bad('{"home":["India"],"targets":["Qatar"]}').config).toEqual({ home: ['India'], targets: ['Qatar'], remote: true, remote_anywhere: false });
  });
  it('mentionedTargetRegion matches whole words only', () => {
    for (const [text, hit] of [['Muscat, Oman', 'Oman'], ['based in DOHA', 'Doha'], ['Dubai Internet City', 'Dubai'], ['across the GCC', 'GCC'], ['KSA-based', 'KSA']] as const) {
      expect(mentionedTargetRegion(text, GULF_TERMS)).toBe(hit);
    }
    for (const t of ['Romania', 'a woman engineer', 'Omani culture', 'Bucharest', 'ksar', 'Quatar']) expect(mentionedTargetRegion(t, GULF_TERMS)).toBeNull();
  });
});

describe('sample 1: "Arabic speaker required" (language gate, tests inject their own language configs)', () => {
  const jd = 'React and Node role in Dubai. Arabic speaker required.';
  it('is a FLAG while languages are unconfirmed and a FAIL once confirmed with English only', () => {
    expect(languageGate(jd, english, { confirmed: false })).toEqual({ verdict: 'FLAG', note: expect.stringContaining('unconfirmed languages.json: requires Arabic') });
    expect(languageGate(jd, english, { confirmed: true }).verdict).toBe('FAIL');
    expect(languageGate(jd, [...english, { language: 'Arabic', level: 'professional' }], { confirmed: true }).verdict).toBe('FLAG');
    expect(languageGate(jd, [...english, { language: 'Arabic', level: 'fluent' }], { confirmed: true }).verdict).toBe('PASS');
  });
  it('vetoResults: not excluded while unconfirmed (flag with the quote), excluded with "language FAIL: ..." after confirmation', () => {
    const run = (confirmed: boolean) => vetoResults([{ job_id: 'a', score: 80, location_verdict: 'PASS' }], [{ id: 'a', title: 'Full Stack Dev', description: jd }], [], { languages: { declared: english, confirmed } })[0];
    expect(run(false)).toMatchObject({ excluded: false, flags: [expect.stringMatching(/^language FLAG: unconfirmed languages.json: requires Arabic/)] });
    expect(run(true)).toMatchObject({ excluded: true, reason: expect.stringMatching(/^language FAIL: requires Arabic/) });
  });
  it('"Arabic preferred" and "customers speak Arabic" never exclude', () => {
    expect(languageGate('Arabic is a plus.', english, { confirmed: true }).verdict).toBe('FLAG');
    expect(languageGate('Our Arabic speaking customers love the product.', english, { confirmed: true }).verdict).toBe('PASS');
  });
});

describe('a confirmed declared-language list (English, Hindi, Marathi, Urdu fluent; Arabic basic)', () => {
  // Explicit in-test data: no user file is read, so the result never depends on whose languages.json is installed.
  const shipped: LanguageConfig = {
    confirmed: true,
    declared: [
      { language: 'English', level: 'fluent' },
      { language: 'Hindi', level: 'fluent' },
      { language: 'Marathi', level: 'fluent' },
      { language: 'Urdu', level: 'fluent' },
      { language: 'Arabic', level: 'basic' },
    ],
  };
  it('declares Arabic at basic level and is confirmed', () => {
    expect(shipped.confirmed).toBe(true);
    expect(shipped.declared).toContainEqual({ language: 'Arabic', level: 'basic' });
  });
  it('"Arabic speaker required" (professional level) is a FLAG with the shipped config, not a FAIL: the job proceeds with a visible warning', () => {
    const jd = 'React and Node role in Dubai. Arabic speaker required.';
    expect(languageGate(jd, shipped.declared, { confirmed: shipped.confirmed }).verdict).toBe('FLAG');
    const r = vetoResults([{ job_id: 'a', score: 80, location_verdict: 'FLAG' }], [{ id: 'a', title: 'Full Stack Dev', description: jd }], [], { languages: shipped })[0];
    expect(r.excluded).toBe(false);
    expect(r.flags.some((f) => f.startsWith('language FLAG'))).toBe(true);
  });
  it('a language that is not declared at all (German required) still FAILs and excludes', () => {
    const r = vetoResults([{ job_id: 'a', score: 80, location_verdict: 'PASS' }], [{ id: 'a', title: 'Dev', description: 'German speaker required.' }], [], { languages: shipped })[0];
    expect(r).toMatchObject({ excluded: true, reason: expect.stringMatching(/^language FAIL/) });
  });
});

describe('sample 2: "Candidates must hold a UAE visa / be in the UAE" (visa and location are never hard stops; the verdict is a FLAG)', () => {
  const jd = 'Frontend engineer, Abu Dhabi. Candidates must hold a valid UAE visa and be located in the UAE.';
  it('requirement rows about visa, residence or presence never create a hard stop, with the model category or by wording', () => {
    expect(hardStops([req('Valid UAE visa', { category: 'location' }), req('Valid UAE visa'), req('Located in the UAE'), req('UAE residence permit'),
      req('Emirates ID'), req('Iqama (Saudi residence)'), req('Currently in UAE'), req('Already in Dubai'), req('Right to work in the UAE')])).toEqual([]);
  });
  it('a matcher FAIL on a posting that names a target region is downgraded to a visible FLAG, not excluded', () => {
    const r = applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, { title: 'Frontend Engineer', description: jd }, [], { targetRegions: regions });
    expect(r.excluded).toBe(false);
    expect(r.flags).toEqual([expect.stringMatching(/^location FLAG: the matcher said FAIL but the posting names target region "UAE"/)]);
  });
  it('a FAIL for a place outside every target region still excludes, and so does a FAIL when no config is passed (old callers)', () => {
    const berlin = { title: 'Frontend Engineer', description: 'Onsite in Berlin, no remote.' };
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, berlin, [], { targetRegions: regions })).toMatchObject({ excluded: true, reason: 'location FAIL' });
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, { title: 'x', description: jd }, [])).toMatchObject({ excluded: true, reason: 'location FAIL' });
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, { title: 'x', description: jd }, [], { facts: {} })).toMatchObject({ excluded: true });
  });
  it('an invalid target-regions config keeps the FAIL and says so (unknown never passes silently)', () => {
    const r = applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, { title: 'x', description: jd }, [], { targetRegions: null, targetRegionsInvalid: 'home must be a non-empty array of short strings' });
    expect(r).toMatchObject({ excluded: true, reason: 'location FAIL', gate_flags: ['target regions config invalid: home must be a non-empty array of short strings'] });
    const flag = applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FLAG' }, { title: 'x', description: jd }, [], { targetRegions: null, targetRegionsInvalid: 'bad' });
    expect(flag.flags).toEqual(['location FLAG', 'target regions config invalid: bad']);
  });
  it('PASS and FLAG verdicts are untouched by the target regions', () => {
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'PASS' }, { title: 'x', description: jd }, [], { targetRegions: regions })).toEqual({ excluded: false, flags: [], legitimacy: undefined, language_note: null });
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FLAG' }, { title: 'x', description: jd }, [], { targetRegions: regions }).flags).toEqual(['location FLAG']);
  });
});

describe('sample 3: "Saudi nationals only" (nationality is an explicit non-negotiable the candidate cannot meet)', () => {
  it('a stated critical nationality row IS a hard stop; a preferred one is not', () => {
    expect(hardStops([req('Saudi nationality', { jd_quote: 'Saudi nationals only (Saudization)' })])).toEqual(['Saudi nationality']);
    expect(hardStops([req('GCC nationals', { importance: 'preferred' })])).toEqual([]);
    expect(hardStops([req('Saudi nationality', { evidence: 'inferred' })])).toEqual([]);
  });
  it('the stored hard stop excludes the job with its reason', () => {
    const facts = new Map([['a', { hard_stops: ['Saudi nationality'] }]]);
    expect(vetoResults([{ job_id: 'a', score: 85 }], [{ id: 'a', title: 'Frontend Engineer', description: 'Saudi nationals only.' }], [], { facts })[0])
      .toMatchObject({ excluded: true, reason: 'hard stop: Saudi nationality' });
  });
});

describe('existing deal-breaker keywords still apply to Gulf postings (decision for the user)', () => {
  it('"no sponsorship" excludes a Gulf posting that asks for an existing UAE work permit', () => {
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FLAG' }, { title: 'Frontend', description: 'No sponsorship available; candidates must already hold a UAE work permit.' }, ['no sponsorship']))
      .toEqual({ excluded: true, reason: 'deal-breaker: no sponsorship', flags: [] });
  });
});
