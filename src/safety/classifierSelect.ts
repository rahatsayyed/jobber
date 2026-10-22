// src/safety/classifierSelect.ts
// One active classifier per process, chosen by CLASSIFIER_MODEL. No fallback chain.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from '../platform/envFile.js';
import type { ClassifierPort } from './inputGate.js';
import { loadClassifier, type LoadedClassifier, type LoadOptions } from './classifierModel.js';
import { isDryRun } from './dryRun.js';
import { loadRegistry, resolveProfile, type ClassifierRegistry } from './classifierRegistry.js';

export type ClassifierUse = 'send' | 'dry_run';

export function currentUse(env: NodeJS.ProcessEnv = process.env): ClassifierUse {
  return isDryRun(env) ? 'dry_run' : 'send';
}

export interface SelectDeps {
  loadRegistry?: () => ClassifierRegistry;
  load?: (opts: LoadOptions) => Promise<LoadedClassifier>;
  env?: NodeJS.ProcessEnv;
  root?: string;
  warn?: (msg: string) => void; // never receives text under classification
}

interface Cached {
  key: string;
  id: string;
  port: Promise<ClassifierPort>;
}
let cached: Cached | null = null;

/** Process env wins; when it has no CLASSIFIER_MODEL, take just that key from <root>/.env. Never throws. */
function withEnvFileModel(env: NodeJS.ProcessEnv, root: string | undefined): NodeJS.ProcessEnv {
  if (!root || (env.CLASSIFIER_MODEL ?? '').trim()) return env;
  try {
    const v = parseEnv(readFileSync(join(root, '.env'), 'utf8')).CLASSIFIER_MODEL;
    return v && v.trim() ? { ...env, CLASSIFIER_MODEL: v.trim() } : env;
  } catch {
    return env;
  }
}

export function _resetActiveClassifierForTests(): void {
  cached = null;
}

/** Resolve CLASSIFIER_MODEL, load exactly that profile once, return it as a gate port. Rejects (and does not cache) on any failure. */
export async function getActiveClassifier(use?: ClassifierUse, deps: SelectDeps = {}): Promise<ClassifierPort> {
  const baseEnv = deps.env ?? process.env;
  const u = use ?? currentUse(baseEnv);
  // Stdio MCP servers inherit the launching claude's env, which may lack .env keys: read ONLY CLASSIFIER_MODEL from .env.
  const env = withEnvFileModel(baseEnv, deps.root ?? (deps.env && deps.env !== process.env ? undefined : process.cwd()));
  const reg = (deps.loadRegistry ?? (() => loadRegistry()))();
  const profile = resolveProfile(reg, env);
  const digest = profile.files.find((f) => f.role === 'model')?.sha256 ?? 'none';
  const key = `${profile.id}|${digest}|${u}`;

  if (cached) {
    if (cached.key === key) return cached.port;
    throw new Error(`classifier already loaded for ${cached.id}`);
  }

  const load = deps.load ?? loadClassifier;
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const dry = u === 'dry_run';
  const port = load({ profile, root: deps.root, allowUnfitted: dry }).then((loaded): ClassifierPort => {
    if (dry) warn(`classifier profile ${profile.id} is unfitted: dry run only`);
    return { classify: (t) => loaded.classifier.classify(t) };
  });
  const entry: Cached = { key, id: profile.id, port };
  cached = entry;
  port.catch(() => {
    if (cached === entry) cached = null; // never cache a failure
  });
  return port;
}
