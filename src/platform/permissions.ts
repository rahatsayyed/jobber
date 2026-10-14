// src/platform/permissions.ts
import { chmodSync, copyFileSync,existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type SetName = 'read_only' | 'outreach_send' | 'full';
export const SET_NAMES: SetName[] = ['read_only', 'outreach_send', 'full'];

export type RawSets = Record<string, { extends?: string; allow: string[] }>;

export interface LocalSettings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

const MCP_ENTRY = /^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$/;

/* The only non-MCP entries allowed: three read-only status script calls, matched literally. */
const STATUS_BASH_ENTRIES = new Set(
  ['limits', 'working', 'health'].map((sub) => `Bash(npx tsx scripts/status.ts ${sub})`),
);

export function validateSets(sets: RawSets): void {
  for (const [name, set] of Object.entries(sets)) {
    if (!set || !Array.isArray(set.allow) || set.allow.some((e) => typeof e !== 'string')) {
      throw new Error(`permission set ${name}: allow must be an array of strings`);
    }
    for (const entry of set.allow) {
      if (!MCP_ENTRY.test(entry) && !STATUS_BASH_ENTRIES.has(entry)) {
        throw new Error(`permission set ${name}: entry is not an MCP tool name or an allowed status command: ${entry}`);
      }
    }
  }
}

export function resolveSet(sets: RawSets, name: string): string[] {
  const chain: string[][] = [];
  const seen = new Set<string>();
  let current: string | undefined = name;
  while (current) {
    if (seen.has(current)) throw new Error(`permission set cycle at ${current}`);
    seen.add(current);
    const set: RawSets[string] | undefined = sets[current];
    if (!set) throw new Error(`unknown permission set: ${current}`);
    chain.push(set.allow);
    current = set.extends;
  }
  const out: string[] = [];
  for (const allow of chain.reverse()) for (const entry of allow) if (!out.includes(entry)) out.push(entry);
  return out;
}

function managedEntries(sets: RawSets): Set<string> {
  const all = new Set<string>();
  for (const name of Object.keys(sets)) for (const e of resolveSet(sets, name)) all.add(e);
  return all;
}

export function applySet(settings: LocalSettings, sets: RawSets, name: string): LocalSettings {
  const managed = managedEntries(sets);
  const desired = resolveSet(sets, name);
  const existing = settings.permissions?.allow ?? [];
  const userEntries = existing.filter((e) => !managed.has(e));
  return { ...settings, permissions: { ...settings.permissions, allow: [...userEntries, ...desired] } };
}

export function detectSet(settings: LocalSettings, sets: RawSets): SetName | 'custom' {
  const managed = managedEntries(sets);
  const active = new Set((settings.permissions?.allow ?? []).filter((e) => managed.has(e)));
  for (const name of [...SET_NAMES].reverse()) {
    const wanted = new Set(resolveSet(sets, name));
    if (wanted.size === active.size && [...wanted].every((e) => active.has(e))) return name;
  }
  return 'custom';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((e) => typeof e === 'string');

// Returns a description of the first shape problem, or null when safe to merge.
function shapeProblem(v: unknown): string | null {
  if (!isPlainObject(v)) return 'top level is not a JSON object';
  if ('permissions' in v) {
    const perms = v.permissions;
    if (!isPlainObject(perms)) return 'permissions is not an object';
    for (const k of ['allow', 'deny', 'ask']) {
      if (k in perms && !isStringArray(perms[k])) return `permissions.${k} is not an array of strings`;
    }
  }
  return null;
}

export function manifestPath(settingsPath: string): string {
  return settingsPath.replace(/\.json$/, '') + '.managed.json';
}

export function backupTarget(path: string, suffix: string): string {
  const first = `${path}.${suffix}`;
  return existsSync(first) ? `${path}.${Date.now()}.${suffix}` : first;
}

export function writeSecure(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// Missing manifest: null (fine). Present but unparseable or wrong-shaped: throw, so a switch can
// never silently keep entries we own. The message is fixed (no file content echoed).
function readManifest(path: string): string[] | null {
  if (!existsSync(path)) return null;
  let m: unknown;
  try {
    m = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} exists but is not valid JSON; refusing to change permissions (fix or delete it)`);
  }
  if (isPlainObject(m) && isStringArray(m.entries)) return m.entries as string[];
  throw new Error(`${path} exists but has an invalid shape; refusing to change permissions (fix or delete it)`);
}

export function applySetToFile(path: string, sets: RawSets, name: SetName): void {
  validateSets(sets);
  const desired = resolveSet(sets, name);
  // Validated before anything is read or written, so a bad manifest leaves settings untouched.
  const mPath = manifestPath(path);
  const old = new Set(readManifest(mPath) ?? []);
  let current: LocalSettings = {};
  let hadFile = false;
  if (existsSync(path)) {
    hadFile = true;
    const text = readFileSync(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      copyFileSync(path, backupTarget(path, 'invalid.bak'));
      throw new Error(`${path} is not valid JSON; refusing to overwrite it (copy kept as .invalid.bak)`);
    }
    const problem = shapeProblem(parsed);
    if (problem) {
      copyFileSync(path, backupTarget(path, 'invalid.bak'));
      throw new Error(`${path}: ${problem}; refusing to overwrite it (copy kept as .invalid.bak)`);
    }
    current = parsed as LocalSettings;
  }
  const kept = (current.permissions?.allow ?? []).filter((e) => !old.has(e));
  const added = desired.filter((e) => !kept.includes(e));
  const next: LocalSettings = {
    ...current,
    permissions: { ...current.permissions, allow: [...kept, ...added] },
  };
  if (hadFile) copyFileSync(path, backupTarget(path, 'bak'));
  // Crash window: the two files cannot be replaced atomically together. The manifest goes first
  // with the union of old and new entries (a superset), so a crash before the settings rename
  // never orphans an entry we own; manifest entries absent from settings are ignored. The final
  // manifest (exactly what we added) is written after the settings file.
  const union = [...old, ...added.filter((e) => !old.has(e))];
  writeSecure(mPath, JSON.stringify({ set: name, entries: union }, null, 2) + '\n');
  writeSecure(path, JSON.stringify(next, null, 2) + '\n');
  writeSecure(mPath, JSON.stringify({ set: name, entries: added }, null, 2) + '\n');
}
