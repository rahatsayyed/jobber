// src/dash/configView.ts
// Masked, read-only config view. Env names come from .env.example (names only), never from .env.
import { join } from 'node:path';
import type { Snapshot } from '../status/snapshot.js';
import { cleanText } from './clean.js';

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

const SECRET_RE = /TOKEN|SECRET|PASS|KEY|COOKIE|CREDENTIAL|AUTH/i;
const ALLOW_EXACT = new Set([
  'MATCH_THRESHOLD',
  'SEND_LIMIT_PER_RUN',
  'WEB_PORT',
  'WEB_TMUX_SESSION',
  'WEB_TMUX_WINDOW',
  'WEB_CHAT_ENABLED',
  'AUTO_UPDATE',
  'NAUKRI_HEADLESS',
]);
const ALLOW_PATTERNS = [/^MAX_/, /_PER_DAY$/, /_PER_WEEK$/];

function allowed(name: string): boolean {
  return ALLOW_EXACT.has(name) || ALLOW_PATTERNS.some((r) => r.test(name));
}

export function maskValue(name: string, value: string | undefined): ConfigItem {
  const isSet = value !== undefined && value !== '';
  if (SECRET_RE.test(name)) return { name, value: isSet ? 'set' : 'unset', masked: true };
  if (allowed(name) && isSet) return { name, value: cleanText(value, 200), masked: false };
  return { name, value: isSet ? 'set' : 'unset', masked: false };
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
}): ConfigView {
  const names: string[] = [];
  const example = deps.read(join(deps.root, '.env.example'));
  if (example) {
    for (const line of example.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m && !names.includes(m[1])) names.push(m[1]);
    }
  }
  const env = names.map((n) => maskValue(n, deps.env[n]));
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
