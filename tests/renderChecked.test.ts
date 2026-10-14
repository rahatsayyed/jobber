import { describe, it, expect } from 'vitest';
import { getBaseResume, renderResumeChecked } from '../src/resume.js';

const W = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'glade', 'harbor', 'iris', 'juniper', 'kelp', 'lotus', 'maple'];
const fold =(s: string) => s.split(/\s+/).join(' ').trim();
const dupes = (resume: any): string[] => {
  const all: string[] = resume.experience.flatMap((e: any) => e.description.map(fold));
  return all.filter((b, i) => all.indexOf(b) !== i);
};

describe('renderResumeChecked (real renders)', () => {
  it('drops duplicates and keeps unique bullets even when duplicates carry keywords (R1)', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    t.experience[0].description = [...t.experience[0].description, ...t.experience[0].description.slice(0, 5)];
    const r = await renderResumeChecked(t, { keywords: [{ term: 'React', priority: 'required' }, { term: 'TypeScript', priority: 'required' }] });
    expect(dupes(r.resume)).toEqual([]);
    expect(r.resume.experience[0].description.some((b: string) => b.startsWith('Coordinated cross-functional'))).toBe(true);
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
    expect(r.fillRatio).toBeGreaterThan(0.5);
    expect(r.ats).toBeNull();
  }, 120_000);

  it('trims duplicated low-relevance bullets until the page fits, and classifies keywords', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    // 3 duplicated bullets overflow the page by about 3 bullets, within the default 6 trims.
    t.experience[0].description = [...t.experience[0].description, ...t.experience[0].description.slice(0, 3)];
    const r = await renderResumeChecked(t, { keywords: [{ term: 'React', priority: 'required' }, { term: 'Kubernetes', priority: 'required' }] });
    expect(r.trimmed.length).toBeGreaterThan(0);
    expect(r.resume.experience[0].description.length).toBeLessThan(t.experience[0].description.length);
    expect(dupes(r.resume)).toEqual([]);
    expect(r.ats).toEqual([
      { term: 'React', priority: 'required', status: 'covered' },
      { term: 'Kubernetes', priority: 'required', status: 'gap' },
    ]);
    expect(r.atsCoverage).toBe(50);
  }, 300_000);

  it('refuses to render an unsupported claim', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    t.summary += ' Comfortable owning products end to end.';
    await expect(renderResumeChecked(t)).rejects.toThrow(/Resume fact check failed.*scope:ownership/);
  }, 60_000);
});
