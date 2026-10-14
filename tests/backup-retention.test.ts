import { describe, expect, it } from 'vitest';
import { BACKUP_NAME_RE, backupName, planRetention } from '../src/backup/retention.js';

const DAY = 86_400_000;
const now = new Date(Date.UTC(2026, 9, 14, 12, 0, 0));
const at = (daysAgo: number, hour = 3) => {
  const d = new Date(Date.UTC(2026, 9, 14, hour, 15, 0) - daysAgo * DAY);
  return backupName(d);
};

describe('backupName', () => {
  it('formats a UTC name that matches the regex', () => {
    const n = backupName(new Date(Date.UTC(2026, 9, 14, 3, 15, 0)));
    expect(n).toBe('jobber-backup-20261014T031500Z.tar.gz.age');
    expect(BACKUP_NAME_RE.test(n)).toBe(true);
  });
});

describe('planRetention', () => {
  it('keeps expected counts for 40 daily names with 7/4/6', () => {
    const names = Array.from({ length: 40 }, (_, i) => at(i));
    const { keep, remove } = planRetention(names, { daily: 7, weekly: 4, monthly: 6 }, now);
    expect(keep.length + remove.length / 2).toBe(40);
    for (let i = 0; i < 7; i++) expect(keep).toContain(at(i));
    expect(keep.length).toBeGreaterThan(7);
    expect(keep.length).toBeLessThan(20);
    expect(remove).toContain(`${at(39)}.sha256`);
  });

  it('keeps all of 3 daily backups with 7/0/0', () => {
    const names = [at(0), at(1), at(2)];
    const { keep, remove } = planRetention(names, { daily: 7, weekly: 0, monthly: 0 }, now);
    expect(keep.sort()).toEqual([...names].sort());
    expect(remove).toEqual([]);
  });

  it('never touches stray names', () => {
    const { keep, remove } = planRetention(
      ['notes.txt', 'jobber-backup-bad.tar.gz.age', at(0)],
      { daily: 1, weekly: 0, monthly: 0 },
      now,
    );
    expect(keep).toEqual([at(0)]);
    expect(remove).toEqual([]);
  });

  it('keeps the newest with an all-zero policy', () => {
    const names = [at(5), at(0), at(9)];
    const { keep, remove } = planRetention(names, { daily: 0, weekly: 0, monthly: 0 }, now);
    expect(keep).toEqual([at(0)]);
    expect(remove).toEqual([at(5), `${at(5)}.sha256`, at(9), `${at(9)}.sha256`]);
  });

  it('keeps only the newer of two backups in one day', () => {
    const older = at(1, 2);
    const newer = at(1, 20);
    const { keep, remove } = planRetention([older, newer, at(0)], { daily: 7, weekly: 0, monthly: 0 }, now);
    expect(keep).toContain(newer);
    expect(keep).not.toContain(older);
    expect(remove).toEqual([older, `${older}.sha256`]);
  });

  it('is deterministic across input order', () => {
    const names = Array.from({ length: 30 }, (_, i) => at(i * 2));
    const a = planRetention(names, { daily: 3, weekly: 2, monthly: 2 }, now);
    const b = planRetention([...names].reverse(), { daily: 3, weekly: 2, monthly: 2 }, now);
    expect(b).toEqual(a);
  });

  it('buckets by the UTC date in the name', () => {
    const late = 'jobber-backup-20261013T233000Z.tar.gz.age';
    const early = 'jobber-backup-20261014T003000Z.tar.gz.age';
    const { keep } = planRetention([late, early], { daily: 7, weekly: 0, monthly: 0 }, now);
    expect(keep.sort()).toEqual([early, late].sort());
  });

  it('drops names with impossible dates from both lists', () => {
    const bad = 'jobber-backup-20261340T000000Z.tar.gz.age';
    const { keep, remove } = planRetention([bad, at(0)], { daily: 1, weekly: 0, monthly: 0 }, now);
    expect([...keep, ...remove]).not.toContain(bad);
  });
});
