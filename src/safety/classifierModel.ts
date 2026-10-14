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
const safeFile = (f: string): boolean => SAFE_FILE.test(f) && f !== '.' && f !== '..';

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
export interface AdapterDeps {
  createSession(modelPath: string): Promise<SessionLike>;
  loadTokenizer(dir: string): Promise<TokenizerLike>;
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
  async loadTokenizer(dir) {
    const tf = (await import('@huggingface/transformers')) as any;
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = '/';
    const tok = await tf.AutoTokenizer.from_pretrained(dir);
    const clsId = Number(tok.cls_token_id ?? tok.model?.tokens_to_ids?.get('[CLS]'));
    const sepId = Number(tok.sep_token_id ?? tok.model?.tokens_to_ids?.get('[SEP]'));
    for (const [n, v] of [['cls', clsId], ['sep', sepId]] as const) {
      if (!Number.isInteger(v) || v < 0) throw new Error(`classifier tokenizer: cannot resolve ${n} token id`);
    }
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
}

export async function loadClassifier(
  opts: { dir?: string; pinPath?: string; configPath?: string; deps?: AdapterDeps } = {},
): Promise<LoadedClassifier> {
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

  return { classifier: createClassifier({ tokenizer, run, config }), inputNames: session.inputNames, outputName };
}

let singleton: Promise<InjectionClassifier> | null = null;
export function _resetClassifierForTests(): void {
  singleton = null;
}
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
