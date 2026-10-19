import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { getBaseResume, renderResumeChecked } from '../src/resume.js';

// These tests need a base resume that fills about one page (the shipped example is far shorter), so they use a
// synthetic full-page fixture instead of user-data.example.
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'render');
let savedUserData: string | undefined;
beforeAll(() => { savedUserData = process.env.JOBAPPLIER_USER_DATA; process.env.JOBAPPLIER_USER_DATA = FIXTURE_DIR; });
afterAll(() => { if (savedUserData === undefined) delete process.env.JOBAPPLIER_USER_DATA; else process.env.JOBAPPLIER_USER_DATA = savedUserData; });

const W = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'glade', 'harbor', 'iris', 'juniper', 'kelp', 'lotus', 'maple'];
const fold =(s: string) => s.split(/\s+/).join(' ').trim();
const dupes = (resume: any): string[] => {
  const all: string[] = resume.experience.flatMap((e: any) => e.description.map(fold));
  return all.filter((b, i) => all.indexOf(b) !== i);
};

/** The base resume with `n` extra copies of its first experience's bullets appended (cycling). */
function padded(base: any, n: number): any {
  const t = JSON.parse(JSON.stringify(base));
  const src: string[] = t.experience[0].description;
  t.experience[0].description = [...src, ...Array.from({ length: n }, (_, i) => src[i % src.length])];
  return t;
}
// How many extra bullets push the page over depends on the browser's layout and on the example resume, so measure it
// instead of assuming: render the base and base + 5 bullets, take the fill-ratio slope per bullet, and size from that.
async function overflowCount(base: any): Promise<number> {
  const f0 = (await renderResumeChecked(base)).fillRatio ?? 0.5;
  const f5 = (await renderResumeChecked(padded(base, 5))).fillRatio ?? f0;
  const slope = (f5 - f0) / 5;
  return slope > 0 ? Math.ceil((1 - f0) / slope) + 3 : 40;
}
const uniqueSurvive = (base: any, resume: any) => {
  const kept = new Set<string>(resume.experience[0].description.map(fold));
  return base.experience[0].description.every((b: string) => kept.has(fold(b)));
};

describe('renderResumeChecked (real renders)', () => {
  it('drops duplicates and keeps unique bullets even when duplicates carry keywords (R1)', async () => {
    const base = getBaseResume();
    const n = await overflowCount(base);
    const t = padded(base, n);
    const r = await renderResumeChecked(t, { maxTrims: n + 2, keywords: [{ term: 'React', priority: 'required' }, { term: 'TypeScript', priority: 'required' }] });
    expect(r.trimmed.length).toBeGreaterThan(0);
    // the repeats (score 0) are cut before unique content: the original bullets of the newest role all survive, on one page
    expect(uniqueSurvive(base, r.resume)).toBe(true);
    expect(r.resume.experience[0].description.length).toBeLessThan(t.experience[0].description.length);
    expect(dupes(r.resume).length).toBeLessThan(dupes(t).length);
  }, 300_000);

  it('reports exhausted trimming with the cut bullets, keeping the page-count prefix', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    t.experience[0].description = Array.from({ length: 40 }, (_, i) => `Delivered ${W[i % 8]} ${W[(i * 3 + 1) % 8]} ${W[Math.floor(i / 8) + 8]} improvements for platform teams.`); // no digits: they would trip the metric gate
    await expect(renderResumeChecked(t, { maxTrims: 2 })).rejects.toThrow(/expected 1 pages, got \d+.*trimming exhausted after 2 trims; cut: "/);
  }, 300_000);

  it('renders the base resume on one page with a fill ratio and no trims', async () => {
    const r = await renderResumeChecked(getBaseResume());
    expect(r.trimmed).toEqual([]);
    expect(r.facts.verdict).not.toBe('block');
    expect(r.fillRatio).toBeGreaterThan(0.3);
    expect(r.fillRatio).toBeLessThanOrEqual(1);
    expect(r.ats).toBeNull();
  }, 120_000);

  it('trims duplicated low-relevance bullets until the page fits, and classifies keywords', async () => {
    const base = getBaseResume();
    const n = await overflowCount(base);
    const t = padded(base, n); // the duplicated bullets overflow the page; trimming has to fit it again
    const r = await renderResumeChecked(t, { maxTrims: n + 2, keywords: [{ term: 'React', priority: 'required' }, { term: 'Kubernetes', priority: 'required' }] });
    expect(r.trimmed.length).toBeGreaterThan(0);
    expect(r.resume.experience[0].description.length).toBeLessThan(t.experience[0].description.length);
    expect(uniqueSurvive(base, r.resume)).toBe(true);
    expect(r.ats?.map((a) => a.term)).toEqual(['React', 'Kubernetes']);
    expect(r.ats?.find((a) => a.term === 'Kubernetes')?.status).toBe('gap'); // the example resume never mentions it
    expect(r.atsCoverage).toBeLessThan(100);
  }, 300_000);

  it('refuses to render an unsupported claim', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    t.summary += ' Comfortable owning products end to end.';
    await expect(renderResumeChecked(t)).rejects.toThrow(/Resume fact check failed.*scope:ownership/);
  }, 60_000);
});
