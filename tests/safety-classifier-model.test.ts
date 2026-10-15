// tests/safety-classifier-model.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPin, sha256File, verifyModelFiles } from '../src/safety/classifierModel.js';

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

describe('pin hardening', () => {
  const wr = (obj: unknown): string => {
    const p = join(mkdtempSync(join(tmpdir(), 'pin-')), 'pin.json');
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  it('rejects out-of-range malicious_index', () => {
    for (const i of [-3, 99, 2]) expect(() => loadPin(wr({ ...pin, malicious_index: i }))).toThrow();
  });
  it('rejects dot names as file names', () => {
    for (const f of ['.', '..']) expect(() => loadPin(wr({ ...pin, model: { file: f, sha256: HEX } }))).toThrow();
  });
  it('loads the old shape and validates extra entries', () => {
    expect(loadPin(wr(pin)).extra).toEqual([]);
    expect(() => loadPin(wr({ ...pin, extra: [{ file: 'x', sha256: 'nope' }] }))).toThrow();
  });
  it('verifies extra files: missing and mismatch', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mdl-'));
    for (const f of ['model.onnx', 'tokenizer.json', 'config.json']) writeFileSync(join(d, f), 'x');
    const withExtra = { ...pin, extra: [{ file: 'tokenizer_config.json', sha256: 'e'.repeat(64) }] };
    const known: Record<string, string> = { 'model.onnx': HEX, 'tokenizer.json': 'b'.repeat(64), 'config.json': 'c'.repeat(64) };
    const hash = async (file: string): Promise<string> => known[file.split('/').pop() as string] ?? 'f'.repeat(64);
    const absent = await verifyModelFiles(d, withExtra, hash);
    expect(absent.problems.join(' ')).toMatch(/missing file: tokenizer_config.json/);
    writeFileSync(join(d, 'tokenizer_config.json'), 'x');
    const bad = await verifyModelFiles(d, withExtra, hash);
    expect(bad.problems.some((p) => p.includes('tokenizer_config.json') && /sha256/.test(p))).toBe(true);
  });
});
