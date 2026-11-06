import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, saveJob, saveMatchResult, recordOutcome, getCalibrationRows } from '../src/db.js';
import { calibrate } from '../src/calibrate.js';

const rows = (score: number, outcomes: string[]) => outcomes.map(outcome => ({ score, outcome })) as any;

describe('calibrate', () => {
  it('prints no rate for a band with fewer than 5 samples', () => {
    const r = calibrate(rows(3.2, ['interview', 'rejected']));
    expect(r.bands.find(b => b.label === '3.0-3.4')).toEqual({ label: '3.0-3.4', n: 2, interviewRate: null });
    expect(r.verdict).toMatch(/not enough data/i);
  });
  it('says scores predict outcomes when the top band beats the bottom by 10+ points', () => {
    const low = rows(3.1, ['rejected', 'rejected', 'rejected', 'rejected', 'interview']);
    const high = rows(4.3, ['interview', 'interview', 'interview', 'rejected', 'offer']);
    expect(calibrate([...low, ...high]).verdict).toMatch(/predict/i);
  });
  it.each([
    [1, '<3.0'], [2.9, '<3.0'], [3.0, '3.0-3.4'], [3.4, '3.0-3.4'], [3.5, '3.5-3.9'], [3.9, '3.5-3.9'],
    [4.0, '4.0-4.4'], [4.4, '4.0-4.4'], [4.5, '4.5+'], [5, '4.5+'],
  ])('places score %s in band %s', (score, label) => {
    const r = calibrate(rows(score as number, ['interview']), 1);
    const hit = r.bands.filter((b) => b.n === 1).map((b) => b.label);
    expect(hit).toEqual(label ? [label] : []);
  });
  it('uses minN in the not-enough-data message', () => {
    expect(calibrate([], 8).verdict).toBe('Not enough data: need at least 8 resolved jobs in two score bands.');
  });
  it('reports a negative gap (top band worse than bottom) as not predictive', () => {
    const low = rows(3.1, ['interview', 'interview', 'interview', 'interview', 'offer']);
    const high = rows(4.3, ['rejected', 'rejected', 'rejected', 'rejected', 'interview']);
    expect(calibrate([...low, ...high]).verdict).toBe('Scores do not clearly predict outcomes (gap -80 points). Review the match rubric.');
  });
  it('excludes jobs with no resolved outcome', () => {
    expect(calibrate(rows(3.5, ['replied'])).bands.every(b => b.n === 0)).toBe(true);
  });
  it('computes the integer percentage for a band with n>=5', () => {
    const r = calibrate(rows(3.8, ['interview', 'offer', 'hired', 'rejected', 'no_response']));
    expect(r.bands.find(b => b.label === '3.5-3.9')).toEqual({ label: '3.5-3.9', n: 5, interviewRate: 60 });
  });
  it('treats replied as unresolved and no_response as resolved-negative', () => {
    const r = calibrate(rows(3.8, ['replied', 'no_response']));
    expect(r.bands.find(b => b.label === '3.5-3.9')!.n).toBe(1);
  });
});

describe('getCalibrationRows', () => {
  it('uses the latest outcome per job and skips unscored jobs', () => {
    const db: Database.Database = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 't', title: 'a', company: 'c', url: 'u', apply_url: 'u', description: 'd' });
    saveJob(db, { id: 'j2', source: 't', title: 'a', company: 'c', url: 'u2', apply_url: 'u2', description: 'd' });
    saveMatchResult(db, { job_id: 'j1', score: 3.8, reasons: '', missing_keywords: [] });
    recordOutcome(db, 'j1', 'replied');
    recordOutcome(db, 'j1', 'interview');
    recordOutcome(db, 'j2', 'rejected');
    expect(getCalibrationRows(db)).toEqual([{ score: 3.8, outcome: 'interview' }]);
  });
});
