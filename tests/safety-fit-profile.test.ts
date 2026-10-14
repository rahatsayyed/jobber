import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFit } from '../src/safety/classifierRegistry.js';
import { buildFitRecord, heldOutTooSmall, parseFitArgs } from '../src/safety/fitRecord.js';

const H = (c: string): string => c.repeat(64);
function reg(): any {
  const p = (id: string): any => ({
    id,
    title: id,
    gated: false,
    fetchable: true,
    repo: 'own/name',
    revision: 'c'.repeat(40),
    licence: { id: 'MIT', name: 'MIT', url: 'https://example.com', attribution: 'a', redistribution: 'r' },
    limitations: ['x'],
    languages: ['en'],
    files: [
      { remote: 'm.onnx', local: 'model.onnx', role: 'model', size: 10, sha256: H('a'), git_blob_sha1: null },
      { remote: 't.json', local: 'tokenizer.json', role: 'tokenizer', size: 5, sha256: H('1'), git_blob_sha1: null },
      { remote: 'c.json', local: 'config.json', role: 'config', size: 5, sha256: H('2'), git_blob_sha1: null },
      { remote: 'LICENSE', local: 'LICENSE', role: 'licence', size: 5, sha256: H('3'), git_blob_sha1: null },
    ],
    labels: { '0': 'SAFE', '1': 'INJECTION' },
    malicious_label: 'INJECTION',
    max_tokens: 512,
    stride: 64,
    max_chunks: 16,
    special_tokens: { cls: '[CLS]', sep: '[SEP]' },
    inputs: ['input_ids', 'attention_mask'],
    output: 'logits',
    fit: { threshold: null },
  });
  return { version: 1, default_profile: 'one', profiles: { one: p('one'), two: p('two') } };
}
const DIR = join('.superpowers', 'tmp-tests', 'fit-profile');
const file = join(DIR, 'registry.json');
const fitRec = {
  threshold: 0.42,
  fitted_at: '2026-10-14T00:00:00.000Z',
  model_sha256: H('a'),
  max_benign_fpr: 0.01,
  held_out: { tpr: 0.9, fpr: 0, n: 30 },
  corpus: { attacks: 10, benign: 20, seed: 's', held_out_fraction: 0.3 },
  by_category: { x: { n: 3, tpr: 1 } },
};

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(reg(), null, 2) + '\n');
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe('writeFit', () => {
  it('changes only the named profile fit', () => {
    const before = JSON.parse(readFileSync(file, 'utf8'));
    writeFit(file, 'two', fitRec);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.profiles.two.fit).toEqual(fitRec);
    expect(after.profiles.one).toEqual(before.profiles.one);
    after.profiles.two.fit = before.profiles.two.fit;
    expect(after).toEqual(before);
    expect(readdirSync(DIR)).toEqual(['registry.json']);
  });
  it('rejects thresholds outside [0,1] and leaves the file untouched', () => {
    const raw = readFileSync(file, 'utf8');
    for (const t of [1.0000001, -0.1, Number.NaN]) {
      expect(() => writeFit(file, 'one', { ...fitRec, threshold: t })).toThrow();
    }
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(readdirSync(DIR)).toEqual(['registry.json']);
  });
  it('rejects an unknown profile id and leaves the file untouched', () => {
    const raw = readFileSync(file, 'utf8');
    expect(() => writeFit(file, 'nope', fitRec)).toThrow(/unknown profile/);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
  it('refuses to write when the existing registry is invalid', () => {
    const bad = reg();
    bad.profiles.one.max_tokens = 3;
    writeFileSync(file, JSON.stringify(bad));
    const raw = readFileSync(file, 'utf8');
    expect(() => writeFit(file, 'two', fitRec)).toThrow(/invalid/);
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe('parseFitArgs', () => {
  const r = reg();
  it('takes --profile and defaults from CLASSIFIER_MODEL', () => {
    expect(parseFitArgs(['--profile', 'two'], {}, r).profileId).toBe('two');
    expect(parseFitArgs([], { CLASSIFIER_MODEL: 'one' }, r).profileId).toBe('one');
    const a = parseFitArgs(['--profile', 'one', '--write', '--force-small', '--max-fpr', '0.02'], {}, r);
    expect(a).toMatchObject({ write: true, forceSmall: true, maxFpr: 0.02, seed: 'jobber-2026-10', heldFrac: 0.3 });
  });
  it('ignores CLASSIFIER_MODEL_DIR and requires a known profile', () => {
    expect(() => parseFitArgs([], {}, r)).toThrow(/CLASSIFIER_MODEL/);
    expect(() => parseFitArgs(['--profile', 'zzz'], {}, r)).toThrow(/unknown/);
    expect(parseFitArgs(['--profile', 'one'], { CLASSIFIER_MODEL_DIR: '/x' }, r).profileId).toBe('one');
  });
  it('rejects --profile without a value', () => {
    expect(() => parseFitArgs(['--profile'], { CLASSIFIER_MODEL: 'one' }, r)).toThrow(/requires a value/);
    expect(() => parseFitArgs(['--profile', '--write'], { CLASSIFIER_MODEL: 'one' }, r)).toThrow(/requires a value/);
  });
  it('rejects --pin with the pointer', () => {
    expect(() => parseFitArgs(['--pin', '--profile', 'one'], {}, r)).toThrow('use: npm run models -- pin one');
  });
  it('rejects bad numeric options', () => {
    expect(() => parseFitArgs(['--profile', 'one', '--max-fpr', '2'], {}, r)).toThrow();
    expect(() => parseFitArgs(['--profile', 'one', '--held-out', 'x'], {}, r)).toThrow();
  });
});

describe('buildFitRecord and small-sample', () => {
  it('builds the record with held-out fields and by_category', () => {
    const rec = buildFitRecord({
      threshold: 0.5,
      modelSha256: H('a'),
      maxFpr: 0.01,
      held: { tpr: 0.8, fpr: 0.05, n: 12, byCategory: { direct: { n: 4, tpr: 0.75 } } },
      attacks: 7,
      benign: 9,
      seed: 'sd',
      heldFrac: 0.3,
      now: new Date('2026-10-14T00:00:00Z'),
    });
    expect(rec).toEqual({
      threshold: 0.5,
      fitted_at: '2026-10-14T00:00:00.000Z',
      model_sha256: H('a'),
      max_benign_fpr: 0.01,
      held_out: { tpr: 0.8, fpr: 0.05, n: 12 },
      corpus: { attacks: 7, benign: 9, seed: 'sd', held_out_fraction: 0.3 },
      by_category: { direct: { n: 4, tpr: 0.75 } },
    });
  });
  it('flags held-out sets under 20 benign or 10 attack', () => {
    expect(heldOutTooSmall(20, 10)).toBe(false);
    expect(heldOutTooSmall(19, 10)).toBe(true);
    expect(heldOutTooSmall(20, 9)).toBe(true);
  });
});
