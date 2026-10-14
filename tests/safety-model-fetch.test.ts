import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClassifierProfile, ClassifierRegistry, ProfileFile } from '../src/safety/classifierRegistry.js';
import {
  GatedProfileError,
  downloadFile,
  fetchProfile,
  gitBlobSha1,
  isAllowedHost,
  listProfiles,
  pinProfile,
  resolveUrl,
  verifyProfile,
  type FetchDeps,
  type FetchResponseLike,
} from '../src/safety/modelFetch.js';

const sha256 = (b: Buffer | Uint8Array): string => createHash('sha256').update(b).digest('hex');
const blobSha1 = (b: Buffer): string =>
  createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');

const REV = 'a'.repeat(40);
const MODEL = Buffer.from('0123456789ABCDEFGHIJ-model-bytes');
const TOK = Buffer.from('{"tokenizer":true}');
const CFG = Buffer.from('{"config":true}');
const LIC = Buffer.from('Apache License text');

function mkProfile(over: Partial<ClassifierProfile> = {}): ClassifierProfile {
  const file = (remote: string, role: ProfileFile['role'], b: Buffer, pin: 'sha' | 'blob'): ProfileFile => ({
    remote,
    local: remote.replace(/\//g, '_'),
    role,
    size: b.length,
    sha256: pin === 'sha' ? sha256(b) : null,
    git_blob_sha1: pin === 'blob' ? blobSha1(b) : null,
  });
  return {
    id: 'test-model',
    title: 'Test',
    gated: false,
    fetchable: true,
    repo: 'org/test-model',
    revision: REV,
    licence: { id: 'apache-2.0', name: 'Apache 2.0', url: 'https://x', attribution: 'x', redistribution: 'ok' },
    limitations: [],
    languages: ['en'],
    files: [
      file('onnx/model.onnx', 'model', MODEL, 'sha'),
      file('tokenizer.json', 'tokenizer', TOK, 'blob'),
      file('config.json', 'config', CFG, 'sha'),
      file('LICENSE', 'licence', LIC, 'sha'),
    ],
    labels: { '0': 'benign', '1': 'injection' },
    malicious_label: 'injection',
    max_tokens: 128,
    stride: 16,
    max_chunks: 4,
    special_tokens: { cls: '[CLS]', sep: '[SEP]' },
    inputs: ['input_ids', 'attention_mask'],
    output: 'logits',
    fit: { threshold: null },
    ...over,
  };
}

const CONTENT: Record<string, Buffer> = {
  'onnx/model.onnx': MODEL,
  'tokenizer.json': TOK,
  'config.json': CFG,
  LICENSE: LIC,
};
const urlOf = (p: ClassifierProfile, remote: string): string =>
  `https://huggingface.co/${p.repo}/resolve/${p.revision}/${remote}`;

async function* chunks(b: Uint8Array, n = 3): AsyncIterable<Uint8Array> {
  const step = Math.max(1, Math.ceil(b.length / n));
  for (let i = 0; i < b.length; i += step) yield b.subarray(i, i + step);
}
const resp = (status: number, body: Uint8Array | null, headers: Record<string, string> = {}): FetchResponseLike => ({
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  body: body ? chunks(body) : null,
});

interface Call {
  url: string;
  headers: Record<string, string>;
}
function fakeFetch(
  handler: (url: string, headers: Record<string, string>, n: number) => FetchResponseLike,
): { deps: FetchDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: FetchDeps = {
    fetch: async (url, init) => {
      calls.push({ url, headers: { ...init.headers } });
      expect(init.redirect).toBe('manual');
      return handler(url, init.headers, calls.length);
    },
    log: () => {},
  };
  return { deps, calls };
}
function serveAll(p: ClassifierProfile, tweak?: (remote: string, b: Buffer) => Buffer) {
  return fakeFetch((url) => {
    for (const f of p.files) {
      if (url === urlOf(p, f.remote)) {
        const b = CONTENT[f.remote];
        return resp(200, tweak ? tweak(f.remote, b) : b, { 'content-length': String(b.length) });
      }
    }
    return resp(404, null);
  });
}

let root: string;
beforeEach(() => {
  const base = join(process.cwd(), '.superpowers', 'tmp-tests');
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, 'mf-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveUrl and isAllowedHost', () => {
  it('builds the exact URL', () => {
    const p = mkProfile();
    expect(resolveUrl(p, p.files[0])).toBe(`https://huggingface.co/org/test-model/resolve/${REV}/onnx/model.onnx`);
  });
  it('rejects traversal and the main revision', () => {
    const p = mkProfile();
    expect(() => resolveUrl(p, { ...p.files[0], remote: '../x' })).toThrow();
    expect(() => resolveUrl(p, { ...p.files[0], remote: 'a/../x' })).toThrow();
    expect(() => resolveUrl(mkProfile({ revision: 'main' }), p.files[0])).toThrow();
  });
  it('allows only huggingface.co / hf.co on label boundaries', () => {
    for (const h of ['huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co', 'hf.co']) {
      expect(isAllowedHost(h)).toBe(true);
    }
    for (const h of ['evilhuggingface.co', 'huggingface.co.evil.example', 'localhost', '127.0.0.1', 'evilhf.co']) {
      expect(isAllowedHost(h)).toBe(false);
    }
  });
});

describe('downloadFile guards', () => {
  it('refuses gated and non-fetchable profiles with zero requests', async () => {
    for (const p of [
      mkProfile({ gated: true, fetchable: false, manual_steps: ['do it by hand'] }),
      mkProfile({ fetchable: false, manual_steps: ['copy files'] }),
    ]) {
      const { deps, calls } = serveAll(p);
      await expect(downloadFile(p, p.files[0], root, deps)).rejects.toBeInstanceOf(GatedProfileError);
      expect(calls.length).toBe(0);
    }
  });
  it('refuses placeholder revision and oversize', async () => {
    const ph = mkProfile({ revision: '0123456789abcdef0123456789abcdef01234567' });
    const a = serveAll(ph);
    await expect(downloadFile(ph, ph.files[0], root, a.deps)).rejects.toThrow();
    expect(a.calls.length).toBe(0);
    const p = mkProfile();
    const b = serveAll(p);
    await expect(downloadFile(p, { ...p.files[0], size: 2 * 1024 ** 3 + 1 }, root, b.deps)).rejects.toThrow();
    expect(b.calls.length).toBe(0);
  });
});

describe('downloadFile', () => {
  it('happy path streams, verifies, renames, mode 600', async () => {
    const p = mkProfile();
    const { deps, calls } = serveAll(p);
    const r = await downloadFile(p, p.files[0], root, deps);
    expect(r.status).toBe('downloaded');
    expect(r.sha256).toBe(sha256(MODEL));
    const dest = join(root, 'models', 'test-model', p.files[0].local);
    expect(readFileSync(dest).equals(MODEL)).toBe(true);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, 'models', '.partial', 'test-model', `${p.files[0].local}.part`))).toBe(false);
    expect(calls[0].headers['User-Agent']).toBe('jobber-model-fetch/1');
  });
  it('sha256 mismatch leaves nothing and does not echo bytes', async () => {
    const p = mkProfile();
    const bad = Buffer.from(MODEL);
    bad[0] ^= 1;
    const { deps } = serveAll(p, (_r, b) => (b === MODEL ? bad : b));
    const err = await downloadFile(p, p.files[0], root, deps).catch((e: Error) => e);
    expect(String(err)).toContain(p.files[0].local);
    expect(String(err)).toContain('sha256 mismatch');
    expect(String(err)).not.toContain('model-bytes');
    expect(existsSync(join(root, 'models', 'test-model', p.files[0].local))).toBe(false);
    expect(existsSync(join(root, 'models', '.partial', 'test-model', `${p.files[0].local}.part`))).toBe(false);
  });
  it('size cap: long body aborts, big Content-Length aborts before reading', async () => {
    const p = mkProfile();
    const long = Buffer.concat([MODEL, Buffer.from('EXTRA')]);
    const a = fakeFetch(() => resp(200, long));
    await expect(downloadFile(p, p.files[0], root, a.deps)).rejects.toThrow();
    expect(existsSync(join(root, 'models', 'test-model', p.files[0].local))).toBe(false);
    expect(existsSync(join(root, 'models', '.partial', 'test-model', `${p.files[0].local}.part`))).toBe(false);

    let read = false;
    const b = fakeFetch(() => ({
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(MODEL.length + 100) : null) },
      body: (async function* () {
        read = true;
        yield MODEL;
      })(),
    }));
    await expect(downloadFile(p, p.files[0], root, b.deps)).rejects.toThrow();
    expect(read).toBe(false);
  });
  it('resumes with 206, restarts on 200 and on a wrong Content-Range', async () => {
    const p = mkProfile();
    const f = p.files[0];
    const half = Math.floor(MODEL.length / 2);
    const partDir = join(root, 'models', '.partial', 'test-model');
    const prime = () => {
      mkdirSync(partDir, { recursive: true });
      writeFileSync(join(partDir, `${f.local}.part`), MODEL.subarray(0, half));
    };

    prime();
    const a = fakeFetch((_u, h) => {
      expect(h.Range).toBe(`bytes=${half}-`);
      return resp(206, MODEL.subarray(half), { 'content-range': `bytes ${half}-${MODEL.length - 1}/${MODEL.length}` });
    });
    const ra = await downloadFile(p, f, root, a.deps);
    expect(ra.status).toBe('resumed');
    expect(sha256(readFileSync(join(root, 'models', 'test-model', f.local)))).toBe(sha256(MODEL));
    rmSync(join(root, 'models', 'test-model'), { recursive: true });

    prime();
    const b = fakeFetch(() => resp(200, MODEL));
    expect((await downloadFile(p, f, root, b.deps)).sha256).toBe(sha256(MODEL));
    rmSync(join(root, 'models', 'test-model'), { recursive: true });

    prime();
    const c = fakeFetch((_u, h) =>
      h.Range
        ? resp(206, MODEL.subarray(half), { 'content-range': `bytes 3-${MODEL.length - 1}/${MODEL.length}` })
        : resp(200, MODEL),
    );
    expect((await downloadFile(p, f, root, c.deps)).sha256).toBe(sha256(MODEL));
  });
  it('non-2xx throws with the status only', async () => {
    const p = mkProfile();
    const { deps } = fakeFetch(() => resp(403, null));
    await expect(downloadFile(p, p.files[0], root, deps)).rejects.toThrow(/403/);
  });
});

describe('redirects and headers', () => {
  it('follows an allowed redirect, never sends auth or cookies', async () => {
    const p = mkProfile();
    const f = p.files[0];
    const { deps, calls } = fakeFetch((url) =>
      url === urlOf(p, f.remote)
        ? resp(302, null, { location: 'https://cdn-lfs.huggingface.co/blob/abc' })
        : resp(200, MODEL),
    );
    await downloadFile(p, f, root, deps);
    expect(calls.length).toBe(2);
    for (const c of calls) {
      const names = Object.keys(c.headers).map((n) => n.toLowerCase());
      expect(names).not.toContain('authorization');
      expect(names).not.toContain('cookie');
    }
  });
  it('rejects an explicit port, naming the host', async () => {
    const p = mkProfile();
    const { deps } = fakeFetch(() => resp(302, null, { location: 'https://huggingface.co:8443/x' }));
    await expect(downloadFile(p, p.files[0], root, deps)).rejects.toThrow(/huggingface\.co/);
  });
  it('rejects http, foreign hosts and loops', async () => {
    const p = mkProfile();
    const f = p.files[0];
    for (const loc of ['http://huggingface.co/x', 'https://evil.example/x']) {
      const { deps } = fakeFetch(() => resp(302, null, { location: loc }));
      await expect(downloadFile(p, f, root, deps)).rejects.toThrow(/not allowed|redirect/);
    }
    const loop = fakeFetch(() => resp(302, null, { location: 'https://huggingface.co/loop' }));
    await expect(downloadFile(p, f, root, loop.deps)).rejects.toThrow();
    expect(loop.calls.length).toBeLessThanOrEqual(6);
  });
});

describe('up-front refusal and timeouts', () => {
  it('refuses an unpinned file before any request', async () => {
    const p = mkProfile();
    const { deps, calls } = serveAll(p);
    const f = { ...p.files[0], sha256: null, git_blob_sha1: null };
    await expect(downloadFile(p, f, root, deps)).rejects.toThrow(new RegExp(f.local));
    expect(calls.length).toBe(0);
    const q = { ...p, files: [f, ...p.files.slice(1)] };
    await expect(fetchProfile(q, root, deps)).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
  it('rejects an unsafe local name before any request', async () => {
    const p = mkProfile();
    const { deps, calls } = serveAll(p);
    for (const local of ['..' + '/evil', 'a/b']) {
      await expect(downloadFile(p, { ...p.files[0], local }, root, deps)).rejects.toThrow();
    }
    expect(calls.length).toBe(0);
  });
  it('timeout covers headers only: slow body completes, silent fetch times out', async () => {
    const p = mkProfile();
    const slow: FetchDeps = {
      log: () => {},
      timeoutMs: 20,
      fetch: async () => ({
        status: 200,
        headers: { get: () => null },
        body: (async function* () {
          await new Promise((r) => setTimeout(r, 60));
          yield MODEL;
        })(),
      }),
    };
    expect((await downloadFile(p, p.files[0], root, slow)).sha256).toBe(sha256(MODEL));
    const silent: FetchDeps = {
      log: () => {},
      timeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    };
    await expect(downloadFile(p, p.files[2], root, silent)).rejects.toThrow();
  });
});

describe('fetchProfile, verify, pin, list', () => {
  it('is idempotent and re-downloads a corrupted file; sha1-pinned file works', async () => {
    const p = mkProfile();
    const a = serveAll(p);
    const s = await fetchProfile(p, root, a.deps);
    expect(s.files.every((x) => x.status === 'downloaded')).toBe(true);
    expect(s.observed_sha256[p.files[1].local]).toBe(sha256(TOK));
    expect(a.calls[a.calls.length - 1].url).toBe(urlOf(p, 'onnx/model.onnx'));

    const b = serveAll(p);
    const s2 = await fetchProfile(p, root, b.deps);
    expect(b.calls.length).toBe(0);
    expect(s2.files.every((x) => x.status === 'cached')).toBe(true);

    writeFileSync(join(root, 'models', 'test-model', p.files[1].local), Buffer.from('X'.repeat(TOK.length)));
    const c = serveAll(p);
    const s3 = await fetchProfile(p, root, c.deps);
    expect(c.calls.length).toBe(1);
    expect(s3.files.find((x) => x.file.endsWith(p.files[1].local))?.status).toBe('downloaded');
  });
  it('blob sha1 detects a one-byte change; gitBlobSha1 matches crypto', async () => {
    const p = mkProfile();
    const bad = Buffer.from(TOK);
    bad[2] ^= 1;
    const { deps } = serveAll(p, (r, b) => (r === 'tokenizer.json' ? bad : b));
    await expect(downloadFile(p, p.files[1], root, deps)).rejects.toThrow(/mismatch/);
    const f = join(root, 'blob.bin');
    writeFileSync(f, TOK);
    expect(await gitBlobSha1(f)).toBe(blobSha1(TOK));
  });
  it('verifyProfile reports unpinned, ok and wrong size by name', async () => {
    const p = mkProfile();
    await fetchProfile(p, root, serveAll(p).deps);
    const v = await verifyProfile(p, root);
    expect(v.ok).toBe(true);
    expect(v.unpinned).toEqual([p.files[1].local]);
    expect(Object.keys(v.observed_sha256).length).toBe(4);
    writeFileSync(join(root, 'models', 'test-model', p.files[2].local), Buffer.from('short'));
    const w = await verifyProfile(p, root);
    expect(w.ok).toBe(false);
    expect(w.problems.join(' ')).toContain(p.files[2].local);
  });
  it('pinProfile fills only null sha256 keys and refuses a failing verify', async () => {
    const p = mkProfile();
    const reg: ClassifierRegistry = { version: 1, default_profile: p.id, profiles: { [p.id]: p } };
    const regPath = join(root, 'reg.json');
    writeFileSync(regPath, JSON.stringify(reg));
    await expect(pinProfile(p, root, regPath)).rejects.toThrow();
    await fetchProfile(p, root, serveAll(p).deps);
    const r = await pinProfile(p, root, regPath);
    expect(r.written).toEqual([p.files[1].local]);
    const after = JSON.parse(readFileSync(regPath, 'utf8')) as ClassifierRegistry;
    expect(after.profiles[p.id].files[1].sha256).toBe(sha256(TOK));
    const expected = JSON.parse(JSON.stringify(reg)) as ClassifierRegistry;
    expected.profiles[p.id].files[1].sha256 = sha256(TOK);
    expect(after).toEqual(expected);
    expect(readFileSync(regPath, 'utf8').endsWith('\n')).toBe(true);
  });
  it('listProfiles marks selected, present, verified, fitted', async () => {
    const p = mkProfile();
    const other = mkProfile({ id: 'other-model' });
    const reg: ClassifierRegistry = { version: 1, default_profile: p.id, profiles: { [p.id]: p, [other.id]: other } };
    await fetchProfile(p, root, serveAll(p).deps);
    const rows = await listProfiles(reg, root, { CLASSIFIER_MODEL: 'test-model' });
    const a = rows.find((r) => r.id === 'test-model');
    const b = rows.find((r) => r.id === 'other-model');
    expect(a).toMatchObject({ selected: true, present: true, fitted: false, fetchable: true });
    expect(a?.approx_bytes).toBe(MODEL.length + TOK.length + CFG.length + LIC.length);
    expect(b).toMatchObject({ selected: false, present: false, verified: false });
  });
});
