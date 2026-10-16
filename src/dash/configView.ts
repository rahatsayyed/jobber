// src/dash/configView.ts
// Masked, read-only config view. Known keys come from the settings catalog (the only source of truth for what is
// secret); names found only in .env.example are listed by name, never with a value.
import { join } from 'node:path';
import type { Snapshot } from '../status/snapshot.js';
import { cleanText } from './clean.js';
import { isSecret, type EnvSpec } from '../settings/types.js';

export interface ConfigItem {
  name: string;
  value: string;
  masked: boolean;
}
export interface ConfigView {
  env: ConfigItem[];
  files: { path: string; summary: Record<string, unknown> }[];
  halts: Snapshot['halts'];
  ceilings: Snapshot['ceilings'];
}

// isSecret(spec) decides masking, non-secret keys show their value, and names that are not in the catalog are
// listed by name only (set/unset), never with a value.
export function catalogItem(spec: EnvSpec, value: string | undefined): ConfigItem {
  const isSet = value !== undefined && value !== '';
  if (isSecret(spec)) return { name: spec.key, value: isSet ? 'set' : 'unset', masked: true };
  return { name: spec.key, value: isSet ? cleanText(value, 200) : 'unset', masked: false };
}

export const CONFIG_FILES = [
  'config/portals.json',
  'config/target-regions.json',
  'config/deal-breakers.json',
  'config/replies.json',
  'config/permission-sets.json',
  'config/ccgram.pin.json',
];

function summarize(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return Array.isArray(v) ? { length: v.length } : { value: typeof v };
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const key = cleanText(k, 80);
    if (Array.isArray(x)) out[key] = x.length;
    else if (typeof x === 'boolean' || typeof x === 'number') out[key] = x;
    else if (x !== null && typeof x === 'object') out[key] = { keys: Object.keys(x).length };
    else out[key] = typeof x;
  }
  return out;
}

export function buildConfigView(deps: {
  root: string;
  env: NodeJS.ProcessEnv;
  read: (p: string) => string | null;
  snapshot: Snapshot;
  catalog: readonly EnvSpec[];
}): ConfigView {
  const names: string[] = [];
  const example = deps.read(join(deps.root, '.env.example'));
  if (example) {
    for (const line of example.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m && !names.includes(m[1])) names.push(m[1]);
    }
  }
  const known = new Set(deps.catalog.map((c) => c.key));
  const env: ConfigItem[] = deps.catalog.map((c) => catalogItem(c, deps.env[c.key]));
  for (const n of names) {
    if (known.has(n)) continue;
    const isSet = deps.env[n] !== undefined && deps.env[n] !== '';
    env.push({ name: n, value: isSet ? 'set' : 'unset', masked: false });
  }
  const files = CONFIG_FILES.map((path) => {
    const raw = deps.read(join(deps.root, path));
    if (raw === null) return { path, summary: { missing: true } as Record<string, unknown> };
    try {
      return { path, summary: summarize(JSON.parse(raw)) };
    } catch {
      return { path, summary: { unreadable: true } as Record<string, unknown> };
    }
  });
  return { env, files, halts: deps.snapshot.halts, ceilings: deps.snapshot.ceilings };
}
