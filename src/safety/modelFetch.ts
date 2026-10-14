// src/safety/modelFetch.ts
// Pinned, size-capped, resumable, hash-verified model download. Every function takes an
// INJECTED fetch (FetchDeps); only defaultFetchDeps wraps the global fetch. Sends no
// credentials, and treats downloaded files as bytes: nothing is executed, imported or unpacked.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeFile, sha256File } from './classifierModel.js';
import {
  isFullyPinned,
  modelDir,
  type ClassifierProfile,
  type ClassifierRegistry,
  type ProfileFile,
} from './classifierRegistry.js';

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}
export interface FetchDeps {
  fetch(
    url: string,
    init: { headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal },
  ): Promise<FetchResponseLike>;
  log(line: string): void;
  now?: () => number;
  timeoutMs?: number;
}

/** The real network wrapper shared by the CLI and the setup step. The only place global fetch is
 *  used; no credentials, redirects stay manual (the caller's loop validates every hop). */
export function defaultFetchDeps(log: (line: string) => void): FetchDeps {
  return {
    log,
    timeoutMs: 60000,
    async fetch(url, init) {
      const res = await fetch(url, {
        headers: init.headers,
        redirect: init.redirect,
        signal: init.signal ?? AbortSignal.timeout(60000),
      });
      return {
        status: res.status,
        headers: { get: (n: string) => res.headers.get(n) },
        body: res.body as unknown as AsyncIterable<Uint8Array> | null,
      };
    },
  };
}

export class GatedProfileError extends Error {
  manualSteps: string[];
  constructor(message: string, manualSteps: string[]) {
    super(message);
    this.name = 'GatedProfileError';
    this.manualSteps = manualSteps;
  }
}

const PLACEHOLDER_REV = '0123456789abcdef0123456789abcdef01234567';
const REV_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REMOTE_RE = /^[A-Za-z0-9_./-]+$/;
const MAX_SIZE = 2 * 1024 ** 3;
const MAX_REDIRECTS = 5;

export function resolveUrl(p: ClassifierProfile, f: ProfileFile): string {
  if (!REPO_RE.test(p.repo)) throw new Error(`profile ${p.id}: invalid repo`);
  if (!REV_RE.test(p.revision) || p.revision === PLACEHOLDER_REV) {
    throw new Error(`profile ${p.id}: revision is not a pinned commit`);
  }
  const r = f.remote;
  if (!REMOTE_RE.test(r) || r.startsWith('/') || r.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`profile ${p.id}: invalid remote path for ${f.local}`);
  }
  return `https://huggingface.co/${p.repo}/resolve/${p.revision}/${r.split('/').map(encodeURIComponent).join('/')}`;
}

export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase();
  return ['huggingface.co', 'hf.co'].some((d) => h === d || h.endsWith(`.${d}`));
}

export function gitBlobSha1(file: string): Promise<string> {
  return stat(file).then(
    (st) =>
      new Promise<string>((resolve, reject) => {
        const h = createHash('sha1');
        h.update(`blob ${st.size}\0`);
        createReadStream(file)
          .on('data', (c) => h.update(c))
          .on('error', reject)
          .on('end', () => resolve(h.digest('hex')));
      }),
  );
}

export interface DownloadResult {
  file: string;
  status: 'downloaded' | 'resumed' | 'cached';
  sha256: string;
  bytes: number;
}

const sizeOf = async (file: string): Promise<number | null> => {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
};

/** Throws a name-and-number-only error when the finished file does not match the pin. */
async function checkDigest(f: ProfileFile, file: string): Promise<void> {
  if (f.sha256) {
    if ((await sha256File(file)) !== f.sha256) throw new Error(`${f.local}: sha256 mismatch`);
  } else if (f.git_blob_sha1) {
    if ((await gitBlobSha1(file)) !== f.git_blob_sha1) throw new Error(`${f.local}: git_blob_sha1 mismatch`);
  } else {
    throw new Error(`${f.local}: no sha256 or git_blob_sha1 pinned`);
  }
}

function guard(p: ClassifierProfile): void {
  if (p.gated || !p.fetchable) {
    throw new GatedProfileError(
      `profile ${p.id} cannot be downloaded automatically`,
      p.manual_steps && p.manual_steps.length ? p.manual_steps : ['Obtain the files yourself and place them in models/' + p.id + '/'],
    );
  }
  if (p.revision === PLACEHOLDER_REV || !REV_RE.test(p.revision)) {
    throw new Error(`profile ${p.id}: revision is a placeholder, pin a real commit first`);
  }
}

async function request(url: string, headers: Record<string, string>, deps: FetchDeps): Promise<{ res: FetchResponseLike; done: () => void }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error('request timed out waiting for response headers'));
      }, deps.timeoutMs ?? 60000);
    });
    // The timer covers time to response headers only; it is cleared once they arrive.
    const done = (): void => {};
    let res: FetchResponseLike;
    try {
      res = await Promise.race([
        deps.fetch(current, { headers: { ...headers }, redirect: 'manual', signal: ac.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      done();
      if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect without a location (status ${res.status})`);
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new Error('redirect to an unparseable location');
      }
      if (next.protocol !== 'https:' || next.port !== '' || !isAllowedHost(next.hostname)) {
        throw new Error(`redirect to a host that is not allowed: ${next.hostname}`);
      }
      current = next.toString();
      continue;
    }
    return { res, done };
  }
  throw new Error('too many redirects');
}

export async function downloadFile(
  p: ClassifierProfile,
  f: ProfileFile,
  root: string,
  deps: FetchDeps,
): Promise<DownloadResult> {
  guard(p);
  if (!safeFile(f.local)) throw new Error(`${f.local}: invalid local file name`);
  if (!f.sha256 && !f.git_blob_sha1) {
    throw new Error(`${f.local}: no sha256 or git_blob_sha1 pinned, refusing to download`);
  }
  if (!Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_SIZE) {
    throw new Error(`${f.local}: size must be a positive integer of at most 2 GiB`);
  }
  const url = resolveUrl(p, f);
  const dir = modelDir(p, root);
  const dest = join(dir, f.local);
  const partDir = join(root, 'models', '.partial', p.id);
  const part = join(partDir, `${f.local}.part`);
  await mkdir(join(root, 'models'), { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(partDir, { recursive: true, mode: 0o700 });

  const have = await sizeOf(dest);
  if (have !== null) {
    if (have === f.size) {
      try {
        await checkDigest(f, dest);
        return { file: dest, status: 'cached', sha256: await sha256File(dest), bytes: have };
      } catch {
        /* fall through: re-download */
      }
    }
    await rm(dest, { force: true });
  }

  let resumed = false;
  let attempt = 0;
  for (;;) {
    attempt++;
    let partSize = (await sizeOf(part)) ?? 0;
    if (partSize >= f.size) {
      await rm(part, { force: true });
      partSize = 0;
    }
    const headers: Record<string, string> = { 'User-Agent': 'jobber-model-fetch/1' };
    if (partSize > 0) headers.Range = `bytes=${partSize}-`;
    const { res, done } = await request(url, headers, deps);
    try {
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`${f.local}: download failed with status ${res.status}`);
      }
      let append = false;
      if (res.status === 206) {
        const cr = res.headers.get('content-range') ?? '';
        const m = /^bytes (\d+)-/.exec(cr);
        const start = m ? Number(m[1]) : -1;
        if (partSize === 0 ? start !== 0 : start !== partSize) {
          await rm(part, { force: true });
          if (attempt > 2) throw new Error(`${f.local}: server returned an unusable range`);
          continue;
        }
        append = partSize > 0;
      } else if (partSize > 0) {
        await rm(part, { force: true });
        partSize = 0;
      }
      const base = append ? partSize : 0;
      const cl = Number(res.headers.get('content-length'));
      if (Number.isFinite(cl) && res.headers.get('content-length') !== null && base + cl > f.size) {
        await rm(part, { force: true });
        throw new Error(`${f.local}: size cap exceeded (declared length)`);
      }
      if (!res.body) throw new Error(`${f.local}: empty response body`);
      const fh = await open(part, append ? 'a' : 'w', 0o600);
      let total = base;
      try {
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > f.size) {
            await fh.close().catch(() => {});
            await rm(part, { force: true });
            throw new Error(`${f.local}: size cap exceeded`);
          }
          await fh.write(chunk);
        }
      } finally {
        await fh.close().catch(() => {});
      }
      resumed = append;
      break;
    } finally {
      done();
    }
  }

  const finalSize = (await sizeOf(part)) ?? -1;
  if (finalSize !== f.size) {
    await rm(part, { force: true });
    throw new Error(`${f.local}: size mismatch (expected ${f.size}, got ${finalSize})`);
  }
  try {
    await checkDigest(f, part);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  const digest = await sha256File(part);
  await rename(part, dest);
  await chmod(dest, 0o600);
  deps.log(`${f.local} ${f.size}`);
  return { file: dest, status: resumed ? 'resumed' : 'downloaded', sha256: digest, bytes: f.size };
}

export interface FetchSummary {
  profile: string;
  files: DownloadResult[];
  observed_sha256: Record<string, string>;
}

export async function fetchProfile(p: ClassifierProfile, root: string, deps: FetchDeps): Promise<FetchSummary> {
  guard(p);
  for (const f of p.files) {
    if (!safeFile(f.local)) throw new Error(`${f.local}: invalid local file name`);
    if (!f.sha256 && !f.git_blob_sha1) {
      throw new Error(`${f.local}: no sha256 or git_blob_sha1 pinned, refusing to download`);
    }
  }
  const ordered = [...p.files.filter((f) => f.role !== 'model'), ...p.files.filter((f) => f.role === 'model')];
  const files: DownloadResult[] = [];
  const observed: Record<string, string> = {};
  for (const f of ordered) {
    const r = await downloadFile(p, f, root, deps);
    files.push(r);
    observed[f.local] = r.sha256;
  }
  const lic = p.files.find((f) => f.role === 'licence');
  if (!lic || (await sizeOf(join(modelDir(p, root), lic.local))) === null) {
    throw new Error(`profile ${p.id}: licence file is missing after download`);
  }
  return { profile: p.id, files, observed_sha256: observed };
}

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  observed_sha256: Record<string, string>;
  unpinned: string[];
}

export async function verifyProfile(p: ClassifierProfile, root: string): Promise<VerifyReport> {
  const dir = modelDir(p, root);
  const problems: string[] = [];
  const unpinned: string[] = [];
  const observed: Record<string, string> = {};
  for (const f of p.files) {
    const file = join(dir, f.local);
    const size = await sizeOf(file);
    if (size === null) {
      problems.push(`${f.local}: missing`);
      continue;
    }
    observed[f.local] = await sha256File(file);
    if (f.size <= 0) {
      problems.push(`${f.local}: size not pinned`);
      unpinned.push(f.local);
      continue;
    }
    if (size !== f.size) {
      problems.push(`${f.local}: size mismatch (expected ${f.size}, got ${size})`);
      continue;
    }
    if (f.sha256) {
      if (observed[f.local] !== f.sha256) problems.push(`${f.local}: sha256 mismatch`);
    } else if (f.git_blob_sha1) {
      unpinned.push(f.local);
      if ((await gitBlobSha1(file)) !== f.git_blob_sha1) problems.push(`${f.local}: git_blob_sha1 mismatch`);
    } else {
      unpinned.push(f.local);
      problems.push(`${f.local}: no digest pinned`);
    }
  }
  return { ok: problems.length === 0, problems, observed_sha256: observed, unpinned };
}

export interface ListRow {
  id: string;
  title: string;
  licence: string;
  gated: boolean;
  fetchable: boolean;
  present: boolean;
  verified: boolean;
  fitted: boolean;
  selected: boolean;
  approx_bytes: number;
}

export async function listProfiles(reg: ClassifierRegistry, root: string, env: NodeJS.ProcessEnv): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  const selectedId = (env.CLASSIFIER_MODEL ?? '').trim();
  for (const p of Object.values(reg.profiles)) {
    const dir = modelDir(p, root);
    let present = p.files.length > 0;
    for (const f of p.files) if ((await sizeOf(join(dir, f.local))) === null) present = false;
    let verified = false;
    if (present) {
      const v = await verifyProfile(p, root);
      verified = v.ok && v.unpinned.length === 0 && isFullyPinned(p);
    }
    const model = p.files.find((f) => f.role === 'model');
    const fitted =
      typeof p.fit.threshold === 'number' && !!model?.sha256 && p.fit.model_sha256 === model.sha256;
    rows.push({
      id: p.id,
      title: p.title,
      licence: p.licence.id,
      gated: p.gated,
      fetchable: p.fetchable,
      present,
      verified,
      fitted,
      selected: p.id === selectedId,
      approx_bytes: p.files.reduce((n, f) => n + f.size, 0),
    });
  }
  return rows;
}

export async function pinProfile(
  p: ClassifierProfile,
  root: string,
  registryPath: string,
): Promise<{ written: string[] }> {
  const dir = modelDir(p, root);
  const updates = new Map<string, { sha256?: string; git_blob_sha1?: string; size?: number }>();

  if (p.fetchable) {
    const v = await verifyProfile(p, root);
    if (!v.ok) throw new Error(`profile ${p.id} does not verify: ${v.problems.join('; ')}`);
    for (const f of p.files) {
      if (f.sha256 === null) updates.set(f.local, { sha256: v.observed_sha256[f.local] });
    }
  } else {
    for (const role of ['model', 'tokenizer', 'config'] as const) {
      const f = p.files.find((x) => x.role === role);
      if (!f || (await sizeOf(join(dir, f.local))) === null) {
        throw new Error(`profile ${p.id}: required ${role} file is not present in ${dir}`);
      }
    }
    for (const f of p.files) {
      const file = join(dir, f.local);
      const size = await sizeOf(file);
      if (size === null) continue;
      const s256 = await sha256File(file);
      const g1 = await gitBlobSha1(file);
      if (f.size > 0 && f.size !== size) throw new Error(`${f.local}: size mismatch (expected ${f.size}, got ${size})`);
      if (f.sha256 !== null && f.sha256 !== s256) throw new Error(`${f.local}: sha256 mismatch`);
      if (f.git_blob_sha1 !== null && f.git_blob_sha1 !== g1) throw new Error(`${f.local}: git_blob_sha1 mismatch`);
      const u: { sha256?: string; git_blob_sha1?: string; size?: number } = {};
      if (f.sha256 === null) u.sha256 = s256;
      if (f.git_blob_sha1 === null) u.git_blob_sha1 = g1;
      if (f.size <= 0) u.size = size;
      if (Object.keys(u).length) updates.set(f.local, u);
    }
  }

  if (updates.size === 0) return { written: [] };
  const raw = JSON.parse(await readFile(registryPath, 'utf8')) as ClassifierRegistry;
  const target = raw.profiles?.[p.id];
  if (!target) throw new Error(`profile ${p.id} is not in ${registryPath}`);
  const written: string[] = [];
  for (const f of target.files) {
    const u = updates.get(f.local);
    if (!u) continue;
    Object.assign(f, u);
    written.push(f.local);
  }
  const tmp = join(dirname(registryPath), `.${p.id}.registry.tmp`);
  await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, registryPath);
  return { written };
}
