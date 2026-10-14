// tests/safety-threshold-fit.test.ts
import { describe, it, expect } from 'vitest';
import { evaluate, fitThreshold, splitCorpus, type Scored } from '../src/safety/thresholdFit.js';

const s = (id: string, label: 'attack' | 'benign', score: number, category = 'x'): Scored => ({ id, label, score, category });

describe('splitCorpus', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: `i${i}` }));
  it('is deterministic and roughly the requested fraction', () => {
    const a = splitCorpus(items, 'seed', 0.3);
    const b = splitCorpus(items, 'seed', 0.3);
    expect(a.heldOut.map((x) => x.id)).toEqual(b.heldOut.map((x) => x.id));
    expect(a.heldOut.length).toBeGreaterThan(40);
    expect(a.heldOut.length).toBeLessThan(80);
    expect(a.fit.length + a.heldOut.length).toBe(200);
  });
  it('does not reshuffle existing items when items are added', () => {
    const a = splitCorpus(items.slice(0, 100), 'seed', 0.3);
    const b = splitCorpus(items, 'seed', 0.3);
    const inA = new Set(a.heldOut.map((x) => x.id));
    for (const id of inA) expect(b.heldOut.map((x) => x.id)).toContain(id);
  });
});

describe('fitThreshold', () => {
  it('finds the lowest threshold within the benign fpr budget', () => {
    const scores = [
      ...Array.from({ length: 100 }, (_, i) => s(`b${i}`, 'benign', i / 1000)), // 0.000 to 0.099
      s('a1', 'attack', 0.5),
      s('a2', 'attack', 0.8),
      s('a3', 'attack', 0.05),
    ];
    const r = fitThreshold(scores, { maxBenignFpr: 0.01 });
    expect(r.fpr).toBeLessThanOrEqual(0.01);
    expect(r.tpr).toBeCloseTo(2 / 3, 5);
    expect(r.threshold).toBeGreaterThan(0.05);
  });
  it('throws without both classes', () => {
    expect(() => fitThreshold([s('a', 'attack', 0.9)])).toThrow();
  });
});

describe('evaluate', () => {
  it('lists false positives, misses and per-category recall', () => {
    const scores = [
      s('b1', 'benign', 0.9),
      s('b2', 'benign', 0.1),
      s('a1', 'attack', 0.95, 'override'),
      s('a2', 'attack', 0.2, 'paraphrase'),
    ];
    const r = evaluate(scores, 0.5);
    expect(r.falsePositives).toEqual(['b1']);
    expect(r.misses).toEqual(['a2']);
    expect(r.byCategory.override.tpr).toBe(1);
    expect(r.byCategory.paraphrase.tpr).toBe(0);
    expect(r.fpr).toBe(0.5);
  });
});
