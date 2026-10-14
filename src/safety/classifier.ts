// src/safety/classifier.ts
export interface TokenizerLike {
  encode(text: string): number[];
  clsId: number;
  sepId: number;
}
export type ModelRunner = (inputIds: number[]) => Promise<number[]>;

export interface ClassifierConfig {
  threshold: number;
  windowTokens: number;
  stride: number;
  maxChunks: number;
  maliciousIndex: number;
}

export interface ClassifierVerdict {
  malicious: boolean;
  score: number;
  chunks: number;
  truncated: boolean;
}

export interface InjectionClassifier {
  classify(text: string): Promise<ClassifierVerdict>;
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  threshold: 0.5,
  windowTokens: 510,
  stride: 64,
  maxChunks: 16,
  maliciousIndex: 1,
};

export function chunkIds(
  ids: number[],
  window: number,
  stride: number,
  maxChunks: number,
): { chunks: number[][]; truncated: boolean } {
  if (window < 2 || stride < 0 || stride >= window) throw new Error('invalid chunk window or stride');
  if (ids.length === 0) return { chunks: [], truncated: false };
  const step = window - stride;
  const chunks: number[][] = [];
  for (let start = 0; ; start += step) {
    chunks.push(ids.slice(start, start + window));
    if (start + window >= ids.length) break;
    if (chunks.length > maxChunks) return { chunks: chunks.slice(0, maxChunks), truncated: true };
  }
  return chunks.length > maxChunks
    ? { chunks: chunks.slice(0, maxChunks), truncated: true }
    : { chunks, truncated: false };
}

export function maliciousProbability(logits: number[], maliciousIndex: number): number {
  if (maliciousIndex < 0 || maliciousIndex >= logits.length) throw new Error('malicious index out of range');
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps[maliciousIndex] / sum;
}

export function createClassifier(deps: {
  tokenizer: TokenizerLike;
  run: ModelRunner;
  config: ClassifierConfig;
}): InjectionClassifier {
  const { tokenizer, run, config } = deps;
  let queue: Promise<unknown> = Promise.resolve();

  const classifyNow = async (text: string): Promise<ClassifierVerdict> => {
    if (text.trim() === '') return { malicious: false, score: 0, chunks: 0, truncated: false };
    const ids = tokenizer.encode(text);
    const { chunks, truncated } = chunkIds(ids, config.windowTokens, config.stride, config.maxChunks);
    let score = 0;
    for (const chunk of chunks) {
      const logits = await run([tokenizer.clsId, ...chunk, tokenizer.sepId]);
      const p = maliciousProbability(logits, config.maliciousIndex);
      // A non-finite probability (NaN or Infinity logits) is unreadable output: fail closed.
      if (!Number.isFinite(p)) return { malicious: true, score: 1, chunks: chunks.length, truncated };
      score = Math.max(score, p);
    }
    // Input that needs more windows than allowed is unreviewed text: fail closed.
    return { malicious: truncated || score >= config.threshold, score, chunks: chunks.length, truncated };
  };

  return {
    classify(text: string): Promise<ClassifierVerdict> {
      const next = queue.then(() => classifyNow(text));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
