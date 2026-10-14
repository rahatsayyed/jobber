import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isFullyPinned,
  loadRegistry,
  maliciousIndex,
  modelDir,
  pinFromProfile,
  resolveProfile,
  validateRegistry,
  type ClassifierRegistry,
} from '../src/safety/classifierRegistry.js';

const shipped = (): any => JSON.parse(readFileSync('config/classifier-models.json', 'utf8'));
const H64 = 'a'.repeat(64);
const H40 = 'b'.repeat(40);

function fixture(): any {
  return {
    version: 1,
    default_profile: 'fx',
    profiles: {
      fx: {
        id: 'fx',
        title: 'Fixture',
        gated: false,
        fetchable: true,
        repo: 'own/name',
        revision: 'c'.repeat(40),
        licence: { id: 'MIT', name: 'MIT', url: 'https://example.com', attribution: 'a', redistribution: 'r' },
        limitations: ['x'],
        languages: ['en'],
        files: [
          { remote: 'onnx/model.onnx', local: 'model.onnx', role: 'model', size: 10, sha256: H64, git_blob_sha1: null },
          { remote: 'tokenizer.json', local: 'tokenizer.json', role: 'tokenizer', size: 5, sha256: H64.replace(/a/g, '1'), git_blob_sha1: null },
          { remote: 'config.json', local: 'config.json', role: 'config', size: 5, sha256: H64.replace(/a/g, '2'), git_blob_sha1: null },
          { remote: 'LICENSE', local: 'LICENSE', role: 'licence', size: 5, sha256: H64.replace(/a/g, '3'), git_blob_sha1: null },
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
      },
    },
  };
}

describe('shipped registry', () => {
  it('validates', () => {
    expect(validateRegistry(shipped())).toEqual([]);
  });
  it('default profile facts', () => {
    const reg = loadRegistry();
    expect(reg.default_profile).toBe('protectai-deberta-v3-base-v2');
    const p = reg.profiles['protectai-deberta-v3-base-v2'];
    expect(p.gated).toBe(false);
    expect(p.fetchable).toBe(true);
    expect(p.licence.id).toBe('Apache-2.0');
    expect(p.revision).toBe('90c9989b1a342275dd0d1a95aad283c04e075671');
    expect(p.malicious_label).toBe('INJECTION');
    expect(maliciousIndex(p)).toBe(1);
    expect(p.files).toHaveLength(8);
  });
  it('llama profile is gated and manual', () => {
    const p = loadRegistry().profiles['llama-prompt-guard-2-22m'];
    expect(p.gated).toBe(true);
    expect(p.fetchable).toBe(false);
    expect(p.licence.id).toBe('Llama-4-Community-License');
    expect(p.manual_steps && p.manual_steps.length).toBeGreaterThan(0);
    expect(maliciousIndex(p)).toBe(1);
  });
  it('placeholder llama revision is never fully pinned', () => {
    const p = loadRegistry().profiles['llama-prompt-guard-2-22m'];
    expect(p.revision).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(isFullyPinned(p)).toBe(false);
    expect(() => pinFromProfile(p)).toThrow(/models -- pin/);
  });
  it('loadRegistry throws with problems on an invalid file', () => {
    expect(() => loadRegistry(join('tests', 'does-not-exist.json'))).toThrow();
  });
});

describe('validateRegistry rejections', () => {
  const cases: Array<[string, (r: any) => void, RegExp?]> = [
    ['version 2', (r) => (r.version = 2)],
    ['default missing', (r) => (r.default_profile = 'nope')],
    ['id mismatch', (r) => (r.profiles.fx.id = 'other')],
    ['revision main', (r) => (r.profiles.fx.revision = 'main')],
    ['revision 39 hex', (r) => (r.profiles.fx.revision = 'c'.repeat(39))],
    ['revision uppercase', (r) => (r.profiles.fx.revision = 'C'.repeat(40))],
    ['bad repo', (r) => (r.profiles.fx.repo = 'noslash')],
    ['remote with ..', (r) => (r.profiles.fx.files[0].remote = 'a/../b')],
    ['absolute remote', (r) => (r.profiles.fx.files[0].remote = '/etc/passwd')],
    ['local with slash', (r) => (r.profiles.fx.files[0].local = 'a/b')],
    ['size zero', (r) => (r.profiles.fx.files[0].size = 0)],
    ['size too big', (r) => (r.profiles.fx.files[0].size = 2 * 1024 ** 3 + 1)],
    ['labels three', (r) => (r.profiles.fx.labels['2'] = 'X')],
    ['labels equal', (r) => (r.profiles.fx.labels['0'] = 'INJECTION')],
    ['malicious not in labels', (r) => (r.profiles.fx.malicious_label = 'EVIL')],
    ['gated but fetchable', (r) => (r.profiles.fx.gated = true)],
    ['fetchable no licence', (r) => (r.profiles.fx.files.pop())],
    ['unknown key', (r) => (r.profiles.fx.extra_key = 1)],
    ['no digest', (r) => (r.profiles.fx.files[0].sha256 = null)],
    ['max_tokens 1024', (r) => (r.profiles.fx.max_tokens = 1024)],
    ['inputs missing input_ids', (r) => (r.profiles.fx.inputs = ['attention_mask'])],
    ['inputs unknown name', (r) => (r.profiles.fx.inputs = ['input_ids', 'foo'])],
    ['threshold 1.5', (r) => (r.profiles.fx.fit.threshold = 1.5)],
    ['stride too large', (r) => (r.profiles.fx.stride = 510)],
    ['max_chunks 65', (r) => (r.profiles.fx.max_chunks = 65)],
    ['empty special token', (r) => (r.profiles.fx.special_tokens.cls = '')],
    ['two model files', (r) => r.profiles.fx.files.push({ ...r.profiles.fx.files[0], local: 'm2.onnx' })],
  ];
  it('accepts the fixture', () => {
    expect(validateRegistry(fixture())).toEqual([]);
  });
  for (const [name, mut] of cases) {
    it(`rejects ${name}`, () => {
      const r = fixture();
      mut(r);
      expect(validateRegistry(r).length).toBeGreaterThan(0);
    });
  }
  it('gated profile needs manual_steps', () => {
    const r = fixture();
    r.profiles.fx.gated = true;
    r.profiles.fx.fetchable = false;
    expect(validateRegistry(r).length).toBeGreaterThan(0);
    r.profiles.fx.manual_steps = ['do it'];
    expect(validateRegistry(r)).toEqual([]);
  });
  it('non-fetchable profile may have files with both digests null; fetchable may not', () => {
    const r = fixture();
    r.profiles.fx.fetchable = false;
    r.profiles.fx.files[0].sha256 = null;
    r.profiles.fx.files[0].git_blob_sha1 = null;
    expect(validateRegistry(r)).toEqual([]);
    r.profiles.fx.fetchable = true;
    expect(validateRegistry(r).length).toBeGreaterThan(0);
  });
  it('accepts git blob id instead of sha256', () => {
    const r = fixture();
    r.profiles.fx.files[1].sha256 = null;
    r.profiles.fx.files[1].git_blob_sha1 = H40;
    expect(validateRegistry(r)).toEqual([]);
  });
  it('non-object input is rejected', () => {
    expect(validateRegistry(null).length).toBeGreaterThan(0);
  });
});

describe('resolveProfile', () => {
  const reg = fixture() as ClassifierRegistry;
  it('unset throws mentioning env var and setup', () => {
    expect(() => resolveProfile(reg, {})).toThrow(/CLASSIFIER_MODEL[\s\S]*npm run setup/);
  });
  it('unknown lists known ids', () => {
    expect(() => resolveProfile(reg, { CLASSIFIER_MODEL: 'zzz' })).toThrow(/fx/);
  });
  it('valid and trimmed', () => {
    expect(resolveProfile(reg, { CLASSIFIER_MODEL: '  fx \n' }).id).toBe('fx');
  });
  it('path-like id throws', () => {
    expect(() => resolveProfile(reg, { CLASSIFIER_MODEL: '../x' })).toThrow();
  });
});

describe('pin and dir', () => {
  it('pinFromProfile throws for shipped default with null digests', () => {
    const p = loadRegistry().profiles['protectai-deberta-v3-base-v2'];
    expect(isFullyPinned(p)).toBe(false);
    expect(() => pinFromProfile(p)).toThrow(/models -- pin/);
  });
  it('pinFromProfile succeeds for fully pinned fixture', () => {
    const p = (fixture() as ClassifierRegistry).profiles.fx;
    expect(isFullyPinned(p)).toBe(true);
    const pin = pinFromProfile(p);
    expect(pin.model.file).toBe('model.onnx');
    expect(pin.tokenizer.file).toBe('tokenizer.json');
    expect(pin.config.file).toBe('config.json');
    expect(pin.extra?.map((e) => e.file)).toEqual(['LICENSE']);
    expect(pin.malicious_index).toBe(1);
    expect(pin.source).toBe(`own/name@${'c'.repeat(40)}`);
  });
  it('placeholder revision makes a fully digested profile not pinned', () => {
    const p = { ...(fixture() as ClassifierRegistry).profiles.fx, revision: '0123456789abcdef0123456789abcdef01234567' };
    expect(isFullyPinned(p)).toBe(false);
    expect(() => pinFromProfile(p)).toThrow(/models -- pin/);
  });
  it('modelDir stays under models/', () => {
    const p = (fixture() as ClassifierRegistry).profiles.fx;
    expect(modelDir(p, '/r')).toBe(join('/r', 'models', 'fx'));
    expect(() => modelDir({ ...p, id: '../x' }, '/r')).toThrow();
  });
});
