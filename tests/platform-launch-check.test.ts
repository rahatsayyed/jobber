// tests/platform-launch-check.test.ts
import { describe, it, expect } from 'vitest';
import { checkClassifierForLaunch } from '../src/platform/launchCheck.js';
import type { ClassifierProfile, ClassifierRegistry } from '../src/safety/classifierRegistry.js';
import type { VerifyReport } from '../src/safety/modelFetch.js';

const H = 'a'.repeat(64);
function profile(over: Partial<ClassifierProfile> = {}): ClassifierProfile {
  return {
    id: 'p1',
    title: 't',
    gated: false,
    fetchable: true,
    repo: 'o/r',
    revision: '1'.repeat(40),
    licence: { id: 'x', name: 'x', url: 'x', attribution: 'x', redistribution: 'x' },
    limitations: [],
    languages: ['en'],
    files: [{ remote: 'm.onnx', local: 'm.onnx', role: 'model', size: 10, sha256: H, git_blob_sha1: null }],
    labels: { '0': 'benign', '1': 'malicious' },
    malicious_label: 'malicious',
    max_tokens: 512,
    stride: 64,
    max_chunks: 8,
    special_tokens: { cls: '[CLS]', sep: '[SEP]' },
    inputs: ['input_ids'],
    output: 'logits',
    fit: { threshold: 0.4, model_sha256: H },
    ...over,
  };
}
const reg = (p: ClassifierProfile): ClassifierRegistry => ({ version: 1, default_profile: p.id, profiles: { [p.id]: p } });
const okReport: VerifyReport = { ok: true, problems: [], observed_sha256: {}, unpinned: [] };
const deps = (p: ClassifierProfile, r: VerifyReport = okReport) => ({
  loadRegistry: () => reg(p),
  verifyProfile: async () => r,
});

describe('checkClassifierForLaunch', () => {
  it('fails when CLASSIFIER_MODEL is unset', async () => {
    const r = await checkClassifierForLaunch({}, '/r', false, deps(profile()));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/CLASSIFIER_MODEL/);
  });
  it('fails for an unknown id', async () => {
    const r = await checkClassifierForLaunch({ CLASSIFIER_MODEL: 'nope' }, '/r', false, deps(profile()));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/unknown/);
  });
  it('fails when files are missing', async () => {
    const bad: VerifyReport = { ok: false, problems: ['m.onnx: missing'], observed_sha256: {}, unpinned: [] };
    const r = await checkClassifierForLaunch({ CLASSIFIER_MODEL: 'p1' }, '/r', true, deps(profile(), bad));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/missing/);
  });
  it('fails when not fully pinned, even in a dry run', async () => {
    const p = profile({ files: [{ remote: 'm', local: 'm.onnx', role: 'model', size: 10, sha256: null, git_blob_sha1: 'b'.repeat(40) }] });
    const r = await checkClassifierForLaunch({ CLASSIFIER_MODEL: 'p1' }, '/r', true, deps(p));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/pinned/);
  });
  it('unfitted fails live and passes dry', async () => {
    const p = profile({ fit: { threshold: null } });
    const env = { CLASSIFIER_MODEL: 'p1' };
    expect((await checkClassifierForLaunch(env, '/r', false, deps(p))).ok).toBe(false);
    expect((await checkClassifierForLaunch(env, '/r', true, deps(p))).ok).toBe(true);
  });
  it('model_sha256 mismatch fails live', async () => {
    const p = profile({ fit: { threshold: 0.4, model_sha256: 'c'.repeat(64) } });
    const r = await checkClassifierForLaunch({ CLASSIFIER_MODEL: 'p1' }, '/r', false, deps(p));
    expect(r.ok).toBe(false);
  });
  it('fitted and verified passes', async () => {
    const r = await checkClassifierForLaunch({ CLASSIFIER_MODEL: 'p1' }, '/r', false, deps(profile()));
    expect(r).toEqual({ ok: true, problems: [], profileId: 'p1' });
  });
});
