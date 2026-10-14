// tests/safety-classifier-model.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadClassifier, loadPin, sha256File, verifyModelFiles, type AdapterDeps } from '../src/safety/classifierModel.js';

const HEX = 'a'.repeat(64);
const pin = {
  model: { file: 'model.onnx', sha256: HEX },
  tokenizer: { file: 'tokenizer.json', sha256: 'b'.repeat(64) },
  config: { file: 'config.json', sha256: 'c'.repeat(64) },
  malicious_index: 1,
  source: 'test',
};

describe('loadPin', () => {
  it('rejects a pin with a bad digest', () => {
    const d = mkdtempSync(join(tmpdir(), 'pin-'));
    const p = join(d, 'pin.json');
    writeFileSync(p, JSON.stringify({ ...pin, model: { file: 'model.onnx', sha256: 'zz' } }));
    expect(() => loadPin(p)).toThrow();
  });
  it('accepts the shipped pin file shape', () => {
    const d = mkdtempSync(join(tmpdir(), 'pin-'));
    const p = join(d, 'pin.json');
    writeFileSync(p, JSON.stringify(pin));
    expect(loadPin(p).malicious_index).toBe(1);
  });
});

describe('verifyModelFiles', () => {
  it('reports a missing file', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mdl-'));
    const r = await verifyModelFiles(d, pin, async () => HEX);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/missing/);
  });
  it('reports a digest mismatch by file name without printing content', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mdl-'));
    for (const f of ['model.onnx', 'tokenizer.json', 'config.json']) writeFileSync(join(d, f), 'x');
    const r = await verifyModelFiles(d, pin, async () => 'd'.repeat(64));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes('model.onnx') && /sha256/.test(p))).toBe(true);
  });
  it('passes when all digests match', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mdl-'));
    const files: Record<string, string> = { 'model.onnx': HEX, 'tokenizer.json': 'b'.repeat(64), 'config.json': 'c'.repeat(64) };
    for (const f of Object.keys(files)) writeFileSync(join(d, f), 'x');
    const r = await verifyModelFiles(d, pin, async (file) => files[file.split('/').pop() as string]);
    expect(r.ok).toBe(true);
  });
  it('sha256File hashes a known string', async () => {
    const d = mkdtempSync(join(tmpdir(), 'h-'));
    const f = join(d, 'a.txt');
    writeFileSync(f, 'abc');
    expect(await sha256File(f)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('loadClassifier with fake adapters', () => {
  it('refuses to load when verification fails', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mdl-'));
    const p = join(d, 'pin.json');
    writeFileSync(p, JSON.stringify(pin));
    await expect(loadClassifier({ dir: d, pinPath: p })).rejects.toThrow(/integrity|missing/i);
  });

  it('feeds input_ids and attention_mask by the names the session reports and reads logits', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mdl-'));
    for (const f of ['model.onnx', 'tokenizer.json', 'config.json']) writeFileSync(join(d, f), 'x');
    const p = join(d, 'pin.json');
    writeFileSync(p, JSON.stringify({
      ...pin,
      model: { file: 'model.onnx', sha256: await sha256File(join(d, 'model.onnx')) },
      tokenizer: { file: 'tokenizer.json', sha256: await sha256File(join(d, 'tokenizer.json')) },
      config: { file: 'config.json', sha256: await sha256File(join(d, 'config.json')) },
    }));
    const seen: string[] = [];
    const deps: AdapterDeps = {
      createSession: async () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['logits'],
        run: async (feeds) => {
          seen.push(...Object.keys(feeds));
          return { logits: { data: [0, 5] } };
        },
      }),
      loadTokenizer: async () => ({ encode: () => [7, 7], clsId: 1, sepId: 2 }),
    };
    const loaded = await loadClassifier({ dir: d, pinPath: p, deps });
    const v = await loaded.classifier.classify('hello world');
    expect(v.malicious).toBe(true);
    expect(seen).toEqual(['input_ids', 'attention_mask']);
  });
});
