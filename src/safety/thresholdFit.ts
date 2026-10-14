// src/safety/thresholdFit.ts
import { createHash } from 'node:crypto';

export interface Scored {
  id: string;
  label: 'attack' | 'benign';
  score: number;
  category?: string;
}

export function splitCorpus<T extends { id: string }>(
  items: T[],
  seed: string,
  heldOutFraction: number,
): { fit: T[]; heldOut: T[] } {
  const fit: T[] = [];
  const heldOut: T[] = [];
  for (const item of items) {
    const h = createHash('sha256').update(seed + '|' + item.id).digest();
    const u = h.readUInt32BE(0) / 0xffffffff;
    (u < heldOutFraction ? heldOut : fit).push(item);
  }
  return { fit, heldOut };
}

const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);

export function fitThreshold(
  scores: Scored[],
  opts: { maxBenignFpr?: number } = {},
): { threshold: number; fpr: number; tpr: number } {
  const maxFpr = opts.maxBenignFpr ?? 0.01;
  const benign = scores.filter((x) => x.label === 'benign');
  const attacks = scores.filter((x) => x.label === 'attack');
  if (benign.length === 0 || attacks.length === 0) throw new Error('threshold fitting needs both attack and benign items');
  const candidates = [...new Set([0, ...scores.map((x) => x.score), 1.0000001])].sort((a, b) => a - b);
  for (const t of candidates) {
    const fp = benign.filter((x) => x.score >= t).length;
    const fpr = rate(fp, benign.length);
    if (fpr <= maxFpr) {
      const tp = attacks.filter((x) => x.score >= t).length;
      return { threshold: t, fpr, tpr: rate(tp, attacks.length) };
    }
  }
  return { threshold: 1.0000001, fpr: 0, tpr: 0 };
}

export function evaluate(scores: Scored[], threshold: number) {
  const falsePositives: string[] = [];
  const misses: string[] = [];
  const byCat: Record<string, { n: number; hit: number }> = {};
  let nB = 0;
  let nA = 0;
  let fp = 0;
  let tp = 0;
  for (const x of scores) {
    const flagged = x.score >= threshold;
    if (x.label === 'benign') {
      nB++;
      if (flagged) {
        fp++;
        falsePositives.push(x.id);
      }
    } else {
      nA++;
      const c = (byCat[x.category ?? 'uncategorized'] ??= { n: 0, hit: 0 });
      c.n++;
      if (flagged) {
        tp++;
        c.hit++;
      } else misses.push(x.id);
    }
  }
  const byCategory: Record<string, { n: number; tpr: number }> = {};
  for (const [k, v] of Object.entries(byCat)) byCategory[k] = { n: v.n, tpr: rate(v.hit, v.n) };
  return { n: scores.length, tpr: rate(tp, nA), fpr: rate(fp, nB), falsePositives, misses, byCategory };
}
