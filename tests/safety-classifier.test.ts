// tests/safety-classifier.test.ts
import { describe, it, expect } from 'vitest';
import {
  chunkIds,
  createClassifier,
  DEFAULT_CLASSIFIER_CONFIG,
  maliciousProbability,
  percentile,
  type ModelRunner,
  type TokenizerLike,
} from '../src/safety/classifier.js';

describe('percentile', () => {
  it('uses nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([], 50)).toBe(0);
  });
});

const EVIL = 999;
// word "EVIL" -> token 999, every other word -> token 7
const tokenizer: TokenizerLike = {
  encode: (t) => t.split(/\s+/).filter(Boolean).map((w) => (w === 'EVIL' ? EVIL : 7)),
  clsId: 1,
  sepId: 2,
};
const calls: number[][] = [];
const run: ModelRunner = async (ids) => {
  calls.push(ids);
  return ids.includes(EVIL) ? [0, 6] : [6, 0];
};
const cfg = { ...DEFAULT_CLASSIFIER_CONFIG, windowTokens: 10, stride: 3, maxChunks: 5 };

describe('chunkIds', () => {
  it('returns one chunk for short input', () => {
    expect(chunkIds([1, 2, 3], 10, 3, 5)).toEqual({ chunks: [[1, 2, 3]], truncated: false });
  });
  it('overlaps windows and ends on the last token', () => {
    const ids = Array.from({ length: 20 }, (_, i) => i);
    const { chunks, truncated } = chunkIds(ids, 10, 3, 5);
    expect(truncated).toBe(false);
    expect(chunks[0]).toEqual(ids.slice(0, 10));
    expect(chunks[1][0]).toBe(7); // step = 10 - 3
    expect(chunks[chunks.length - 1].at(-1)).toBe(19);
  });
  it('reports truncation when more windows than maxChunks are needed', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i);
    expect(chunkIds(ids, 10, 3, 5).truncated).toBe(true);
  });
  it('rejects a stride that is not smaller than the window', () => {
    expect(() => chunkIds([1], 10, 10, 5)).toThrow();
  });
});

describe('maliciousProbability', () => {
  it('is a softmax over the logits', () => {
    expect(maliciousProbability([0, 0], 1)).toBeCloseTo(0.5);
    expect(maliciousProbability([0, 20], 1)).toBeGreaterThan(0.99);
    expect(maliciousProbability([20, 0], 1)).toBeLessThan(0.01);
  });
});

describe('createClassifier', () => {
  it('does not call the model for empty text', async () => {
    calls.length = 0;
    const v = await createClassifier({ tokenizer, run, config: cfg }).classify('   ');
    expect(v).toEqual({ malicious: false, score: 0, chunks: 0, truncated: false });
    expect(calls).toHaveLength(0);
  });

  it('wraps each window in CLS and SEP', async () => {
    calls.length = 0;
    await createClassifier({ tokenizer, run, config: cfg }).classify('a b c');
    expect(calls[0][0]).toBe(1);
    expect(calls[0].at(-1)).toBe(2);
  });

  it('flags a payload that sits in the last window after benign padding', async () => {
    const text = Array.from({ length: 25 }, () => 'hello').join(' ') + ' EVIL';
    const v = await createClassifier({ tokenizer, run, config: { ...cfg, maxChunks: 10 } }).classify(text);
    expect(v.malicious).toBe(true);
    expect(v.chunks).toBeGreaterThan(1);
  });

  it('catches a payload that straddles a window boundary only through the overlap', async () => {
    // EVIL at index 9 is the last token of window 0 and also inside window 1 (starts at 7).
    const words = Array.from({ length: 20 }, () => 'hello');
    words[9] = 'EVIL';
    const v = await createClassifier({ tokenizer, run, config: cfg }).classify(words.join(' '));
    expect(v.malicious).toBe(true);
  });

  it('is malicious and truncated when the input needs more windows than allowed (fail closed)', async () => {
    const text = Array.from({ length: 500 }, () => 'hello').join(' ');
    const v = await createClassifier({ tokenizer, run, config: cfg }).classify(text);
    expect(v.truncated).toBe(true);
    expect(v.malicious).toBe(true);
  });

  it('serializes concurrent calls', async () => {
    let active = 0;
    let maxActive = 0;
    const slow: ModelRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return [6, 0];
    };
    const c = createClassifier({ tokenizer, run: slow, config: cfg });
    await Promise.all([c.classify('a'), c.classify('b'), c.classify('c')]);
    expect(maxActive).toBe(1);
  });

  it('fails closed on non-finite logits', async () => {
    for (const bad of [[NaN, NaN], [Infinity, Infinity]]) {
      const r: ModelRunner = async () => bad;
      const v = await createClassifier({ tokenizer, run: r, config: cfg }).classify('a');
      expect(v.malicious).toBe(true);
    }
  });

  it('respects the threshold', async () => {
    const mid: ModelRunner = async () => [0, 0.4]; // p about 0.6
    const lo = await createClassifier({ tokenizer, run: mid, config: { ...cfg, threshold: 0.9 } }).classify('a');
    const hi = await createClassifier({ tokenizer, run: mid, config: { ...cfg, threshold: 0.5 } }).classify('a');
    expect(lo.malicious).toBe(false);
    expect(hi.malicious).toBe(true);
  });
});
