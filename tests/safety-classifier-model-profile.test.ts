// tests/safety-classifier-model-profile.test.ts
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadClassifier, sha256File, type AdapterDeps, type SessionLike } from '../src/safety/classifierModel.js';
import type { ClassifierProfile } from '../src/safety/classifierRegistry.js';

interface Fx {
  root: string;
  profile: ClassifierProfile;
  modelPath: string;
}

async function fixture(over: Partial<ClassifierProfile> = {}, fitThreshold: number | null = 0.5): Promise<Fx> {
  const root = mkdtempSync(join(tmpdir(), 'prof-'));
  const id = 'fake-model';
  const dir = join(root, 'models', id);
  mkdirSync(dir, { recursive: true });
  const names: Array<[string, 'model' | 'tokenizer' | 'config']> = [
    ['model.onnx', 'model'],
    ['tokenizer.json', 'tokenizer'],
    ['config.json', 'config'],
  ];
  const files = [];
  for (const [n, role] of names) {
    writeFileSync(join(dir, n), `content-${n}`);
    files.push({ remote: n, local: n, role, size: 10, sha256: await sha256File(join(dir, n)), git_blob_sha1: null });
  }
  const modelSha = files[0].sha256 as string;
  const profile: ClassifierProfile = {
    id,
    title: 'Fake',
    gated: false,
    fetchable: true,
    repo: 'o/r',
    revision: 'a'.repeat(40),
    licence: { id: 'x', name: 'x', url: 'x', attribution: 'x', redistribution: 'x' },
    limitations: [],
    languages: ['en'],
    files,
    labels: { '0': 'SAFE', '1': 'INJECTION' },
    malicious_label: 'INJECTION',
    max_tokens: 512,
    stride: 64,
    max_chunks: 8,
    special_tokens: { cls: '[CLS]', sep: '[SEP]' },
    inputs: ['input_ids', 'attention_mask'],
    output: 'logits',
    fit: { threshold: fitThreshold, model_sha256: modelSha },
    ...over,
  };
  return { root, profile, modelPath: join(dir, 'model.onnx') };
}

function deps(opts: {
  logits?: number[];
  inputNames?: string[];
  outputNames?: string[];
  tokens?: number;
  seen?: number[][];
  spec?: { cls: string; sep: string }[];
}): AdapterDeps {
  const session: SessionLike = {
    inputNames: opts.inputNames ?? ['input_ids', 'attention_mask'],
    outputNames: opts.outputNames ?? ['logits'],
    run: async (feeds) => {
      opts.seen?.push(Array.from(feeds.input_ids.data as BigInt64Array, Number));
      return { logits: { data: opts.logits ?? [0, 5] } };
    },
  };
  return {
    createSession: async () => session,
    loadTokenizer: async (_d, spec) => {
      if (spec) opts.spec?.push(spec);
      return { encode: () => Array.from({ length: opts.tokens ?? 3 }, (_, i) => 100 + i), clsId: 1, sepId: 2 };
    },
  };
}

describe('loadClassifier with a profile', () => {
  it('derives the malicious index from the labels', async () => {
    const a = await fixture();
    const la = await loadClassifier({ profile: a.profile, root: a.root, deps: deps({ logits: [0, 5] }) });
    expect((await la.classifier.classify('x')).malicious).toBe(true);
    expect(la.profileId).toBe('fake-model');
    const b = await fixture({ labels: { '0': 'INJECTION', '1': 'SAFE' } });
    const lb = await loadClassifier({ profile: b.profile, root: b.root, deps: deps({ logits: [5, 0] }) });
    expect((await lb.classifier.classify('x')).malicious).toBe(true);
    const lc = await loadClassifier({ profile: b.profile, root: b.root, deps: deps({ logits: [0, 5] }) });
    expect((await lc.classifier.classify('x')).malicious).toBe(false);
  });

  it('passes special_tokens to the tokenizer loader', async () => {
    const f = await fixture({ special_tokens: { cls: '<s>', sep: '</s>' } });
    const spec: { cls: string; sep: string }[] = [];
    await loadClassifier({ profile: f.profile, root: f.root, deps: deps({ spec }) });
    expect(spec).toEqual([{ cls: '<s>', sep: '</s>' }]);
  });

  it('windows by max_tokens - 2', async () => {
    const f = await fixture({ max_tokens: 128, stride: 0, max_chunks: 8 });
    const seen: number[][] = [];
    const l = await loadClassifier({ profile: f.profile, root: f.root, deps: deps({ tokens: 300, seen }) });
    await l.classifier.classify('x');
    expect(seen.length).toBeGreaterThan(1);
    for (const ids of seen) expect(ids.length - 2).toBeLessThanOrEqual(126);
    expect(Math.max(...seen.map((s) => s.length - 2))).toBe(126);
  });

  it('refuses when session inputs differ from the profile', async () => {
    const f = await fixture();
    await expect(
      loadClassifier({ profile: f.profile, root: f.root, deps: deps({ inputNames: ['input_ids', 'attention_mask', 'token_type_ids'] }) }),
    ).rejects.toThrow(/inputs differ from profile fake-model/);
    await expect(
      loadClassifier({ profile: f.profile, root: f.root, deps: deps({ inputNames: ['input_ids'] }) }),
    ).rejects.toThrow(/inputs differ/);
  });

  it('refuses when the output name is missing', async () => {
    const f = await fixture();
    await expect(loadClassifier({ profile: f.profile, root: f.root, deps: deps({ outputNames: ['other'] }) })).rejects.toThrow(/output/);
  });

  it('refuses a profile that is not fully pinned', async () => {
    const f = await fixture();
    f.profile.files[0].sha256 = null;
    await expect(loadClassifier({ profile: f.profile, root: f.root, deps: deps({}) })).rejects.toThrow(
      /not fully pinned: run npm run models -- pin fake-model/,
    );
  });

  it('refuses when a model byte changed', async () => {
    const f = await fixture();
    writeFileSync(f.modelPath, 'tampered');
    await expect(loadClassifier({ profile: f.profile, root: f.root, deps: deps({}) })).rejects.toThrow(
      /classifier integrity check failed: .*model\.onnx/,
    );
  });

  it('treats a fit for another model file as unfitted', async () => {
    const f = await fixture();
    f.profile.fit = { threshold: 0.9, model_sha256: 'd'.repeat(64) };
    await expect(loadClassifier({ profile: f.profile, root: f.root, deps: deps({}) })).rejects.toThrow(
      /no fitted threshold for this model file/,
    );
    const l = await loadClassifier({ profile: f.profile, root: f.root, deps: deps({ logits: [0, 0.4] }), allowUnfitted: true });
    expect(l.threshold).toBe(0.5);
  });

  it('refuses a null threshold unless allowUnfitted', async () => {
    const f = await fixture({}, null);
    await expect(loadClassifier({ profile: f.profile, root: f.root, deps: deps({}) })).rejects.toThrow(/no fitted threshold/);
  });

  it('uses the fitted threshold', async () => {
    // softmax([0, 0.405]) -> p about 0.6
    const hi = await fixture({}, 0.9);
    const l1 = await loadClassifier({ profile: hi.profile, root: hi.root, deps: deps({ logits: [0, 0.405] }) });
    expect(l1.threshold).toBe(0.9);
    expect((await l1.classifier.classify('x')).malicious).toBe(false);
    const lo = await fixture({}, 0.5);
    const l2 = await loadClassifier({ profile: lo.profile, root: lo.root, deps: deps({ logits: [0, 0.405] }) });
    expect((await l2.classifier.classify('x')).malicious).toBe(true);
  });
});
