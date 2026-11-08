import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditPortals, keywordProblem } from '../src/sources/portalsAudit.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'audit-'));
function write(portals: unknown, platforms?: unknown, seed?: unknown) {
  const d = dir();
  const p = { portals: path.join(d, 'portals.json'), platforms: path.join(d, 'platforms.json'), seed: path.join(d, 'seed.json') };
  writeFileSync(p.portals, JSON.stringify(portals));
  writeFileSync(p.platforms, JSON.stringify(platforms ?? { platforms: [] }));
  if (seed) writeFileSync(p.seed, JSON.stringify(seed));
  return p;
}
const good = { tracked_companies: [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }], title_filter: { positive: ['react'], negative: ['word:intern'] }, location_filter: { allow: ['india'] } };

describe('auditPortals', () => {
  it('the shipped config is clean', () => {
    const r = auditPortals();
    expect(r.findings).toEqual([]);
  });
  it('a good config has no errors', () => {
    expect(auditPortals(write(good)).errors).toBe(0);
  });
  it('finds bad slug, duplicate, unknown ats, placeholder, bad prefix, both-lists', () => {
    const r = auditPortals(write({
      tracked_companies: [
        { name: 'A', ats: 'greenhouse', slug: 'a', enabled: true },
        { name: 'A2', ats: 'greenhouse', slug: 'A', enabled: true },
        { name: 'B', ats: 'notavendor', slug: 'b', enabled: true },
        { name: 'C', ats: 'recruitee', slug: 'Bad_Slug', enabled: true },
        { name: 'D', ats: 'lever', slug: 'example', enabled: true },
        { name: 'E', ats: 'workday', slug: 'e', enabled: true },
      ],
      title_filter: { positive: ['react', 'wrod:x', ''], negative: ['react'] },
      location_filter: { allow: ['india'], exclude: ['india'] },
      max_posting_age_days: 'x', early_stop_by_age: true,
    }));
    const msgs = r.findings.map((x) => `${x.level}|${x.where}|${x.message}`).join('\n');
    expect(msgs).toMatch(/error\|.*tracked_companies\[1\].*duplicate/);
    expect(msgs).toMatch(/unknown ats "notavendor"/);
    expect(msgs).toMatch(/tracked_companies\[3\].*invalid slug/);
    expect(msgs).toMatch(/warning\|.*tracked_companies\[4\].*placeholder/);
    expect(msgs).toMatch(/tracked_companies\[5\].*workday needs wd/);
    expect(msgs).toMatch(/unknown prefix "wrod:"/);
    expect(msgs).toMatch(/empty keyword/);
    expect(msgs).toMatch(/both positive and negative/);
    expect(msgs).toMatch(/both allowed and excluded/);
    expect(msgs).toMatch(/max_posting_age_days.*must be a number/);
    expect(r.errors).toBeGreaterThan(3);
  });
  it('flags enabled-but-unverified and missing files, platforms with a missing provider module', () => {
    const r = auditPortals(write(
      { ...good, tracked_companies: [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true, note: 'unverified example' }] },
      { platforms: [{ id: 'ghost', kind: 'api', label: 'Ghost', provider: 'nothere', tier: 'script', enabled: true, stability: 'fixture' }] },
    ));
    const msgs = r.findings.map((x) => x.message).join('\n');
    expect(msgs).toMatch(/check-portal/);
    expect(msgs).toMatch(/provider module "nothere" not found/);
    expect(auditPortals({ portals: '/nonexistent/p.json', platforms: '/nonexistent/q.json', seed: '/nonexistent/s.json' }).errors).toBe(2);
  });
  it('checks the seed list', () => {
    const r = auditPortals(write(good, undefined, { companies: [{ name: 'X', hint: { ats: 'lever', slug: 'Bad Slug' } }, { name: 'x' }, { nope: 1 }] }));
    expect(r.findings.filter((x) => x.where.startsWith('portals-seed')).length).toBe(3);
  });
  it('keywordProblem', () => {
    expect(keywordProblem('word:staff')).toBeNull();
    expect(keywordProblem('react + native')).toBeNull();
    expect(keywordProblem('stem:')).toMatch(/no word/);
    expect(keywordProblem('a + ')).toMatch(/empty part/);
  });
});
