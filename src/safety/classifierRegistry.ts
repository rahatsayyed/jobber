// src/safety/classifierRegistry.ts
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeFile, type ClassifierPin, type PinEntry } from './classifierModel.js';

export interface ProfileFile {
  remote: string;
  local: string;
  role: 'model' | 'tokenizer' | 'config' | 'extra' | 'licence';
  size: number;
  sha256: string | null;
  git_blob_sha1: string | null;
}
export interface ProfileFit {
  threshold: number | null;
  fitted_at?: string;
  model_sha256?: string;
  max_benign_fpr?: number;
  held_out?: { tpr: number; fpr: number; n: number };
  corpus?: { attacks: number; benign: number; seed: string; held_out_fraction: number };
  by_category?: Record<string, { n: number; tpr: number }>;
}
export interface ClassifierProfile {
  id: string;
  title: string;
  gated: boolean;
  fetchable: boolean;
  manual_steps?: string[];
  repo: string;
  revision: string;
  licence: { id: string; name: string; url: string; attribution: string; redistribution: string };
  limitations: string[];
  languages: string[];
  files: ProfileFile[];
  labels: Record<string, string>;
  malicious_label: string;
  max_tokens: number;
  stride: number;
  max_chunks: number;
  special_tokens: { cls: string; sep: string };
  inputs: string[];
  output: string;
  fit: ProfileFit;
}
export interface ClassifierRegistry {
  version: 1;
  default_profile: string;
  profiles: Record<string, ClassifierProfile>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REV_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REMOTE_RE = /^[A-Za-z0-9_./-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ROLES = ['model', 'tokenizer', 'config', 'extra', 'licence'];
const INPUTS = ['input_ids', 'attention_mask', 'token_type_ids'];
const MAX_SIZE = 2 * 1024 ** 3;
const PROFILE_KEYS = new Set([
  'id', 'title', 'gated', 'fetchable', 'manual_steps', 'repo', 'revision', 'licence', 'limitations',
  'languages', 'files', 'labels', 'malicious_label', 'max_tokens', 'stride', 'max_chunks',
  'special_tokens', 'inputs', 'output', 'fit',
]);
const FILE_KEYS = new Set(['remote', 'local', 'role', 'size', 'sha256', 'git_blob_sha1']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function validateFile(f: unknown, where: string, fetchable: boolean, out: string[]): void {
  if (!isObj(f)) {
    out.push(`${where}: not an object`);
    return;
  }
  for (const k of Object.keys(f)) if (!FILE_KEYS.has(k)) out.push(`${where}: unknown key "${k}"`);
  const remote = f.remote;
  if (!isStr(remote) || !REMOTE_RE.test(remote) || remote.startsWith('/') || remote.split('/').includes('..')) {
    out.push(`${where}: invalid remote path`);
  }
  if (!isStr(f.local) || !safeFile(f.local)) out.push(`${where}: invalid local file name`);
  if (!isStr(f.role) || !ROLES.includes(f.role)) out.push(`${where}: invalid role`);
  const s256 = f.sha256;
  const g1 = f.git_blob_sha1;
  if (s256 !== null && !(isStr(s256) && HEX64.test(s256))) out.push(`${where}: sha256 must be 64 lowercase hex or null`);
  if (g1 !== null && !(isStr(g1) && HEX40.test(g1))) out.push(`${where}: git_blob_sha1 must be 40 lowercase hex or null`);
  const noDigest = s256 === null && g1 === null;
  // Owner-supplied (non-fetchable) files may be undigested and unsized until `models pin` fills them.
  const ownerPlaceholder = !fetchable && noDigest;
  if (noDigest && fetchable) out.push(`${where}: needs a sha256 or a git_blob_sha1`);
  if (!(ownerPlaceholder && f.size === 0) && !isInt(f.size, 1, MAX_SIZE)) {
    out.push(`${where}: size must be a positive integer of at most 2 GiB`);
  }
}

function validateProfile(key: string, p: unknown, out: string[]): void {
  const w = `profile ${key}`;
  if (!isObj(p)) {
    out.push(`${w}: not an object`);
    return;
  }
  for (const k of Object.keys(p)) if (!PROFILE_KEYS.has(k)) out.push(`${w}: unknown key "${k}"`);
  if (!isStr(p.id) || !ID_RE.test(p.id)) out.push(`${w}: id must match ${ID_RE}`);
  else if (p.id !== key) out.push(`${w}: id "${p.id}" does not equal its key`);
  if (!isStr(p.title) || !p.title) out.push(`${w}: title required`);
  if (typeof p.gated !== 'boolean') out.push(`${w}: gated must be boolean`);
  if (typeof p.fetchable !== 'boolean') out.push(`${w}: fetchable must be boolean`);
  if (!isStr(p.repo) || !REPO_RE.test(p.repo)) out.push(`${w}: invalid repo`);
  if (!isStr(p.revision) || !REV_RE.test(p.revision)) out.push(`${w}: revision must be a 40 hex commit`);
  const lic = p.licence;
  if (!isObj(lic) || !['id', 'name', 'url', 'attribution', 'redistribution'].every((k) => isStr(lic[k]) && lic[k])) {
    out.push(`${w}: licence needs non-empty id, name, url, attribution, redistribution`);
  }
  if (!strArr(p.limitations)) out.push(`${w}: limitations must be a string array`);
  if (!strArr(p.languages)) out.push(`${w}: languages must be a string array`);
  if (p.manual_steps !== undefined && !strArr(p.manual_steps)) out.push(`${w}: manual_steps must be a string array`);

  const fetchable = p.fetchable === true;
  if (p.gated === true) {
    if (fetchable) out.push(`${w}: a gated profile must not be fetchable`);
    if (!strArr(p.manual_steps) || p.manual_steps.length === 0) out.push(`${w}: a gated profile needs manual_steps`);
  }
  if (!Array.isArray(p.files) || p.files.length === 0) out.push(`${w}: files required`);
  else {
    p.files.forEach((f, i) => validateFile(f, `${w} files[${i}]`, fetchable, out));
    if (fetchable) {
      if (p.gated === true) out.push(`${w}: fetchable profiles must have gated false`);
      for (const role of ['model', 'tokenizer', 'config'] as const) {
        const n = p.files.filter((f) => isObj(f) && f.role === role).length;
        if (n !== 1) out.push(`${w}: needs exactly one ${role} file (found ${n})`);
      }
      if (!p.files.some((f) => isObj(f) && f.role === 'licence')) out.push(`${w}: a fetchable profile needs a licence file`);
    }
    const locals = p.files.filter(isObj).map((f) => f.local);
    if (new Set(locals).size !== locals.length) out.push(`${w}: duplicate local file names`);
  }

  const labels = p.labels;
  if (!isObj(labels) || Object.keys(labels).sort().join(',') !== '0,1') {
    out.push(`${w}: labels must have exactly the keys "0" and "1"`);
  } else {
    const a = labels['0'];
    const b = labels['1'];
    if (!isStr(a) || !isStr(b) || !a || !b || a === b) out.push(`${w}: labels need distinct non-empty values`);
    else if (p.malicious_label !== a && p.malicious_label !== b) out.push(`${w}: malicious_label is not one of the labels`);
  }
  if (!isStr(p.malicious_label)) out.push(`${w}: malicious_label required`);

  if (!isInt(p.max_tokens, 8, 512)) out.push(`${w}: max_tokens must be an integer 8..512`);
  else if (!isInt(p.stride, 0, p.max_tokens - 3)) out.push(`${w}: stride must be 0..max_tokens-3`);
  if (!isInt(p.max_chunks, 1, 64)) out.push(`${w}: max_chunks must be 1..64`);

  const st = p.special_tokens;
  if (!isObj(st) || !['cls', 'sep'].every((k) => isStr(st[k]) && st[k].length >= 1 && st[k].length <= 20)) {
    out.push(`${w}: special_tokens cls and sep must be 1..20 characters`);
  }
  if (!strArr(p.inputs) || !p.inputs.includes('input_ids') || !p.inputs.every((i) => INPUTS.includes(i))) {
    out.push(`${w}: inputs must contain input_ids and only ${INPUTS.join('|')}`);
  }
  if (!isStr(p.output) || !p.output) out.push(`${w}: output required`);

  const fit = p.fit;
  if (!isObj(fit)) out.push(`${w}: fit required`);
  else {
    const t = fit.threshold;
    if (t !== null && !(typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 1)) {
      out.push(`${w}: fit.threshold must be null or a number in [0, 1]`);
    }
  }
}

export function validateRegistry(raw: unknown): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return ['registry is not an object'];
  if (raw.version !== 1) out.push('version must be 1');
  if (!isObj(raw.profiles)) {
    out.push('profiles must be an object');
    return out;
  }
  if (!isStr(raw.default_profile) || !Object.prototype.hasOwnProperty.call(raw.profiles, raw.default_profile)) {
    out.push('default_profile must name an existing profile');
  }
  for (const [k, p] of Object.entries(raw.profiles)) validateProfile(k, p, out);
  return out;
}

export function loadRegistry(path = 'config/classifier-models.json'): ClassifierRegistry {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const problems = validateRegistry(raw);
  if (problems.length) throw new Error(`${path} is invalid: ${problems.join('; ')}`);
  return raw as ClassifierRegistry;
}

/** Replace only profiles[id].fit; validates the result and writes atomically (temp file + rename). */
export function writeFit(path: string, id: string, fit: ProfileFit): void {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const before = validateRegistry(raw);
  if (before.length) throw new Error(`${path} is invalid: ${before.join('; ')}`);
  const reg = raw as ClassifierRegistry;
  if (!Object.prototype.hasOwnProperty.call(reg.profiles, id)) throw new Error(`unknown profile "${id}"`);
  reg.profiles[id].fit = fit;
  const problems = validateRegistry(reg);
  if (problems.length) throw new Error(`refusing to write an invalid fit: ${problems.join('; ')}`);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function resolveProfile(reg: ClassifierRegistry, env: NodeJS.ProcessEnv): ClassifierProfile {
  const id = (env.CLASSIFIER_MODEL ?? '').trim();
  const known = Object.keys(reg.profiles);
  if (!id) {
    throw new Error(
      `CLASSIFIER_MODEL is not set. Run \`npm run setup\` to choose a classifier model (known: ${known.join(', ')}).`,
    );
  }
  if (!ID_RE.test(id) || !Object.prototype.hasOwnProperty.call(reg.profiles, id)) {
    throw new Error(`unknown CLASSIFIER_MODEL "${id}"; known profiles: ${known.join(', ')}`);
  }
  return reg.profiles[id];
}

export function maliciousIndex(p: ClassifierProfile): 0 | 1 {
  return p.labels['1'] === p.malicious_label ? 1 : 0;
}

export function modelDir(p: ClassifierProfile, root = process.cwd()): string {
  if (!ID_RE.test(p.id)) throw new Error(`invalid profile id: ${p.id}`);
  return join(root, 'models', p.id);
}

export function isFullyPinned(p: ClassifierProfile): boolean {
  return (
    p.files.length > 0 &&
    p.files.every((f) => f.sha256 !== null && HEX64.test(f.sha256)) &&
    p.revision !== '0123456789abcdef0123456789abcdef01234567'
  );
}

export function pinFromProfile(p: ClassifierProfile): ClassifierPin {
  if (!isFullyPinned(p)) {
    throw new Error(
      `profile ${p.id} is not fully pinned (a file has no sha256 or the revision is a placeholder); run \`npm run models -- pin ${p.id}\``,
    );
  }
  const entry = (f: ProfileFile): PinEntry => ({ file: f.local, sha256: f.sha256 as string });
  const one = (role: 'model' | 'tokenizer' | 'config'): PinEntry => {
    const f = p.files.find((x) => x.role === role);
    if (!f) throw new Error(`profile ${p.id} has no ${role} file`);
    return entry(f);
  };
  return {
    model: one('model'),
    tokenizer: one('tokenizer'),
    config: one('config'),
    extra: p.files.filter((f) => !['model', 'tokenizer', 'config'].includes(f.role)).map(entry),
    malicious_index: maliciousIndex(p),
    source: `${p.repo}@${p.revision}`,
  };
}
