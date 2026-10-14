// tests/setup-steps-classifier.test.ts
// Classifier setup step. Fake fetch, fake smoke, scripted IO and a throwaway temp root only:
// no network, no model load, no Hugging Face request.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import type { FetchDeps } from '../src/safety/modelFetch.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';
import { classifierStep, createClassifierStep } from '../src/setup/steps/classifier.js';
import { ALL_STEPS } from '../src/setup/steps/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const nodeFs: SetupFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, d, m) => {
    writeFileSync(p, d, { mode: m });
    chmodSync(p, m);
  },
  rename: (a, b) => renameSync(a, b),
  chmod: (p, m) => chmodSync(p, m),
  remove: (p) => rmSync(p, { force: true }),
  mkdirp: (p, m) => void mkdirSync(p, { recursive: true, mode: m }),
  copy: () => undefined,
  list: (p) => readdirSync(p),
};

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const BYTES: Record<string, Buffer> = {
  'onnx/model.onnx': Buffer.from('tiny-model-bytes-0123456789'),
  'tokenizer.json': Buffer.from('{"tok":1}'),
  'config.json': Buffer.from('{"cfg":1}'),
  LICENSE: Buffer.from('Apache text here'),
};
const ROLE: Record<string, string> = { 'onnx/model.onnx': 'model', 'tokenizer.json': 'tokenizer', 'config.json': 'config', LICENSE: 'licence' };

const profile = (id: string, over: Record<string, unknown>) => ({
  id,
  title: `Title ${id}`,
  gated: false,
  fetchable: true,
  repo: 'org/tiny',
  revision: 'a'.repeat(40),
  licence: { id: 'Apache-2.0', name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0', attribution: 'Tiny attribution text', redistribution: 'allowed' },
  limitations: ['English only', 'No jailbreak detection'],
  languages: ['en'],
  files: Object.entries(BYTES).map(([remote, b]) => ({
    remote,
    local: remote.replace(/\//g, '_'),
    role: ROLE[remote],
    size: b.length,
    sha256: sha(b),
    git_blob_sha1: null,
  })),
  labels: { '0': 'SAFE', '1': 'INJECTION' },
  malicious_label: 'INJECTION',
  max_tokens: 64,
  stride: 8,
  max_chunks: 4,
  special_tokens: { cls: '[CLS]', sep: '[SEP]' },
  inputs: ['input_ids', 'attention_mask'],
  output: 'logits',
  fit: { threshold: null },
  ...over,
});

const REGISTRY = {
  version: 1,
  default_profile: 'tiny-open',
  profiles: {
    'tiny-open': profile('tiny-open', {}),
    'tiny-gated': profile('tiny-gated', {
      gated: true,
      fetchable: false,
      manual_steps: ['Accept the licence on the vendor site', 'Export an ONNX file into models/tiny-gated/'],
      files: Object.entries(BYTES).map(([remote]) => ({
        remote,
        local: remote.replace(/\//g, '_'),
        role: ROLE[remote],
        size: 0,
        sha256: null,
        git_blob_sha1: null,
      })),
    }),
  },
};

function fakeFetch(over: Record<string, Buffer> = {}) {
  const calls: string[] = [];
  const deps: FetchDeps = {
    log: () => undefined,
    async fetch(url) {
      calls.push(url);
      const remote = decodeURIComponent(url.split('/resolve/')[1].split('/').slice(1).join('/'));
      const b = over[remote] ?? BYTES[remote];
      if (!b) return { status: 404, headers: { get: () => null }, body: null };
      return {
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(b.length) : null) },
        body: (async function* () {
          yield new Uint8Array(b);
        })(),
      };
    },
  };
  return { deps, calls };
}

const OK_SMOKE = async () => ({ benign: 0.01, injection: 0.99 });

function setup(script: ScriptItem[], opts: { env?: string | null; processEnv?: NodeJS.ProcessEnv } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobber-cls-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'classifier-models.json'), JSON.stringify(REGISTRY, null, 2));
  writeFileSync(path.join(root, '.env.example'), '# example\nSEND_LIMIT_PER_RUN=1\n');
  if (opts.env !== undefined && opts.env !== null) writeFileSync(path.join(root, '.env'), opts.env);
  const sio = scriptedIO(script);
  const run = (async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as SetupContext['run'];
  const doctor: DoctorContext = {
    root,
    env: {},
    run,
    fs: { exists: (p) => existsSync(p), read: (p) => readFileSync(p, 'utf8'), mode: () => null },
  };
  const ctx: SetupContext = {
    io: redactingIO(sio),
    root,
    env: opts.processEnv ?? {},
    fs: nodeFs,
    run,
    spawnInteractive: async () => 0,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: () => new Date('2026-10-14T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: path.join(root, 'user-data', '.setup-state.json'),
    envPath: path.join(root, '.env'),
  };
  return { ctx, sio, root };
}

const envText = (root: string): string => readFileSync(path.join(root, '.env'), 'utf8');

describe('classifier step wiring', () => {
  it('has the right id, checkIds and position', () => {
    expect(classifierStep.id).toBe('classifier');
    expect(classifierStep.checkIds).toEqual(['classifier_model', 'classifier_smoke']);
    const ids = ALL_STEPS.map((s) => s.id);
    expect(ids.indexOf('classifier')).toBe(ids.indexOf('access') + 1);
    expect(ids.indexOf('dashboard')).toBe(ids.indexOf('classifier') + 1);
  });
});

describe('fetchable profile', () => {
  it('consent no: no fetch, no .env write, skipped', async () => {
    const { ctx, sio, root } = setup([{ choose: '' }, { confirm: false }]);
    const f = fakeFetch();
    const step = createClassifierStep({ fetchDeps: f.deps, smoke: OK_SMOKE });
    expect(await step.run(ctx)).toBe('skipped');
    expect(f.calls).toHaveLength(0);
    expect(existsSync(path.join(root, '.env'))).toBe(false);
    expect(existsSync(path.join(root, 'models'))).toBe(false);
    sio.assertDone();
  });

  it('consent yes: prints licence, attribution, size, limitations, fixed sentences before the prompt, then fetch, verify, smoke, .env', async () => {
    const { ctx, sio, root } = setup([{ choose: '' }, { confirm: true }]);
    const f = fakeFetch();
    const order: string[] = [];
    const smoke = async () => {
      order.push('smoke');
      expect(existsSync(path.join(root, 'models', 'tiny-open', 'onnx_model.onnx'))).toBe(true);
      return { benign: 0.02, injection: 0.97 };
    };
    const step = createClassifierStep({ fetchDeps: f.deps, smoke });
    expect(await step.run(ctx)).toBe('done');
    expect(f.calls.length).toBe(4);
    expect(order).toEqual(['smoke']);
    const t = sio.transcript.join('\n');
    const confirmAt = t.indexOf('confirm: Download');
    expect(confirmAt).toBeGreaterThan(-1);
    const before = t.slice(0, confirmAt);
    expect(before).toContain('Apache-2.0');
    expect(before).toContain('https://www.apache.org/licenses/LICENSE-2.0');
    expect(before).toContain('Tiny attribution text');
    expect(before).toContain('English only');
    expect(before).toContain('No jailbreak detection');
    expect(before).toMatch(/Download size: \d+\.\d MB/);
    expect(before).toContain(
      'The classifier reads untrusted text (job posts, profiles, replies) before the agent sees it and blocks injected instructions. It runs locally; no text leaves this machine.',
    );
    expect(before).toContain(
      'The model files are downloaded from huggingface.co at a fixed, pinned version, checked against known hashes, and stored in models/ (not committed).',
    );
    expect(t).toContain('confirm: Download 0.0 MB now?');
    expect(t).toContain('smoke: benign 0.020, injection 0.970');
    expect(t).toContain('npm run classifier:fit -- --profile tiny-open --write');
    const env = envText(root);
    expect(env).toContain('CLASSIFIER_MODEL=tiny-open');
    expect(env).toContain('# example');
    expect(env).toContain('SEND_LIMIT_PER_RUN=1');
    expect(statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);
    sio.assertDone();
  });

  it('hash mismatch throws, leaves .env untouched and partial state; a corrected rerun completes', async () => {
    const first = setup([{ choose: '' }, { confirm: true }], { env: '# mine\nFOO=bar\n' });
    const bad = fakeFetch({ 'onnx/model.onnx': Buffer.from('tiny-model-bytes-XXXXXXXXXX') });
    const step1 = createClassifierStep({ fetchDeps: bad.deps, smoke: OK_SMOKE });
    await expect(step1.run(first.ctx)).rejects.toThrow(/sha256 mismatch/);
    expect(envText(first.root)).toBe('# mine\nFOO=bar\n');
    expect(existsSync(path.join(first.root, 'models', '.partial', 'tiny-open'))).toBe(true);
    expect(first.sio.transcript.join('\n')).toContain('download failed');

    // Same root, corrected fake: the non-model files are cached, the model is re-fetched.
    const second = scriptedIO([{ choose: '' }, { confirm: true }]);
    first.ctx.io = redactingIO(second);
    const good = fakeFetch();
    const step2 = createClassifierStep({ fetchDeps: good.deps, smoke: OK_SMOKE });
    expect(await step2.run(first.ctx)).toBe('done');
    expect(good.calls.length).toBeLessThan(4);
    expect(envText(first.root)).toContain('CLASSIFIER_MODEL=tiny-open');
    expect(envText(first.root)).toContain('FOO=bar');
  });

  it('smoke failure (benign 0.9) throws and leaves .env untouched', async () => {
    const { ctx, root } = setup([{ choose: '' }, { confirm: true }], { env: 'FOO=bar\n' });
    const step = createClassifierStep({ fetchDeps: fakeFetch().deps, smoke: async () => ({ benign: 0.9, injection: 0.99 }) });
    await expect(step.run(ctx)).rejects.toThrow(/smoke test failed/);
    expect(envText(root)).toBe('FOO=bar\n');
  });

  it('smoke load error is reported on one line and rethrown for the runner retry', async () => {
    const { ctx, sio, root } = setup([{ choose: '' }, { confirm: true }]);
    const step = createClassifierStep({
      fetchDeps: fakeFetch().deps,
      smoke: async () => {
        throw new Error('no session\nstack line');
      },
    });
    await expect(step.run(ctx)).rejects.toThrow('no session');
    expect(sio.transcript.join('\n')).toContain('smoke test could not run: no session');
    expect(existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('preserves .env comments and other keys; a second run is a no-op write', async () => {
    const { ctx, sio, root } = setup([{ choose: '' }, { confirm: true }, { choose: '' }, { confirm: true }], {
      env: '# keep me\nA=1\n\nB="two words"\n',
    });
    const step = createClassifierStep({ fetchDeps: fakeFetch().deps, smoke: OK_SMOKE });
    expect(await step.run(ctx)).toBe('done');
    const once = envText(root);
    expect(once).toContain('# keep me');
    expect(once).toContain('A=1');
    expect(once).toContain('B="two words"');
    const backupsBefore = readdirSync(root).filter((n) => n.startsWith('.env.bak')).length;
    expect(await step.run(ctx)).toBe('done');
    expect(envText(root)).toBe(once);
    expect(readdirSync(root).filter((n) => n.startsWith('.env.bak')).length).toBe(backupsBefore);
    expect(sio.transcript.join('\n')).toContain('.env already has CLASSIFIER_MODEL');
  });

  it('never reads or prints HF_TOKEN from ctx.env', async () => {
    const CANARY = 'hf_CANARY_do_not_print_123456';
    const env = new Proxy({ HF_TOKEN: CANARY } as NodeJS.ProcessEnv, {
      get(t, k) {
        if (k === 'HF_TOKEN') throw new Error('HF_TOKEN was read');
        return (t as Record<string | symbol, unknown>)[k];
      },
      ownKeys() {
        throw new Error('env was enumerated');
      },
    });
    const { ctx, sio, root } = setup([{ choose: '' }, { confirm: true }], { processEnv: env });
    const f = fakeFetch();
    const seenHeaders: Record<string, string>[] = [];
    const deps: FetchDeps = {
      ...f.deps,
      fetch: (url, init) => {
        seenHeaders.push(init.headers);
        return f.deps.fetch(url, init);
      },
    };
    const step = createClassifierStep({ fetchDeps: deps, smoke: OK_SMOKE });
    expect(await step.run(ctx)).toBe('done');
    expect(sio.transcript.join('\n')).not.toContain(CANARY);
    expect(JSON.stringify(ctx.state)).not.toContain(CANARY);
    expect(envText(root)).not.toContain(CANARY);
    for (const h of seenHeaders) expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('authorization');
  });
});

describe('gated / owner-supplied profile', () => {
  it('prints manual steps, never fetches, returns skipped when files are absent', async () => {
    const { ctx, sio, root } = setup([{ choose: 'tiny-gated' }, { pause: true }]);
    const f = fakeFetch();
    const step = createClassifierStep({ fetchDeps: f.deps, smoke: OK_SMOKE });
    expect(await step.run(ctx)).toBe('skipped');
    expect(f.calls).toHaveLength(0);
    const t = sio.transcript.join('\n');
    expect(t).toContain('Accept the licence on the vendor site');
    expect(t).toContain('pause: Place the files, then press Enter');
    expect(t).not.toMatch(/token/i);
    expect(existsSync(path.join(root, '.env'))).toBe(false);
    sio.assertDone();
  });

  it('files present but unpinned: prints the exact pin command, no .env write, no fetch', async () => {
    const { ctx, sio, root } = setup([{ choose: 'tiny-gated' }, { pause: true }]);
    const dir = path.join(root, 'models', 'tiny-gated');
    mkdirSync(dir, { recursive: true });
    for (const [remote, b] of Object.entries(BYTES)) writeFileSync(path.join(dir, remote.replace(/\//g, '_')), b);
    const f = fakeFetch();
    const step = createClassifierStep({ fetchDeps: f.deps, smoke: OK_SMOKE });
    expect(await step.run(ctx)).toBe('skipped');
    expect(f.calls).toHaveLength(0);
    expect(sio.transcript.join('\n')).toContain('npm run models -- pin tiny-gated');
    expect(existsSync(path.join(root, '.env'))).toBe(false);
  });
});
