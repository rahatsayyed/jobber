import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { setupToolingChecks } from '../src/platform/checksSetup.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { validateEnvValue } from '../src/settings/valueCheck.js';
import {
  DEFAULT_DIM_MINIMUMS, DEFAULT_MATCH_THRESHOLD, LEGACY_MATCH_THRESHOLD, dimMinimumsFromEnv, dimsKind, dimsLabel, failedDims, decisionOf,
  globalOfScore, matchThresholdFromEnv, matchedBinds, parseCareerOpsDims, parseDimMinimums, parseStoredDims, passRule, rubricOfStored, scaleGlobal, thresholdForKind,
} from '../src/matchRubric.js';
import { normalizeMatchRow } from '../src/score.js';
import { openDb, saveJob, saveMatchResultsChecked, listUnscoredJobs } from '../src/db.js';
import { calibrate } from '../src/calibrate.js';
import { getCalibrationRows, recordOutcome } from '../src/db.js';
import { funnelStats } from '../src/funnel.js';
import { coDims } from './helpers/coDims.js';

const desc = 'We need 3+ years of React. Strong TypeScript required. Must be based in India. Full-time, permanent role.';
const goodReqs = [{ req: 'React', category: 'skill', importance: 'critical', evidence: 'stated', jd_quote: '3+ years of React', match: 'strong' }];
const row = (dims: any, extra: Record<string, unknown> = {}) => ({ job_id: 'j', score: 99, reasons: 'r', missing_keywords: [], score_dims: dims, requirements: goodReqs, ...extra });
const norm = (dims: any, extra: Record<string, unknown> = {}, opts = {}) => {
  const r = normalizeMatchRow(row(dims, extra) as any, desc, opts);
  if (!r.ok) throw new Error(r.error);
  return r.row;
};

describe('the career-ops go line and the scale', () => {
  it('Global x 20 is the stored score: 3.9 -> 78, 4.0 -> 80, 4.5 -> 90, 5.0 -> 100', () => {
    expect([3.9, 4.0, 4.5, 5.0, 3.5, 1.0].map(scaleGlobal)).toEqual([78, 80, 90, 100, 70, 20]);
    expect(globalOfScore(78)).toBe(3.9);
  });
  it('the default MATCH_THRESHOLD is 80 (4.0 of 5); the env key still overrides; a bad value falls back to 80', () => {
    expect(DEFAULT_MATCH_THRESHOLD).toBe(80);
    expect(matchThresholdFromEnv({})).toBe(80);
    expect(matchThresholdFromEnv({ MATCH_THRESHOLD: '70' })).toBe(70);
    expect(matchThresholdFromEnv({ MATCH_THRESHOLD: 'abc' })).toBe(80);
    expect(matchThresholdFromEnv({ MATCH_THRESHOLD: '101' })).toBe(80);
  });
  it('career-ops Score interpretation bands: 4.5+ apply now, 4.0-4.4 apply, 3.5-3.9 consider (recommend against), below 3.5 skip', () => {
    expect([5, 4.5, 4.4, 4.0, 3.9, 3.5, 3.4, 1].map(decisionOf)).toEqual(['apply_now', 'apply_now', 'apply', 'apply', 'consider', 'consider', 'skip', 'skip']);
  });
  it('cutoff behaviour at 3.9 / 4.0 / 4.5 through the pass rule', () => {
    expect(passRule({ score: scaleGlobal(3.9), threshold: 80 })).toEqual({ ok: false, why: ['below_threshold'] });
    expect(passRule({ score: scaleGlobal(4.0), threshold: 80 }).ok).toBe(true);
    expect(passRule({ score: scaleGlobal(4.5), threshold: 80 }).ok).toBe(true);
    expect(passRule({ score: 90, threshold: 80, locationVerdict: 'FAIL', hardStops: ['x'] }).why).toEqual(['location_fail', 'hard_stop']);
  });
  it('through normalizeMatchRow: 3.9 is stored 78 (below the line), 4.0 is 80, 4.5 is 90, with decision bands', () => {
    expect(norm(coDims(3.9)).score).toBe(78);
    expect(norm(coDims(3.9)).score_dims).toMatchObject({ global: 3.9, decision: 'consider' });
    expect(norm(coDims(4.0)).score_dims).toMatchObject({ decision: 'apply', rubric: 'career_ops_v1' });
    expect(norm(coDims(4.5)).score).toBe(90);
    expect(norm(coDims(4.5)).score_dims).toMatchObject({ decision: 'apply_now' });
  });
});

describe('parseCareerOpsDims (validation)', () => {
  const ok = (o: any) => parseCareerOpsDims(o);
  it('accepts the five dimensions and the holistic global with one decimal', () => {
    const r = ok({ cv_match: 4.5, north_star: 5, comp: 3, culture: 3.5, red_flags: -0.5, global: 4.2, archetype: ' Full-stack developer ', evidence: { north_star: ' "Dev" - "builds apps" ', bogus: 'x' } });
    expect(r).toMatchObject({ ok: true, clamped: 0, dims: { cv_match: 4.5, north_star: 5, red_flags: -0.5, global: 4.2, archetype: 'Full-stack developer', decision: 'apply', rubric: 'career_ops_v1' } });
    expect((r as any).dims.evidence).toEqual({ north_star: '"Dev" - "builds apps"' });
  });
  it.each([
    ['cv_match', 0.9], ['cv_match', 5.1], ['north_star', 4.25], ['comp', '4'], ['culture', null], ['global', 6], ['global', NaN],
  ])('rejects %s = %s', (k, v) => {
    expect(ok({ ...coDims(4), [k as string]: v })).toMatchObject({ ok: false, error: expect.stringContaining(`score_dims.${k}`) });
  });
  it.each([[0.5], [-3.5], [-0.25], ['0']])('rejects red_flags = %s (0 or a negative adjustment down to -3, one decimal)', (v) => {
    expect(ok({ ...coDims(4), red_flags: v })).toMatchObject({ ok: false, error: expect.stringContaining('score_dims.red_flags') });
  });
  it('a missing dimension or the wrong rubric tag is an error', () => {
    const { comp: _c, ...noComp } = coDims(4);
    expect(ok(noComp)).toMatchObject({ ok: false, error: expect.stringContaining('score_dims.comp') });
    expect(ok({ ...coDims(4), rubric: 'other' })).toMatchObject({ ok: false });
  });
  it('code never lets the Global score exceed the best dimension (clamped, reported)', () => {
    const r = ok({ ...coDims(3.0), global: 5.0 }) as any;
    expect(r.dims.global).toBe(3.0);
    expect(r.clamped).toBe(5.0);
    const x = norm({ ...coDims(3.0), global: 5.0 });
    expect(x.score).toBe(60);
    expect(x.score_cap_reason).toContain('global-above-dimensions:5');
  });
  it('the red flags adjustment does not change the stored score by itself: the model folds it into the Global', () => {
    expect(norm(coDims(4.0, { red_flags: -1.5 })).score).toBe(80);
  });
});

describe('the pass rule in code (normalizeMatchRow)', () => {
  it('a clean strong row keeps its score and has no cap', () => {
    const x = norm(coDims(5.0));
    expect(x.score).toBe(100);
    expect(x.score_cap_reason).toBeNull();
    expect(x.score_dims).toMatchObject({ cv_match: 5, north_star: 5, comp: 5, culture: 5, red_flags: 0, global: 5, decision: 'apply_now' });
  });
  it('a location_verdict FAIL holds the stored score under the threshold, a FLAG or PASS does not', () => {
    const f = norm(coDims(5.0), { location_verdict: 'FAIL' });
    expect([f.score, f.score_cap_reason]).toEqual([79, 'location_fail']);
    expect(f.reasons).toContain('held back: location FAIL');
    expect(norm(coDims(5.0), { location_verdict: 'FLAG' }).score).toBe(100);
    expect(norm(coDims(5.0), { location_verdict: 'PASS' }).score).toBe(100);
  });
  it('a hard stop holds the stored score', () => {
    const x = norm(coDims(5.0), { requirements: [{ req: 'Kubernetes', category: 'skill', importance: 'critical', evidence: 'stated', jd_quote: 'Strong TypeScript required', match: 'missing' }] });
    expect(x.hard_stops.length).toBe(1);
    expect(x.score).toBeLessThanOrEqual(79);
    expect(x.score_cap_reason).toContain('hard_stop');
  });
  it('MATCH_THRESHOLD moves the hold line (threshold 70 -> 69)', () => {
    expect(norm(coDims(5.0), { location_verdict: 'FAIL' }, { threshold: 70 }).score).toBe(69);
  });
  it('career-ops culture warning: Global 4.5+ with Cultural signals 2 or less carries the verify warning', () => {
    const x = norm({ ...coDims(4.6), culture: 2.0 });
    expect(x.reasons).toContain('High technical fit, unconfirmed/poor culture fit - verify before applying.');
    expect(norm({ ...coDims(4.6), culture: 3.0 }).reasons).not.toContain('culture fit');
    expect(norm({ ...coDims(4.4), culture: 2.0 }).reasons).not.toContain('culture fit');
  });
  it('an unmatched role (North Star 1) with a low Global is far under the line', () => {
    const x = norm({ cv_match: 4.5, north_star: 1.0, comp: 3.0, culture: 3.0, red_flags: 0, global: 2.0, archetype: null });
    expect([x.score, x.score_dims!.archetype, x.score_dims!.decision]).toEqual([40, null, 'skip']);
  });
});

describe('older shapes: refused for a new save, readable when stored', () => {
  const V2 = { role_fit: 20, skills: 20, seniority_comp: 20, location: 20, flags: 20 };
  const LEG = { skills: 20, seniority: 15, domain: 12, location: 25 };
  const CO = coDims(4.2);
  it('rejects the rubric_v2 and the legacy four-key shape for a new save, naming the new keys', () => {
    const bad = (d: any) => normalizeMatchRow(row(d) as any, desc);
    expect(bad(V2)).toMatchObject({ ok: false, error: expect.stringContaining('rubric_v2 score_dims is no longer accepted') });
    expect(bad(LEG)).toMatchObject({ ok: false, error: expect.stringContaining('legacy score_dims is no longer accepted') });
    expect(bad({ foo: 1 })).toMatchObject({ ok: false });
  });
  it('dimsKind, parseStoredDims, dimsLabel and rubricOfStored tell the three shapes apart and never throw', () => {
    expect(dimsKind(CO)).toBe('career_ops');
    expect(dimsKind(V2)).toBe('rubric_v2');
    expect(dimsKind(LEG)).toBe('legacy');
    expect(dimsKind(null)).toBe('none');
    expect(parseStoredDims(JSON.stringify(V2)).kind).toBe('rubric_v2');
    expect(parseStoredDims('{not json').kind).toBe('none');
    expect(parseStoredDims(null).kind).toBe('none');
    expect(dimsLabel(JSON.stringify(LEG))).toMatch(/^legacy: skills 20/);
    expect(dimsLabel(JSON.stringify(V2))).toMatch(/^rubric_v2: role_fit 20/);
    expect(dimsLabel(JSON.stringify(CO))).toContain('Global 4.2');
    expect(dimsLabel(null)).toBe('no dimensions');
    expect([CO, V2, LEG].map((d) => rubricOfStored(JSON.stringify(d)))).toEqual(['career_ops_v1', 'rubric_v2', 'legacy']);
  });
  it('older rows keep the old line of 60 (never above MATCH_THRESHOLD); career_ops_v1 rows use MATCH_THRESHOLD', () => {
    expect(LEGACY_MATCH_THRESHOLD).toBe(60);
    expect(thresholdForKind('career_ops', 80)).toBe(80);
    expect(thresholdForKind('rubric_v2', 80)).toBe(60);
    expect(thresholdForKind('legacy', 50)).toBe(50);
    expect(matchedBinds(80)).toEqual([80, 60]);
    expect(matchedBinds(40)).toEqual([40, 40]);
  });
  it('listUnscoredJobs (kind matched) offers an old 72 row and a new 80 row, but not a new 76 row; funnel matches the same way', () => {
    const db = openDb(':memory:');
    const put = (id: string, score: number, dims: unknown) => {
      saveJob(db, { id, source: 't', title: 'Full Stack Developer', company: id, url: id, apply_url: id, description: desc });
      db.prepare('UPDATE jobs SET score = ?, score_dims = ? WHERE id = ?').run(score, dims === null ? null : JSON.stringify(dims), id);
    };
    put('old72', 72, LEG);
    put('v2_72', 72, V2);
    put('nodims', 65, null);
    put('co80', 80, coDims(4.0));
    put('co76', 76, coDims(3.8));
    const r = listUnscoredJobs(db, { kind: 'matched', matchThreshold: 80, limit: 20 }) as any[];
    expect(r.map((x) => x.id).sort()).toEqual(['co80', 'nodims', 'old72', 'v2_72']);
    expect(funnelStats(db, 80).matched).toBe(4);
  });
  it('a legacy row keeps its score; calibration works on mixed legacy, v2 and career-ops rows', () => {
    const db = openDb(':memory:');
    const ids = ['l1', 'l2', 'l3', 'n1', 'n2', 'n3'];
    for (const id of ids) saveJob(db, { id, source: 't', title: 'Dev', company: id, url: id, apply_url: id, description: desc });
    for (const id of ['l1', 'l2']) db.prepare('UPDATE jobs SET score = 72, score_dims = ? WHERE id = ?').run(JSON.stringify(LEG), id);
    db.prepare('UPDATE jobs SET score = 72, score_dims = ? WHERE id = ?').run(JSON.stringify(V2), 'l3');
    for (const id of ['n1', 'n2', 'n3']) db.prepare('UPDATE jobs SET score = 85, score_dims = ? WHERE id = ?').run(JSON.stringify(CO), id);
    for (const id of ids) recordOutcome(db, id, id.startsWith('n') ? 'interview' : 'no_response');
    expect((db.prepare("SELECT score FROM jobs WHERE id = 'l1'").get() as any).score).toBe(72);
    const rows = getCalibrationRows(db);
    expect(rows.length).toBe(6);
    expect(() => calibrate(rows, 1)).not.toThrow();
  });
  it('save through the db stores the rubric tag, the decision, the archetype and the evidence in score_dims', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'rl', source: 't', title: 'Full Stack Developer', company: 'Acme', url: 'u', apply_url: 'u', description: desc });
    const out = saveMatchResultsChecked(db, [row(coDims(4.2), { job_id: 'rl' })] as any);
    expect(out.errors).toEqual([]);
    expect(out.scores[0]).toMatchObject({ job_id: 'rl', score: 84, score_cap_reason: null });
    const j = db.prepare('SELECT score, score_dims FROM jobs WHERE id = ?').get('rl') as any;
    expect(JSON.parse(j.score_dims)).toMatchObject({ rubric: 'career_ops_v1', global: 4.2, decision: 'apply', archetype: 'Full-stack developer' });
    expect(JSON.parse(j.score_dims).evidence.north_star).toContain('Full Stack Developer');
  });
});

describe('MATCH_DIM_MINIMUMS (legacy rubric_v2 key, read only by the re-check script)', () => {
  it('unset or blank = the shipped defaults, valid', () => {
    expect(parseDimMinimums(undefined)).toEqual({ mins: DEFAULT_DIM_MINIMUMS });
    expect(parseDimMinimums('  ')).toEqual({ mins: DEFAULT_DIM_MINIMUMS });
    expect(DEFAULT_DIM_MINIMUMS).toEqual({ role_fit: 12, skills: 10, seniority_comp: 8, location: 8, flags: 10 });
  });
  it('a partial list overrides only the listed keys', () => {
    expect(parseDimMinimums('role_fit=14, flags=5').mins).toEqual({ role_fit: 14, skills: 10, seniority_comp: 8, location: 8, flags: 5 });
  });
  it.each(['role_fit', 'role_fit=', 'role_fit=21', 'role_fit=-1', 'bogus=5', 'role_fit=5,role_fit=6', 'role_fit=5,,skills=4', 'role_fit=1.5', 'role_fit=12;skills=10'])('invalid "%s" = ALL defaults plus a reason', (raw) => {
    const r = parseDimMinimums(raw);
    expect(r.invalid).toBeTruthy();
    expect(r.mins).toEqual(DEFAULT_DIM_MINIMUMS);
  });
  it('failedDims still lists rubric_v2 failures in order; the env key is read', () => {
    expect(failedDims({ role_fit: 3, skills: 20, seniority_comp: 20, location: 20, flags: 3 })).toEqual(['role_fit', 'flags']);
    expect(dimMinimumsFromEnv({ MATCH_DIM_MINIMUMS: 'skills=15' }).mins.skills).toBe(15);
  });
  it('the settings editor validates the key and the doctor warns on a bad value, passes on a good or blank one', async () => {
    const spec = ENV_CATALOG.find((s) => s.key === 'MATCH_DIM_MINIMUMS')!;
    expect(spec.default).toBe('role_fit=12,skills=10,seniority_comp=8,location=8,flags=10');
    expect(spec.tier).toBe('guarded');
    expect(spec.about).toContain('Legacy');
    expect(validateEnvValue(spec, 'role_fit=14,skills=10')).toBeNull();
    expect(validateEnvValue(spec, '')).toBeNull();
    expect(validateEnvValue(spec, 'role_fit=40')).toMatch(/above 20/);
    expect(validateEnvValue(spec, 'nope=1')).toMatch(/unknown dimension/);
    const check = setupToolingChecks.find((c) => c.id === 'match-dim-minimums')!;
    const ctx = (env: Record<string, string>) => ({ root: '/p', env, run: async () => ({ stdout: '', code: 1 }), fs: { exists: () => false, read: () => { throw new Error('x'); }, mode: () => null, list: () => [] } }) as any;
    expect((await check.run(ctx({ MATCH_DIM_MINIMUMS: 'role_fit=99' }))).status).toBe('warn');
    expect((await check.run(ctx({ MATCH_DIM_MINIMUMS: 'role_fit=14' }))).status).toBe('pass');
    expect((await check.run(ctx({}))).status).toBe('pass');
  });
});

describe('MATCH_THRESHOLD catalog and example', () => {
  it('the catalog, the limits and .env.example all say 80 and explain 4.0 of 5', () => {
    const spec = ENV_CATALOG.find((s) => s.key === 'MATCH_THRESHOLD')!;
    expect(String(spec.default)).toBe('80');
    expect(spec.about).toContain('4.0 of 5');
    expect(readFileSync(new URL('../.env.example', import.meta.url), 'utf8')).toMatch(/^MATCH_THRESHOLD=80$/m);
  });
});

describe('text and wiring', () => {
  const skill = () => readFileSync(new URL('../.claude/skills/match-jobs/SKILL.md', import.meta.url), 'utf8');
  it('the matcher agent tools line is byte-identical', () => {
    const t = readFileSync(new URL('../.claude/agents/matcher.md', import.meta.url), 'utf8');
    expect(t.split('\n').find((l) => l.startsWith('tools:'))).toBe('tools: Skill, mcp__resume__get_base_resume, mcp__gates__check_liveness');
  });
  it('the match-jobs skill carries the career-ops dimensions, the North Star rule, the bands, the output shape and the attribution', () => {
    const s = skill();
    for (const k of ['`cv_match`', '`north_star`', '`comp`', '`culture`', '`red_flags`', '`global`', 'role_gate: "borderline"', 'career-ops-hq/career-ops', 'MIT License']) expect(s).toContain(k);
    expect(s).toContain('If an offer matches no archetype the owner actually targets, say so plainly and score North Star alignment 1.');
    expect(s).toContain('Holistic judgment integrating the five dimensions above (no arithmetic formula)');
    for (const band of ['4.5 and above: strong match, recommend applying immediately', '4.0 to 4.4: good match, worth applying', '3.5 to 3.9: decent but not ideal', 'below 3.5: recommend against applying']) expect(s).toContain(band);
    expect(s).toContain('"score_dims": {"rubric": "career_ops_v1", "cv_match": <1.0-5.0>');
    expect(s).toContain('High technical fit, unconfirmed/poor culture fit - verify before applying.');
  });
  it('the skill no longer teaches the old rubric (role_fit sums, minimums, 0 to 20 integers)', () => {
    const s = skill();
    expect(s).not.toContain('<int 0-20>');
    expect(s).not.toContain('every dimension must reach its minimum');
    expect(s).not.toContain('`seniority_comp` (level fit');
    expect(s).not.toContain('"seniority": <int 0-25>');
  });
  it('docs/matching.md is linked from the docs index and carries the career-ops attribution, the bands and the go line', () => {
    expect(readFileSync(new URL('../docs/index.md', import.meta.url), 'utf8')).toContain('(matching.md)');
    const d = readFileSync(new URL('../docs/matching.md', import.meta.url), 'utf8');
    for (const k of ['https://github.com/career-ops-hq/career-ops', 'MIT License', 'Santiago Fernandez de Valderrama', '4.0 of 5', 'round(Global x 20)', 'rubric_v2', 'legacy']) expect(d).toContain(k);
    expect(readFileSync(new URL('../src/matchRubric.ts', import.meta.url), 'utf8')).toContain('career-ops-hq/career-ops');
  });
  it('the matcher agent text names the career-ops rubric and the North Star line, not the old five keys as the rubric', () => {
    const t = readFileSync(new URL('../.claude/agents/matcher.md', import.meta.url), 'utf8');
    expect(t).toContain('career_ops_v1');
    expect(t).toContain('`North Star:` line');
    expect(t).not.toContain('each an integer 0 to 20');
  });
});
