// src/safety/classifierModel.ts
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createClassifier,
  DEFAULT_CLASSIFIER_CONFIG,
  type ClassifierConfig,
  type InjectionClassifier,
  type ModelRunner,
  type TokenizerLike,
} from './classifier.js';
import { isFullyPinned, maliciousIndex, modelDir, pinFromProfile, type ClassifierProfile } from './classifierRegistry.js';

export interface PinEntry {
  file: string;
  sha256: string;
}
export interface ClassifierPin {
  model: PinEntry;
  tokenizer: PinEntry;
  config: PinEntry;
  // fit.ts --pin (Task 4) must pin every file the tokenizer reads into `extra`.
  extra?: PinEntry[];
  malicious_index: number;
  source: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[A-Za-z0-9_.-]{1,100}$/;
export const safeFile = (f: string): boolean => SAFE_FILE.test(f) && f !== '.' && f !== '..';

export function loadPin(path: string): ClassifierPin {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ClassifierPin>;
  const entry = (e: unknown): boolean =>
    !!e &&
    typeof (e as PinEntry).file === 'string' &&
    safeFile((e as PinEntry).file) &&
    typeof (e as PinEntry).sha256 === 'string' &&
    HEX64.test((e as PinEntry).sha256);
  const extra = raw.extra === undefined ? [] : raw.extra;
  if (
    !entry(raw.model) ||
    !entry(raw.tokenizer) ||
    !entry(raw.config) ||
    !Array.isArray(extra) ||
    !extra.every(entry) ||
    (raw.malicious_index !== 0 && raw.malicious_index !== 1)
  ) {
    throw new Error(`${path} is not a valid classifier pin`);
  }
  return { ...(raw as ClassifierPin), extra };
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export async function verifyModelFiles(
  dir: string,
  pin: ClassifierPin,
  hash: (file: string) => Promise<string> = sha256File,
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  for (const e of [pin.model, pin.tokenizer, pin.config, ...(pin.extra ?? [])]) {
    const p = join(dir, e.file);
    if (!existsSync(p)) {
      problems.push(`missing file: ${e.file}`);
      continue;
    }
    const got = await hash(p);
    if (got !== e.sha256) problems.push(`sha256 mismatch: ${e.file}`);
  }
  return { ok: problems.length === 0, problems };
}

export interface SessionLike {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, { data: unknown }>): Promise<Record<string, { data: ArrayLike<number> }>>;
}
export interface TokenizerSpec {
  cls: string;
  sep: string;
}
export interface AdapterDeps {
  createSession(modelPath: string): Promise<SessionLike>;
  loadTokenizer(dir: string, spec?: TokenizerSpec): Promise<TokenizerLike>;
}

// Native binaries and the tokenizer package are imported lazily so that importing this module
// (and every unit test) never loads them.
const defaultDeps: AdapterDeps = {
  async createSession(modelPath) {
    const ort = (await import('onnxruntime-node')) as any;
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    return {
      inputNames: session.inputNames as string[],
      outputNames: session.outputNames as string[],
      async run(feeds) {
        const tensors: Record<string, unknown> = {};
        for (const [name, v] of Object.entries(feeds)) {
          const arr = v.data as BigInt64Array;
          tensors[name] = new ort.Tensor('int64', arr, [1, arr.length]);
        }
        return (await session.run(tensors)) as Record<string, { data: ArrayLike<number> }>;
      },
    };
  },
  async loadTokenizer(dir, spec) {
    const tf = (await import('@huggingface/transformers')) as any;
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = '/';
    const tok = await tf.AutoTokenizer.from_pretrained(dir);
    const lookup = (t: string): unknown => {
      const m = tok.model?.tokens_to_ids;
      if (m && typeof m.get === 'function') return m.get(t);
      if (typeof tok.convert_tokens_to_ids === 'function') return tok.convert_tokens_to_ids(t);
      return undefined;
    };
    const valid = (v: number): boolean => Number.isInteger(v) && v >= 0;
    const resolve = (name: 'cls' | 'sep', token: string, own: unknown): number => {
      const fromSpec = Number(lookup(token));
      const ownId = own === undefined || own === null ? undefined : Number(own);
      if (!spec) {
        // legacy path: the tokenizer's own id first, then the BERT literal
        const v = ownId ?? fromSpec;
        if (!valid(v)) throw new Error(`classifier tokenizer: cannot resolve ${name} token id`);
        return v;
      }
      if (!valid(fromSpec)) throw new Error(`classifier tokenizer: cannot resolve ${name} token id`);
      if (ownId !== undefined && ownId !== fromSpec) {
        throw new Error(`classifier tokenizer: ${name} token id disagrees with the profile special token`);
      }
      return fromSpec;
    };
    const clsId = resolve('cls', spec?.cls ?? '[CLS]', tok.cls_token_id);
    const sepId = resolve('sep', spec?.sep ?? '[SEP]', tok.sep_token_id);
    return {
      clsId,
      sepId,
      encode(text: string): number[] {
        return Array.from(tok.encode(text, { add_special_tokens: false }) as number[]);
      },
    };
  },
};

function validateConfig(c: ClassifierConfig): void {
  const int = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
  const ok =
    Number.isFinite(c.threshold) &&
    c.threshold >= 0 &&
    c.threshold <= 1 &&
    int(c.windowTokens, 2, 510) &&
    int(c.stride, 0, Number.MAX_SAFE_INTEGER) &&
    c.stride < c.windowTokens &&
    int(c.maxChunks, 1, 64);
  if (!ok) throw new Error('classifier config invalid');
}

export interface LoadedClassifier {
  classifier: InjectionClassifier;
  inputNames: string[];
  outputName: string;
  tokenizer: TokenizerLike;
  profileId: string;
  threshold: number;
}

export interface LoadOptions {
  profile?: ClassifierProfile;
  root?: string;
  dir?: string;
  pinPath?: string;
  configPath?: string;
  deps?: AdapterDeps;
  allowUnfitted?: boolean;
}

async function loadFromProfile(profile: ClassifierProfile, opts: LoadOptions): Promise<LoadedClassifier> {
  if (!isFullyPinned(profile)) {
    throw new Error(`classifier profile ${profile.id} is not fully pinned: run npm run models -- pin ${profile.id}`);
  }
  const dir = modelDir(profile, opts.root ?? process.cwd());
  const pin = pinFromProfile(profile);
  const check = await verifyModelFiles(dir, pin);
  if (!check.ok) throw new Error(`classifier integrity check failed: ${check.problems.join('; ')}`);

  const fit = profile.fit;
  const fitted = typeof fit.threshold === 'number' && fit.model_sha256 === pin.model.sha256;
  if (!fitted && !opts.allowUnfitted) {
    throw new Error(`classifier profile ${profile.id} has no fitted threshold for this model file`);
  }
  const threshold = fitted ? (fit.threshold as number) : 0.5;
  const config: ClassifierConfig = {
    ...DEFAULT_CLASSIFIER_CONFIG,
    windowTokens: profile.max_tokens - 2,
    stride: profile.stride,
    maxChunks: profile.max_chunks,
    maliciousIndex: maliciousIndex(profile),
    threshold,
  };
  validateConfig(config);

  const deps = opts.deps ?? defaultDeps;
  const session = await deps.createSession(join(dir, pin.model.file));
  const want = new Set(profile.inputs);
  const got = new Set(session.inputNames);
  if (want.size !== got.size || [...want].some((n) => !got.has(n))) {
    throw new Error(`classifier model inputs differ from profile ${profile.id}`);
  }
  if (!session.outputNames.includes(profile.output)) {
    throw new Error(`classifier model has no output named ${profile.output} (profile ${profile.id})`);
  }
  const tokenizer = await deps.loadTokenizer(dir, profile.special_tokens);
  const outputName = profile.output;

  const run: ModelRunner = async (ids) => {
    const feeds: Record<string, { data: unknown }> = {};
    for (const name of profile.inputs) {
      if (name === 'input_ids') feeds[name] = { data: BigInt64Array.from(ids.map((n) => BigInt(n))) };
      else if (name === 'attention_mask') feeds[name] = { data: BigInt64Array.from(ids.map(() => 1n)) };
      else if (name === 'token_type_ids') feeds[name] = { data: BigInt64Array.from(ids.map(() => 0n)) };
      else throw new Error(`classifier profile ${profile.id} has an unsupported input: ${name}`);
    }
    const out = await session.run(feeds);
    return Array.from(out[outputName].data);
  };

  return {
    classifier: createClassifier({ tokenizer, run, config }),
    inputNames: [...profile.inputs],
    outputName,
    tokenizer,
    profileId: profile.id,
    threshold,
  };
}

export async function loadClassifier(opts: LoadOptions = {}): Promise<LoadedClassifier> {
  if (opts.profile) return loadFromProfile(opts.profile, opts);
  const dir = opts.dir ?? process.env.CLASSIFIER_MODEL_DIR ?? 'models/prompt-guard-2-22m';
  const pin = loadPin(opts.pinPath ?? 'config/classifier.pin.json');
  const check = await verifyModelFiles(dir, pin);
  if (!check.ok) throw new Error(`classifier integrity check failed: ${check.problems.join('; ')}`);

  let config: ClassifierConfig = { ...DEFAULT_CLASSIFIER_CONFIG, maliciousIndex: pin.malicious_index };
  const cfgPath = opts.configPath ?? 'config/classifier.json';
  if (existsSync(cfgPath)) {
    const { maliciousIndex: _ignored, ...fileCfg } = JSON.parse(readFileSync(cfgPath, 'utf8')) as Partial<ClassifierConfig>;
    config = { ...config, ...fileCfg };
  }
  validateConfig(config);

  const deps = opts.deps ?? defaultDeps;
  const session = await deps.createSession(join(dir, pin.model.file));
  const tokenizer = await deps.loadTokenizer(dir);
  const outputName = session.outputNames.includes('logits') ? 'logits' : session.outputNames[0];

  const run: ModelRunner = async (ids) => {
    const input_ids = BigInt64Array.from(ids.map((n) => BigInt(n)));
    const feeds: Record<string, { data: unknown }> = {};
    for (const name of session.inputNames) {
      if (name === 'input_ids') feeds[name] = { data: input_ids };
      else if (name === 'attention_mask') feeds[name] = { data: BigInt64Array.from(ids.map(() => 1n)) };
      else if (name === 'token_type_ids') feeds[name] = { data: BigInt64Array.from(ids.map(() => 0n)) };
      else throw new Error(`classifier model has an unexpected input: ${name}`);
    }
    const out = await session.run(feeds);
    return Array.from(out[outputName].data);
  };

  return {
    classifier: createClassifier({ tokenizer, run, config }),
    inputNames: session.inputNames,
    outputName,
    tokenizer,
    profileId: 'legacy',
    threshold: config.threshold,
  };
}

let singleton: Promise<InjectionClassifier> | null = null;
export function _resetClassifierForTests(): void {
  singleton = null;
}
/**
 * @deprecated Use getActiveClassifier from classifierSelect.ts (profile-driven, one model per
 * process, refuses unfitted profiles outside dry runs). Kept for 6B tests and legacy callers.
 */
export function getClassifier(load: () => Promise<LoadedClassifier> = loadClassifier): Promise<InjectionClassifier> {
  if (!singleton) {
    const p = load().then((l) => l.classifier);
    singleton = p;
    p.catch(() => {
      if (singleton === p) singleton = null; // never cache a failure; a later call retries
    });
  }
  return singleton;
}
