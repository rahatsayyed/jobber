// Minimal-diff registry writes: `models pin` and the fit writer change only the values that differ.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRegistry, writeFit } from '../src/safety/classifierRegistry.js';
import { pinProfile } from '../src/safety/modelFetch.js';
import { patchJsonText } from '../src/safety/jsonPatch.js';
import { runCli } from '../scripts/models.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const blob = (b: Buffer): string =>
  createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const MODEL = Buffer.from('model-bytes-0123');
const TOK = Buffer.from('{"tok":1}');
const CFG = Buffer.from('{"cfg":1}');
const LIC = Buffer.from('licence text');

// The hand-formatted style of config/classifier-models.json: compact one-object-per-line file entries.
function fixture(tokSha: string | null): string {
  const f = (remote: string, role: string, b: Buffer, s: string | null) =>
    `        { "remote": "${remote}", "local": "${remote}", "role": "${role}", "size": ${b.length}, "sha256": ${s === null ? 'null' : `"${s}"`}, "git_blob_sha1": ${s === null ? `"${blob(b)}"` : 'null'} }`;
  return [
    '{',
    '  "version": 1,',
    '  "default_profile": "fx",',
    '  "profiles": {',
    '    "fx": {',
    '      "id": "fx",',
    '      "title": "Fixture",',
    '      "gated": false,',
    '      "fetchable": true,',
    '      "repo": "own/fx",',
    `      "revision": "${'c'.repeat(40)}",`,
    '      "licence": { "id": "MIT", "name": "MIT", "url": "https://example.com", "attribution": "a", "redistribution": "r" },',
    '      "limitations": ["x"],',
    '      "languages": ["en"],',
    '      "files": [',
    [f('model.onnx', 'model', MODEL, sha(MODEL)), f('tokenizer.json', 'tokenizer', TOK, tokSha), f('config.json', 'config', CFG, sha(CFG)), f('LICENSE', 'licence', LIC, sha(LIC))].join(',\n'),
    '      ],',
    '      "labels": { "0": "SAFE", "1": "INJECTION" },',
    '      "malicious_label": "INJECTION",',
    '      "max_tokens": 512,',
    '      "stride": 64,',
    '      "max_chunks": 16,',
    '      "special_tokens": { "cls": "[CLS]", "sep": "[SEP]" },',
    '      "inputs": ["input_ids", "attention_mask"],',
    '      "output": "logits",',
    '      "fit": {',
    '        "threshold": 0.5,',
    '        "fitted_at": "2026-10-14T00:00:00.000Z",',
    `        "model_sha256": "${sha(MODEL)}",`,
    '        "max_benign_fpr": 0.01,',
    '        "held_out": { "tpr": 0.9, "fpr": 0, "n": 30 },',
    '        "corpus": { "attacks": 10, "benign": 20, "seed": "s", "held_out_fraction": 0.3 },',
    '        "by_category": { "x": { "n": 3, "tpr": 1 } }',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

let dir: string;
let regPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobber-regfmt-'));
  regPath = join(dir, 'reg.json');
  mkdirSync(join(dir, 'models', 'fx'), { recursive: true });
  writeFileSync(join(dir, 'models', 'fx', 'model.onnx'), MODEL);
  writeFileSync(join(dir, 'models', 'fx', 'tokenizer.json'), TOK);
  writeFileSync(join(dir, 'models', 'fx', 'config.json'), CFG);
  writeFileSync(join(dir, 'models', 'fx', 'LICENSE'), LIC);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const changedLines = (a: string, b: string): number => {
  const x = a.split('\n');
  const y = b.split('\n');
  expect(y.length).toBe(x.length);
  return x.filter((l, i) => l !== y[i]).length;
};

describe('models pin keeps the file format', () => {
  it('changes only the one digest line and keeps the compact entries', async () => {
    const before = fixture(null);
    writeFileSync(regPath, before);
    const p = loadRegistry(regPath).profiles.fx;
    const r = await pinProfile(p, dir, regPath);
    expect(r.written).toEqual(['tokenizer.json']);
    const after = readFileSync(regPath, 'utf8');
    expect(changedLines(before, after)).toBe(1);
    expect(after).toBe(before.replace('"sha256": null', `"sha256": "${sha(TOK)}"`));
  });

  it('is idempotent: a fully pinned profile writes nothing and the CLI says already pinned', async () => {
    const before = fixture(sha(TOK));
    writeFileSync(regPath, before);
    const lines: string[] = [];
    const code = await runCli(['pin', 'fx'], {
      registryPath: regPath, root: dir, env: {}, out: (l) => lines.push(l),
      fetchDeps: { fetch: async () => { throw new Error('no network'); }, log: () => {} },
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('already pinned');
    expect(readFileSync(regPath, 'utf8')).toBe(before);
  });
});

describe('fit writer keeps the file format', () => {
  const fit = (threshold: number) => ({
    threshold,
    fitted_at: '2026-10-14T00:00:00.000Z',
    model_sha256: sha(MODEL),
    max_benign_fpr: 0.01,
    held_out: { tpr: 0.9, fpr: 0, n: 30 },
    corpus: { attacks: 10, benign: 20, seed: 's', held_out_fraction: 0.3 },
    by_category: { x: { n: 3, tpr: 1 } },
  });

  it('writes only the changed threshold field', () => {
    const before = fixture(sha(TOK));
    writeFileSync(regPath, before);
    expect(writeFit(regPath, 'fx', fit(0.75))).toBe(true);
    const after = readFileSync(regPath, 'utf8');
    expect(changedLines(before, after)).toBe(1);
    expect(after).toBe(before.replace('"threshold": 0.5,', '"threshold": 0.75,'));
  });

  it('writes nothing when the fit is unchanged', () => {
    const before = fixture(sha(TOK));
    writeFileSync(regPath, before);
    expect(writeFit(regPath, 'fx', fit(0.5))).toBe(false);
    expect(readFileSync(regPath, 'utf8')).toBe(before);
  });

  it('a structural change rewrites only the fit block', () => {
    const before = fixture(sha(TOK));
    writeFileSync(regPath, before);
    const rec = { ...fit(0.6), by_category: { x: { n: 3, tpr: 1 }, y: { n: 2, tpr: 0.5 } } };
    expect(writeFit(regPath, 'fx', rec)).toBe(true);
    const after = readFileSync(regPath, 'utf8');
    const head = before.slice(0, before.indexOf('"fit": {'));
    expect(after.startsWith(head)).toBe(true);
    expect(JSON.parse(after).profiles.fx.fit).toEqual(rec);
  });
});

describe('patchJsonText', () => {
  it('replaces a scalar inside a compact line and rejects a missing path', () => {
    const t = '{\n  "a": { "b": 1, "c": [1, 2] }\n}\n';
    expect(patchJsonText(t, ['a'], { b: 2, c: [1, 2] })).toBe('{\n  "a": { "b": 2, "c": [1, 2] }\n}\n');
    expect(() => patchJsonText(t, ['nope'], 1)).toThrow(/not found/);
  });
});
