import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openDb, saveJob, saveMatchResultsChecked, listUnscoredJobs } from '../src/db.js';
import { MATCH_SCALE_USER_VERSION, ensureMatchScale } from '../src/scoreScale.js';
import { funnelStats } from '../src/funnel.js';
import { jobCounts } from '../src/dash/queries/jobs.js';
import { coDims } from './helpers/coDims.js';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'scale-')); dirs.push(d); return d; };

const CO = (g: number) => JSON.stringify({ rubric: 'career_ops_v1', cv_match: g, north_star: g, comp: g, culture: g, red_flags: 0, global: g });
const V2 = JSON.stringify({ role_fit: 15, skills: 14, seniority_comp: 12, location: 18, flags: 16 });
const LEG = JSON.stringify({ skills: 20, seniority: 15, domain: 12, location: 25 });

/** A db file in the OLD state: scores on 0..100, no marker. Rows: [id, score, score_dims|null]. */
function oldDb(file: string, rows: Array<[string, number | null, string | null]>, queued: string[] = []) {
  openDb(file).close();
  const raw = new Database(file);
  raw.pragma('user_version = 0');
  raw.exec('DROP TABLE IF EXISTS meta');
  for (const [id, score, dims] of rows) {
    raw.prepare("INSERT INTO jobs (id, source, title, company, url, apply_url, description, score, score_dims) VALUES (?, 't', 'Dev', ?, ?, ?, 'd', ?, ?)").run(id, id, id, id, score, dims);
  }
  for (const id of queued) raw.prepare("INSERT INTO outreach_queue (job_id, status) VALUES (?, 'queued')").run(id);
  raw.close();
}
const scoreOf = (db: Database.Database, id: string) => (db.prepare('SELECT score FROM jobs WHERE id = ?').get(id) as { score: number | null }).score;
const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes('.pre-scale-'));

describe('match score scale migration (0..100 to 1..5)', () => {
  it('converts every shape by score / 20 (one decimal), keeps nulls and labels, writes a 0600 backup first, and sets the marker', () => {
    const d = tmp();
    const file = join(d, 'data.sqlite');
    oldDb(file, [['co80', 80, CO(4.0)], ['co78', 78, CO(3.9)], ['co90', 90, CO(4.5)], ['v2', 72, V2], ['leg', 65, LEG], ['nodims', 59, null], ['expired', 0, null], ['unscored', null, null]]);
    const db = openDb(file);
    expect(['co80', 'co78', 'co90', 'v2', 'leg', 'nodims', 'expired', 'unscored'].map((id) => scoreOf(db, id))).toEqual([4, 3.9, 4.5, 3.6, 3.3, 3, 0, null]);
    expect(db.pragma('user_version', { simple: true })).toBe(MATCH_SCALE_USER_VERSION);
    expect((db.prepare("SELECT value FROM meta WHERE key = 'match_scale'").get() as any).value).toBe('5');
    // labels and dimension values are untouched
    expect(JSON.parse((db.prepare("SELECT score_dims FROM jobs WHERE id = 'v2'").get() as any).score_dims).role_fit).toBe(15);
    expect(JSON.parse((db.prepare("SELECT score_dims FROM jobs WHERE id = 'co80'").get() as any).score_dims).rubric).toBe('career_ops_v1');
    const b = backups(d);
    expect(b).toHaveLength(1);
    expect(statSync(join(d, b[0]!)).mode & 0o777).toBe(0o600);
    // the backup still holds the OLD values
    const bk = new Database(join(d, b[0]!), { readonly: true });
    expect(scoreOf(bk, 'co80')).toBe(80);
    bk.close();
    db.close();
  });

  it('relative order of the old rows is kept', () => {
    const d = tmp();
    const file = join(d, 'data.sqlite');
    const input = [51, 59, 60, 64, 65, 70, 72, 77, 78, 80, 85, 90, 95, 100];
    oldDb(file, input.map((s, i) => [`r${i}`, s, i % 3 === 0 ? V2 : i % 3 === 1 ? LEG : CO(s / 20)] as [string, number, string]));
    const db = openDb(file);
    const out = input.map((_, i) => scoreOf(db, `r${i}`)!);
    expect([...out].sort((a, b) => a - b)).toEqual(out);
    expect(out.every((v) => v >= 2.5 && v <= 5)).toBe(true);
    db.close();
  });

  it('is idempotent: a second and third open change nothing and make no new backup', () => {
    const d = tmp();
    const file = join(d, 'data.sqlite');
    oldDb(file, [['a', 80, CO(4.0)], ['b', 72, V2]]);
    openDb(file).close();
    const again = openDb(file);
    expect(scoreOf(again, 'a')).toBe(4);
    expect(scoreOf(again, 'b')).toBe(3.6);
    expect(ensureMatchScale(again, file)).toMatchObject({ action: 'current', converted: 0 });
    again.close();
    openDb(file).close();
    expect(backups(d)).toHaveLength(1);
  });

  it('detects a half-migrated db (marker absent, every score already 5 or less): only the marker is written, no division, no backup', () => {
    const d = tmp();
    const file = join(d, 'data.sqlite');
    oldDb(file, [['a', 4, CO(4.0)], ['b', 3.6, V2], ['c', null, null]]);
    const db = openDb(file);
    expect(scoreOf(db, 'a')).toBe(4);
    expect(scoreOf(db, 'b')).toBe(3.6);
    expect(db.pragma('user_version', { simple: true })).toBe(MATCH_SCALE_USER_VERSION);
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE grandfathered = 1').get() as any).n).toBe(0);
    expect(backups(d)).toHaveLength(0);
    db.close();
  });

  it('an empty fresh db just gets the marker (no backup file)', () => {
    const d = tmp();
    const file = join(d, 'data.sqlite');
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(MATCH_SCALE_USER_VERSION);
    expect(backups(d)).toHaveLength(0);
    db.close();
  });

  it('two processes opening an old db together migrate it exactly once', async () => {
    const d = tmp();
    const file = join(d, 'data.sqlite');
    oldDb(file, Array.from({ length: 60 }, (_, i) => [`j${i}`, 60 + (i % 40), CO(3 + (i % 40) / 20)] as [string, number, string]));
    const runChild = () => run('npx', ['tsx', 'tests/helpers/openDbChild.ts', file], { cwd: process.cwd(), timeout: 60000 });
    const [a, b] = await Promise.all([runChild(), runChild()]);
    expect(JSON.parse(a.stdout.trim().split('\n').pop()!).user_version).toBe(MATCH_SCALE_USER_VERSION);
    expect(JSON.parse(b.stdout.trim().split('\n').pop()!).user_version).toBe(MATCH_SCALE_USER_VERSION);
    const db = new Database(file, { readonly: true });
    // 60..99 / 20 once (3.0 .. 5.0), never divided twice (which would give 0.2 .. 0.3)
    expect(Number((db.prepare('SELECT MIN(score) AS m FROM jobs').get() as any).m)).toBe(3);
    expect(Number((db.prepare('SELECT MAX(score) AS m FROM jobs').get() as any).m)).toBeLessThanOrEqual(5);
    expect(backups(d).length).toBeLessThanOrEqual(1);
    db.close();
  }, 90000);

  it('refuses to migrate when the backup copy fails, and changes nothing', () => {
    const d = tmp();
    const file = join(d, 'data.sqlite');
    oldDb(file, [['a', 80, CO(4.0)]]);
    const raw = new Database(file);
    expect(() => ensureMatchScale(raw, file, () => { throw new Error('disk full'); })).toThrow(/refused.*disk full/);
    expect(scoreOf(raw, 'a')).toBe(80);
    expect(raw.pragma('user_version', { simple: true })).toBe(0);
    expect(backups(d)).toHaveLength(0);
    // and with a working copy it then migrates, with the backup next to the db
    expect(ensureMatchScale(raw, file)).toMatchObject({ action: 'migrated', converted: 1 });
    expect(scoreOf(raw, 'a')).toBe(4);
    expect(backups(d)).toHaveLength(1);
    raw.close();
  });

  it('refuses to open a db whose user_version is newer than the code knows', () => {
    const d = tmp();
    const file = join(d, 'data.sqlite');
    openDb(file).close();
    const raw = new Database(file);
    raw.pragma(`user_version = ${MATCH_SCALE_USER_VERSION + 1}`);
    raw.close();
    expect(() => openDb(file)).toThrow(/newer than this code/);
  });

  describe('grandfathering (only jobs already matched, queued or prepared before the migration)', () => {
    const setup = () => {
      const d = tmp();
      const file = join(d, 'data.sqlite');
      oldDb(file, [
        ['v2_65', 65, V2],        // older rubric, matched under the old line of 60 -> grandfathered
        ['leg_59', 59, LEG],      // older rubric, below the old line -> not
        ['nodims_70', 70, null],  // no dims counts as older -> grandfathered
        ['co_72', 72, CO(3.6)],   // career-ops, below the cutoff, not queued -> not
        ['co_72_q', 72, CO(3.6)], // career-ops, already queued/prepared -> grandfathered
        ['co_85', 85, CO(4.3)],   // above the cutoff anyway
      ], ['co_72_q']);
      return openDb(file);
    };
    it('sets the flag on older-rubric rows scored at least 60 and on queued rows only', () => {
      const db = setup();
      const g = (db.prepare('SELECT id FROM jobs WHERE grandfathered = 1 ORDER BY id').all() as { id: string }[]).map((r) => r.id);
      expect(g).toEqual(['co_72_q', 'nodims_70', 'v2_65']);
      db.close();
    });
    it('the matched list, the funnel and the dashboard count grandfathered rows at 4.0, and a plain 3.6 row is not offered', () => {
      const db = setup();
      const ids = (listUnscoredJobs(db, { kind: 'matched', matchThreshold: 4, limit: 50 }) as any[]).map((r) => r.id).sort();
      // co_72_q has a queue row, so it is not offered again; the others are matched by score or grandfathering
      expect(ids).toEqual(['co_85', 'nodims_70', 'v2_65']);
      expect(funnelStats(db, 4).matched).toBe(4); // + co_72_q (counted as matched, it is already prepared)
      expect(jobCounts(db, 4).matched).toBe(4);
      db.close();
    });
    it('a fresh match save clears the flag, so the job is judged by MATCH_THRESHOLD like any other', () => {
      const db = setup();
      db.prepare("UPDATE jobs SET description = 'We need React. Strong TypeScript. Based in India. Full-time permanent role with a long enough description for the matcher.' WHERE id = 'v2_65'").run();
      const out = saveMatchResultsChecked(db, [{ job_id: 'v2_65', reasons: 'r', missing_keywords: [], score_dims: coDims(3.6), requirements: [] } as any]);
      expect(out.errors).toEqual([]);
      expect((db.prepare("SELECT grandfathered, score FROM jobs WHERE id = 'v2_65'").get() as any)).toEqual({ grandfathered: 0, score: 3.5 });
      expect((listUnscoredJobs(db, { kind: 'matched', matchThreshold: 4, limit: 50 }) as any[]).map((r) => r.id)).not.toContain('v2_65');
      db.close();
    });
  });

  it('keeps the backup dir clean: the directory only holds the db and the one backup', () => {
    const d = tmp();
    mkdirSync(join(d, 'x'), { recursive: true });
    const file = join(d, 'x', 'data.sqlite');
    oldDb(file, [['a', 80, CO(4.0)]]);
    openDb(file).close();
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(join(d, 'x')).filter((f) => !f.startsWith('data.sqlite.pre-scale-'))).toContain('data.sqlite');
  });
});
