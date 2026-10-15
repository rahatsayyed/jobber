// tests/bootstrap-model.test.ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runBootstrap, type ExecDeps, type ExecOptions } from '../src/bootstrap/exec.js';
import { buildCatalog } from '../src/bootstrap/catalog.js';
import type { CliDeps } from '../scripts/models.js';
import type { FetchDeps } from '../src/safety/modelFetch.js';

const BODY = Buffer.from('model-bytes');
const SHA = createHash('sha256').update(BODY).digest('hex');
const BLOB = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${BODY.length}\0`), BODY])).digest('hex');
const file = (local: string, role: string, sha: string | null) => ({ remote: local, local, role, size: BODY.length, sha256: sha, git_blob_sha1: sha ? null : BLOB });
function registry(): unknown {
  const base = {
    title: 'Test model', fetchable: true, repo: 'org/repo', revision: 'b'.repeat(40),
    licence: { id: 'apache-2.0', name: 'Apache', url: 'https://x.test/l', attribution: 'by Org', redistribution: 'ok' },
    limitations: ['English only'], languages: ['en'], labels: { '0': 'benign', '1': 'malicious' }, malicious_label: 'malicious',
    max_tokens: 512, stride: 64, max_chunks: 4, special_tokens: { cls: '[CLS]', sep: '[SEP]' }, inputs: ['input_ids'], output: 'logits', fit: { threshold: null },
  };
  return {
    version: 1, default_profile: 'good',
    profiles: {
      good: { ...base, id: 'good', gated: false, files: [file('model.onnx', 'model', SHA), file('tokenizer.json', 'tokenizer', null), file('config.json', 'config', null), file('LICENSE', 'licence', null)] },
      gated: { ...base, id: 'gated', gated: true, fetchable: false, manual_steps: ['accept the licence on the model page'], files: [file('model.onnx', 'model', null)] },
    },
  };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bs-model-'));
  mkdirSync(join(root, 'config'));
  const registryPath = join(root, 'config', 'classifier-models.json');
  writeFileSync(registryPath, JSON.stringify(registry()));
  const put = (bad = false): void => {
    mkdirSync(join(root, 'models', 'good'), { recursive: true });
    writeFileSync(join(root, 'models', 'good', 'model.onnx'), bad ? 'wrong-bytes' : BODY);
    for (const f of ['tokenizer.json', 'config.json', 'LICENSE']) writeFileSync(join(root, 'models', 'good', f), BODY);
  };
  const net = { calls: 0, bad: false };
  const fetchDeps: FetchDeps = {
    fetch: async () => {
      net.calls++;
      put(net.bad);
      throw new Error('fake network stop');
    },
    log: () => {},
  };
  const cli: CliDeps = { registryPath, root, env: {}, out: () => {}, fetchDeps };
  return { root, cli, net, put, registryPath };
}
function mkExec(root: string, said: string[], asks: string[]): ExecDeps {
  return {
    platform: 'darwin', root, env: {}, now: () => new Date(0),
    fs: { exists: () => false, read: () => '', list: () => [] },
    run: (async () => ({ code: 0, stdout: '' })) as ExecDeps['run'],
    exec: async () => ({ code: 0 }),
    ask: async (p) => { asks.push(p); return true; },
    say: (l) => { said.push(l); },
    download: async () => { throw new Error('no'); },
    mkTempDir: () => root,
  };
}
const O = (o: Partial<ExecOptions> = {}): ExecOptions => ({ yes: false, allowSudo: false, checkOnly: false, planOnly: false, withOptional: false, skipModel: false, interactive: false, ...o });
const item = (cli: CliDeps, profile: string) =>
  buildCatalog({ pin: { version: '4.16.0' }, engines: '>=20', hasRenderer: false, modelProfile: profile, modelCli: cli }).filter((i) => i.id === 'classifier-model');

describe('classifier-model item', () => {
  it('present and verified is ok with zero fetch calls and the owner note', async () => {
    const s = setup();
    s.put();
    const r = await runBootstrap(item(s.cli, 'good'), mkExec(s.root, [], []), O({ yes: true }));
    expect(r[0]!.outcome).toBe('ok');
    expect(r[0]!.note).toContain('npm run models -- pin good');
    expect(s.net.calls).toBe(0);
  });
  it('absent plus --yes fetches then verifies, prints licence, size, pinning and owner note', async () => {
    const s = setup();
    const said: string[] = [];
    const r = await runBootstrap(item(s.cli, 'good'), mkExec(s.root, said, []), O({ yes: true }));
    expect(s.net.calls).toBeGreaterThan(0);
    const all = said.join('\n');
    expect(all).toContain('apache-2.0');
    expect(all).toMatch(/Weights download from Hugging Face \(about 0\.0 MB\); each file is hash-checked after download/);
    expect(all).toContain('model.onnx (sha256)');
    expect(all).toContain('(git blob sha1)');
    expect(all).toContain('npm run classifier:fit -- --profile good --write');
    expect(r[0]!.outcome).toBe('installed');
    expect(r[0]!.note).toContain('CLASSIFIER_MODEL');
  });
  it('absent without --yes on a non-TTY is skipped and downloads nothing', async () => {
    const s = setup();
    const r = await runBootstrap(item(s.cli, 'good'), mkExec(s.root, [], []), O());
    expect(r[0]!.outcome).toBe('skipped');
    expect(s.net.calls).toBe(0);
  });
  it('--skip-model skips', async () => {
    const s = setup();
    const r = await runBootstrap(item(s.cli, 'good'), mkExec(s.root, [], []), O({ yes: true, skipModel: true }));
    expect(r[0]!.outcome).toBe('skipped');
    expect(s.net.calls).toBe(0);
  });
  it('interactive: asks once and fetches on yes', async () => {
    const s = setup();
    const asks: string[] = [];
    const r = await runBootstrap(item(s.cli, 'good'), mkExec(s.root, [], asks), O({ interactive: true }));
    expect(asks).toHaveLength(1);
    expect(r[0]!.outcome).toBe('installed');
  });
  it('verification failure after fetch is failed and names the problem count only', async () => {
    const s = setup();
    s.net.bad = true;
    const r = await runBootstrap(item(s.cli, 'good'), mkExec(s.root, [], []), O({ yes: true }));
    expect(r[0]!.outcome).toBe('failed');
    expect(r[0]!.note).toMatch(/\(\d+ problems?\)/);
    expect(r[0]!.note).not.toContain('wrong-bytes');
  });
  it('gated profile is needs_owner with manual steps and never fetches', async () => {
    const s = setup();
    const r = await runBootstrap(item(s.cli, 'gated'), mkExec(s.root, [], []), O({ yes: true }));
    expect(r[0]!.outcome).toBe('needs_owner');
    expect(r[0]!.note).toContain('accept the licence');
    expect(s.net.calls).toBe(0);
  });
  it('never rewrites the registry', async () => {
    const s = setup();
    const before = readFileSync(s.registryPath, 'utf8');
    await runBootstrap(item(s.cli, 'good'), mkExec(s.root, [], []), O({ yes: true }));
    expect(readFileSync(s.registryPath, 'utf8')).toBe(before);
  });
});
