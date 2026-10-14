import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, saveJob, saveMatchResult, recordOutcome, getCalibrationRows } from '../src/db.js';
import { calibrate } from '../src/calibrate.js';

const rows = (score: number, outcomes: string[]) => outcomes.map(outcome => ({ score, outcome })) as any;

describe('calibrate', () => {
  it('prints no rate for a band with fewer than 5 samples', () => {
    const r = calibrate(rows(65, ['interview', 'rejected']));
    expect(r.bands.find(b => b.label === '60-69')).toEqual({ label: '60-69', n: 2, interviewRate: null });
    expect(r.verdict).toMatch(/not enough data/i);
  });
  it('says scores predict outcomes when the top band beats the bottom by 10+ points', () => {
    const low = rows(62, ['rejected', 'rejected', 'rejected', 'rejected', 'interview']);
    const high = rows(85, ['interview', 'interview', 'interview', 'rejected', 'offer']);
    expect(calibrate([...low, ...high]).verdict).toMatch(/predict/i);
  });
  it.each([
    [59, null], [60, '60-69'], [69, '60-69'], [69.5, '60-69'], [70, '70-79'], [79, '70-79'], [79.9, '70-79'],
    [80, '80+'], [100, '80+'],
  ])('places score %s in band %s', (score, label) => {
    const r = calibrate(rows(score as number, ['interview']), 1);
    const hit = r.bands.filter((b) => b.n === 1).map((b) => b.label);
    expect(hit).toEqual(label ? [label] : []);
  });
  it('uses minN in the not-enough-data message', () => {
    expect(calibrate([], 8).verdict).toBe('Not enough data: need at least 8 resolved jobs in two score bands.');
  });
  it('reports a negative gap (top band worse than bottom) as not predictive', () => {
    const low = rows(62, ['interview', 'interview', 'interview', 'interview', 'offer']);
    const high = rows(85, ['rejected', 'rejected', 'rejected', 'rejected', 'interview']);
    expect(calibrate([...low, ...high]).verdict).toBe('Scores do not clearly predict outcomes (gap -80 points). Review the match rubric.');
  });
  it('excludes jobs with no resolved outcome', () => {
    expect(calibrate(rows(70, ['replied'])).bands.every(b => b.n === 0)).toBe(true);
  });
  it('computes the integer percentage for a band with n>=5', () => {
    const r = calibrate(rows(75, ['interview', 'offer', 'hired', 'rejected', 'no_response']));
    expect(r.bands.find(b => b.label === '70-79')).toEqual({ label: '70-79', n: 5, interviewRate: 60 });
  });
  it('treats replied as unresolved and no_response as resolved-negative', () => {
    const r = calibrate(rows(75, ['replied', 'no_response']));
    expect(r.bands.find(b => b.label === '70-79')!.n).toBe(1);
  });
});

describe('getCalibrationRows', () => {
  it('uses the latest outcome per job and skips unscored jobs', () => {
    const db: Database.Database = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 't', title: 'a', company: 'c', url: 'u', apply_url: 'u', description: 'd' });
    saveJob(db, { id: 'j2', source: 't', title: 'a', company: 'c', url: 'u2', apply_url: 'u2', description: 'd' });
    saveMatchResult(db, { job_id: 'j1', score: 75, reasons: '', missing_keywords: [] });
    recordOutcome(db, 'j1', 'replied');
    recordOutcome(db, 'j1', 'interview');
    recordOutcome(db, 'j2', 'rejected');
    expect(getCalibrationRows(db)).toEqual([{ score: 75, outcome: 'interview' }]);
  });
});
