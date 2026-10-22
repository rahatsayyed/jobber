import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentUse, getActiveClassifier, _resetActiveClassifierForTests } from '../src/safety/classifierSelect.js';
import { gateInputAsync } from '../src/safety/inputGate.js';
import type { ClassifierRegistry } from '../src/safety/classifierRegistry.js';

const prof = (id: string) => ({
  id,
  files: [{ role: 'model', local: 'm.onnx', sha256: 'a'.repeat(64) }],
});
const reg = { version: 1, default_profile: 'p1', profiles: { p1: prof('p1'), p2: prof('p2') } } as unknown as ClassifierRegistry;

function mk(opts: { fail?: boolean; unfitted?: boolean } = {}) {
  const load = vi.fn(async (o: any) => {
    if (opts.fail) throw new Error('boom');
    if (opts.unfitted && !o.allowUnfitted) throw new Error('has no fitted threshold');
    return {
      classifier: { classify: async () => ({ malicious: false, score: 0.1, truncated: false }) },
      profileId: o.profile.id,
      threshold: 0.5,
    } as any;
  });
  const warn = vi.fn();
  const deps = (model: string | undefined, extra: Record<string, string> = {}) => ({
    loadRegistry: () => reg,
    load,
    warn,
    env: { ...(model ? { CLASSIFIER_MODEL: model } : {}), ...extra } as NodeJS.ProcessEnv,
  });
  return { load, warn, deps };
}

beforeEach(() => _resetActiveClassifierForTests());

describe('currentUse', () => {
  it('dry only for 1 or true (any case); unset and everything else is send', () => {
    expect(currentUse({})).toBe('send');
    expect(currentUse({ JOBBER_DRY_RUN: '1' })).toBe('dry_run');
    expect(currentUse({ JOBBER_DRY_RUN: 'true' })).toBe('dry_run');
    expect(currentUse({ JOBBER_DRY_RUN: ' TRUE ' })).toBe('dry_run');
    expect(currentUse({ JOBBER_DRY_RUN: 'false' })).toBe('send');
    expect(currentUse({ JOBBER_DRY_RUN: '0' })).toBe('send');
    expect(currentUse({ SCHEDULER_DRY_RUN: 'true' })).toBe('send');
  });
});

describe('getActiveClassifier', () => {
  it('rejects when CLASSIFIER_MODEL is unset or unknown, without loading', async () => {
    const m = mk();
    await expect(getActiveClassifier('send', m.deps(undefined))).rejects.toThrow(/CLASSIFIER_MODEL/);
    await expect(getActiveClassifier('send', m.deps('nope'))).rejects.toThrow(/unknown/);
    expect(m.load).not.toHaveBeenCalled();
  });
  it('send refuses unfitted; dry_run resolves and warns once', async () => {
    const m = mk({ unfitted: true });
    await expect(getActiveClassifier('send', m.deps('p1'))).rejects.toThrow(/fitted/);
    expect(m.load.mock.calls[0][0].allowUnfitted).toBe(false);
    expect(m.warn).not.toHaveBeenCalled();
    _resetActiveClassifierForTests();
    const port = await getActiveClassifier('dry_run', m.deps('p1'));
    expect(m.load.mock.calls[1][0].allowUnfitted).toBe(true);
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(m.warn.mock.calls[0][0]).toBe('classifier profile p1 is unfitted: dry run only');
    expect((await port.classify('x')).malicious).toBe(false);
  });
  it('defaults use from env', async () => {
    const m = mk({ unfitted: true });
    await getActiveClassifier(undefined, m.deps('p1', { JOBBER_DRY_RUN: '1' }));
    expect(m.load.mock.calls[0][0].allowUnfitted).toBe(true);
  });
  it('reuses the same key and refuses a different model', async () => {
    const m = mk();
    await getActiveClassifier('send', m.deps('p1'));
    await getActiveClassifier('send', m.deps('p1'));
    expect(m.load).toHaveBeenCalledTimes(1);
    await expect(getActiveClassifier('send', m.deps('p2'))).rejects.toThrow('classifier already loaded for p1');
    expect(m.load).toHaveBeenCalledTimes(1);
  });
  it('does not cache a rejected load', async () => {
    const bad = mk({ fail: true });
    await expect(getActiveClassifier('send', bad.deps('p1'))).rejects.toThrow('boom');
    const good = mk();
    await getActiveClassifier('send', good.deps('p1'));
    expect(good.load).toHaveBeenCalledTimes(1);
  });
  it('integrates with the gate', async () => {
    const un = mk({ unfitted: true });
    const r = await gateInputAsync('hello', { classifier: () => getActiveClassifier('send', un.deps('p1')), requireClassifier: true });
    expect(r.blocked).toBe(true);
    expect(JSON.stringify(r)).toContain('classifier_unavailable');
    _resetActiveClassifierForTests();
    const ok = mk();
    const r2 = await gateInputAsync('hello', { classifier: () => getActiveClassifier('send', ok.deps('p1')), requireClassifier: true });
    expect(r2.blocked).toBe(false);
  });
});

describe('CLASSIFIER_MODEL .env fallback and failure reason', () => {
  it('falls back to only the CLASSIFIER_MODEL key from root/.env when process env lacks it; process env wins', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'clsenv-'));
    writeFileSync(join(root, '.env'), 'CLASSIFIER_MODEL=p2\nJOBBER_DRY_RUN=true\nOTHER=x\n');
    const m = mk();
    await getActiveClassifier('send', { ...m.deps(undefined), root });
    expect(m.load.mock.calls[0][0].profile.id).toBe('p2');
    _resetActiveClassifierForTests();
    await getActiveClassifier('send', { ...m.deps('p1'), root });
    expect(m.load.mock.calls[1][0].profile.id).toBe('p1');
    // only the CLASSIFIER_MODEL key is read: the dry-run flag in .env is not applied
    expect(m.load.mock.calls[0][0].allowUnfitted).toBe(false);
  });

  it('falls back to root/.env on the real MCP path: deps.env is process.env and no root is passed (cwd is the root)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'clsenv-'));
    writeFileSync(join(root, '.env'), 'CLASSIFIER_MODEL=p2\n');
    const saved = process.env.CLASSIFIER_MODEL;
    delete process.env.CLASSIFIER_MODEL;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const m = mk();
      await getActiveClassifier('send', { ...m.deps(undefined), env: process.env });
      expect(m.load.mock.calls[0][0].profile.id).toBe('p2');
    } finally {
      cwd.mockRestore();
      if (saved !== undefined) process.env.CLASSIFIER_MODEL = saved;
    }
  });

  it('writes a one-line error message (no page text) to stderr when the classifier fails, still fail-closed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = mk({ fail: true });
    const r = await gateInputAsync('SECRET PAGE TEXT', {
      classifier: () => getActiveClassifier('send', m.deps('p1')),
      requireClassifier: true,
    });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    spy.mockRestore();
    expect(r.blocked).toBe(true);
    expect(r.flags).toContain('classifier_unavailable');
    expect(out).toMatch(/boom/);
    expect(out).not.toMatch(/SECRET PAGE TEXT/);
    expect(out.trim().split('\n')).toHaveLength(1);
  });
});
