// file: src/trimResume.ts
// Relevance-weighted bullet trimming, adapted from MadsLorentzen/ai-job-search 05-cv-templates.md
// "cut by signal, not by section" (MIT, (c) 2026 Mads Lorentzen). The source gives three qualitative axes and no
// formula; the weights are ours: score = 2*relevance + uniqueness (narrative load is not known at render time).
import { termMatches, type KeywordSpec } from './atsKeywords.js';
import { contentTokens } from './proseClaims.js';

export interface BulletScore { exp: number; idx: number; text: string; relevance: number; uniqueness: number; score: number }

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

export function scoreBullets(resume: any, keywords: KeywordSpec[]): BulletScore[] {
  const bullets: Array<{ exp: number; idx: number; text: string }> = [];
  (Array.isArray(resume?.experience) ? resume.experience : []).forEach((e: any, exp: number) => {
    (Array.isArray(e?.description) ? e.description : []).forEach((text: unknown, idx: number) => {
      if (typeof text === 'string' && text.trim()) bullets.push({ exp, idx, text });
    });
  });
  const sets = bullets.map((b) => new Set(contentTokens(b.text)));
  const summary = new Set(contentTokens(typeof resume?.summary === 'string' ? resume.summary : ''));
  return bullets.map((b, i) => {
    // R1: a (near-)verbatim repeat of an EARLIER bullet carries no information; score 0 so it is cut before unique content.
    if (sets.slice(0, i).some((s) => jaccard(sets[i], s) >= 0.9)) return { ...b, relevance: 0, uniqueness: 0, score: 0 };
    const relevance = keywords.reduce((acc, k) => acc + (termMatches(b.text, k.term) ? (k.priority === 'required' ? 2 : 1) : 0), 0);
    const overlap = Math.max(jaccard(sets[i], summary), ...sets.map((s, j) => (j === i ? 0 : jaccard(sets[i], s))));
    const uniqueness = Math.round((1 - overlap) * 100) / 100;
    return { ...b, relevance, uniqueness, score: 2 * relevance + uniqueness };
  });
}

/** Lowest-scoring bullet in a role that still has more than its minimum (2 for the newest role, 1 for older ones). Ties: older role, later bullet. */
export function pickBulletToCut(resume: any, keywords: KeywordSpec[]): { exp: number; idx: number } | null {
  const counts = (Array.isArray(resume?.experience) ? resume.experience : []).map((e: any) => (Array.isArray(e?.description) ? e.description.filter((t: unknown) => typeof t === 'string' && t.trim()).length : 0));
  const candidates = scoreBullets(resume, keywords).filter((b) => counts[b.exp] > (b.exp === 0 ? 2 : 1));
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score || b.exp - a.exp || b.idx - a.idx);
  return { exp: candidates[0].exp, idx: candidates[0].idx };
}

export function removeBullet(resume: any, exp: number, idx: number): any {
  const out = JSON.parse(JSON.stringify(resume));
  out.experience[exp].description.splice(idx, 1);
  return out;
}

export function insertBullet(resume: any, exp: number, idx: number, text: string): any {
  const out = JSON.parse(JSON.stringify(resume));
  out.experience[exp].description.splice(idx, 0, text);
  return out;
}
