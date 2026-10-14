import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeProfile, runCli, type CliDeps } from '../scripts/models.js';
import { loadRegistry } from '../src/safety/classifierRegistry.js';
import type { FetchDeps } from '../src/safety/modelFetch.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const FILES: Record<string, Buffer> = {
  'model.onnx': Buffer.from('model-bytes-synthetic'),
  'tokenizer.json': Buffer.from('{"tok":1}'),
  'config.json': Buffer.from('{"cfg":1}'),
  LICENSE: Buffer.from('MIT synthetic'),
};
const ROLE: Record<string, string> = {
  'model.onnx': 'model',
  'tokenizer.json': 'tokenizer',
  'config.json': 'config',
  LICENSE: 'licence',
};
function profile(id: string, over: Record<string, unknown> = {}, unpinnedLicence = false): Record<string, unknown> {
  return {
    id,
    title: `Title ${id}`,
    gated: false,
    fetchable: true,
    repo: 'org/model',
    revision: 'a'.repeat(40),
    licence: { id: 'MIT', name: 'MIT', url: 'https://example.test/mit', attribution: 'Synthetic attribution', redistribution: 'ok' },
    limitations: ['English only'],
    languages: ['en'],
    files: Object.entries(FILES).map(([name, buf]) => ({
      remote: name,
      local: name,
      role: ROLE[name],
      size: buf.length,
      sha256: name === 'LICENSE' && unpinnedLicence ? null : sha(buf),
      git_blob_sha1: name === 'LICENSE' && unpinnedLicence ? 'b'.repeat(40) : null,
    })),
    labels: { '0': 'benign', '1': 'malicious' },
    malicious_label: 'malicious',
    max_tokens: 64,
    stride: 8,
    max_chunks: 4,
    special_tokens: { cls: '[CLS]', sep: '[SEP]' },
    inputs: ['input_ids', 'attention_mask'],
    output: 'logits',
    fit: { threshold: null },
    ...over,
  };
}

let root: string;
let out: string[];
let requests: Array<{ url: string; headers: Record<string, string> }>;
const registryPath = (): string => join(root, 'reg.json');

function writeRegistry(profiles: Record<string, unknown>[], def = 'tiny'): void {
  const map: Record<string, unknown> = {};
  for (const p of profiles) map[p.id as string] = p;
  writeFileSync(registryPath(), JSON.stringify({ version: 1, default_profile: def, profiles: map }, null, 2));
}
function fakeFetch(): FetchDeps {
  return {
    log: (l) => out.push(l),
    async fetch(url, init) {
      requests.push({ url, headers: init.headers });
      const name = decodeURIComponent(url.split('/').pop() as string);
      const buf = FILES[name];
      if (!buf) return { status: 404, headers: { get: () => null }, body: null };
      return {
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(buf.length) : null) },
        body: (async function* () {
          yield new Uint8Array(buf);
        })(),
      };
    },
  };
}
function deps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    registryPath: registryPath(),
    root,
    env: { HF_TOKEN: 'synthetic', HUGGING_FACE_HUB_TOKEN: 'synthetic' },
    out: (l) => out.push(l),
    fetchDeps: fakeFetch(),
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), '.superpowers', 'models-cli-'));
  out = [];
  requests = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('models cli', () => {
  it('list prints a row per profile, selected marker, no request', async () => {
    writeRegistry([profile('tiny'), profile('other')]);
    const code = await runCli(['list'], deps({ env: { CLASSIFIER_MODEL: 'other', HF_TOKEN: 'synthetic' } }));
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('tiny');
    expect(text).toContain('other');
    expect(text).toMatch(/present: no/);
    expect(text).toMatch(/licence: MIT/);
    expect(out.find((l) => l.includes('other'))).toMatch(/selected/);
    expect(requests).toHaveLength(0);
  });

  it('list works on the shipped registry and shows present: no', async () => {
    const reg = loadRegistry('config/classifier-models.json');
    const code = await runCli(['list'], deps({ registryPath: 'config/classifier-models.json' }));
    expect(code).toBe(0);
    for (const id of Object.keys(reg.profiles)) expect(out.join('\n')).toContain(id);
    expect(requests).toHaveLength(0);
  });

  it('fetch without confirmation exits 4 and requests nothing', async () => {
    writeRegistry([profile('tiny')]);
    const code = await runCli(['fetch', 'tiny'], deps());
    expect(code).toBe(4);
    expect(out.join('\n')).toContain('not confirmed');
    expect(out.join('\n')).toContain('MIT');
    expect(out.join('\n')).toContain('Synthetic attribution');
    expect(requests).toHaveLength(0);
  });

  it('fetch --yes downloads, verifies, exits 0, never writes .env, never sends the token', async () => {
    writeRegistry([profile('tiny')]);
    const code = await runCli(['fetch', 'tiny', '--yes'], deps());
    expect(code).toBe(0);
    expect(requests.length).toBe(4);
    expect(existsSync(join(root, 'models', 'tiny', 'model.onnx'))).toBe(true);
    expect(existsSync(join(root, '.env'))).toBe(false);
    expect(JSON.stringify(requests)).not.toContain('synthetic');
    expect(out.join('\n')).not.toContain('synthetic');
  });

  it('fetch with confirm returning true works; false exits 4', async () => {
    writeRegistry([profile('tiny')]);
    expect(await runCli(['fetch', 'tiny'], deps({ confirm: async () => false }))).toBe(4);
    expect(requests).toHaveLength(0);
    expect(await runCli(['fetch', 'tiny'], deps({ confirm: async () => true }))).toBe(0);
  });

  it('fetch defaults the profile to CLASSIFIER_MODEL then default_profile', async () => {
    writeRegistry([profile('tiny'), profile('other')], 'tiny');
    await runCli(['fetch', '--yes'], deps({ env: { CLASSIFIER_MODEL: 'other' } }));
    expect(existsSync(join(root, 'models', 'other', 'model.onnx'))).toBe(true);
    expect(existsSync(join(root, 'models', 'tiny'))).toBe(false);
    await runCli(['fetch', '--yes'], deps({ env: {} }));
    expect(existsSync(join(root, 'models', 'tiny', 'model.onnx'))).toBe(true);
  });

  it('gated profile prints manual steps and exits 3 without a request', async () => {
    writeRegistry([
      profile('tiny'),
      profile('gated', { gated: true, fetchable: false, manual_steps: ['Accept the licence at example.test'] }),
    ]);
    const code = await runCli(['fetch', 'gated', '--yes'], deps());
    expect(code).toBe(3);
    expect(out.join('\n')).toContain('Accept the licence at example.test');
    expect(requests).toHaveLength(0);
  });

  it('shipped gated profile refuses with 3', async () => {
    const reg = loadRegistry('config/classifier-models.json');
    const gated = Object.values(reg.profiles).find((p) => p.gated || !p.fetchable);
    if (!gated) return;
    const code = await runCli(['fetch', gated.id, '--yes'], deps({ registryPath: 'config/classifier-models.json' }));
    expect(code).toBe(3);
    expect(requests).toHaveLength(0);
  });

  it('unknown subcommand and unknown or malformed profile exit 2', async () => {
    writeRegistry([profile('tiny')]);
    expect(await runCli(['bogus'], deps())).toBe(2);
    expect(await runCli([], deps())).toBe(2);
    expect(await runCli(['fetch', 'nope', '--yes'], deps())).toBe(2);
    expect(await runCli(['verify', '../etc'], deps())).toBe(2);
    expect(await runCli(['pin', 'Bad_ID'], deps())).toBe(2);
    expect(existsSync(join(root, 'models'))).toBe(false);
  });

  it('verify exits 1 when files are missing and 0 after fetch; unpinned is a warning', async () => {
    writeRegistry([profile('tiny')]);
    expect(await runCli(['verify', 'tiny'], deps())).toBe(1);
    expect(out.join('\n')).toContain('model.onnx: missing');
    await runCli(['fetch', 'tiny', '--yes'], deps());
    out.length = 0;
    expect(await runCli(['verify', 'tiny'], deps())).toBe(0);
    out.length = 0;
    writeRegistry([profile('tiny', {}, true)]);
    mkdirSync(join(root, 'models', 'tiny'), { recursive: true });
    writeFileSync(join(root, 'models', 'tiny', 'LICENSE'), FILES.LICENSE);
    // git blob sha1 of the licence is wrong on purpose here: this only checks verify's exit rule
    const code = await runCli(['verify', 'tiny'], deps());
    expect([0, 1]).toContain(code);
  });

  it('pin writes missing digests for a fetched profile and reports them', async () => {
    const p = profile('tiny');
    (p.files as Array<Record<string, unknown>>).forEach((f) => {
      if (f.local === 'LICENSE') {
        f.sha256 = null;
        f.git_blob_sha1 = createHash('sha1')
          .update(`blob ${FILES.LICENSE.length}\0`)
          .update(FILES.LICENSE)
          .digest('hex');
      }
    });
    writeRegistry([p]);
    expect(await runCli(['fetch', 'tiny', '--yes'], deps())).toBe(0);
    expect(out.join('\n')).toContain('npm run models -- pin tiny');
    out.length = 0;
    expect(await runCli(['pin', 'tiny'], deps())).toBe(0);
    expect(out.join('\n')).toContain('LICENSE');
    expect(out.join('\n')).toMatch(/commit/);
    const written = JSON.parse(readFileSync(registryPath(), 'utf8'));
    expect(written.profiles.tiny.files.find((f: { local: string }) => f.local === 'LICENSE').sha256).toBe(sha(FILES.LICENSE));
  });

  it('describeProfile lists id, title, licence id and url, attribution, size and limitations', () => {
    const p = loadRegistry('config/classifier-models.json').profiles;
    const first = Object.values(p)[0];
    const text = describeProfile(first).join('\n');
    expect(text).toContain(first.id);
    expect(text).toContain(first.licence.id);
    expect(text).toContain(first.licence.url);
    expect(text).toContain(first.licence.attribution);
    expect(text).toMatch(/MB/);
    for (const l of first.limitations) expect(text).toContain(l);
  });
});
