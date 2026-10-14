// src/platform/permissions.ts
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type SetName = 'read_only' | 'outreach_send' | 'full';
export const SET_NAMES: SetName[] = ['read_only', 'outreach_send', 'full'];

export type RawSets = Record<string, { extends?: string; allow: string[] }>;

export interface LocalSettings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

const MCP_ENTRY = /^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$/;

export function validateSets(sets: RawSets): void {
  for (const [name, set] of Object.entries(sets)) {
    for (const entry of set.allow) {
      if (!MCP_ENTRY.test(entry)) throw new Error(`permission set ${name}: entry is not an MCP tool name: ${entry}`);
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

export function applySetToFile(path: string, sets: RawSets, name: SetName): void {
  validateSets(sets);
  let current: LocalSettings = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      copyFileSync(path, `${path}.invalid.bak`);
      throw new Error(`${path} is not valid JSON; refusing to overwrite it (copy kept at ${path}.invalid.bak)`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      copyFileSync(path, `${path}.invalid.bak`);
      throw new Error(`${path} is not a JSON object; refusing to overwrite it (copy kept at ${path}.invalid.bak)`);
    }
    current = parsed as LocalSettings;
    copyFileSync(path, `${path}.bak`);
  }
  const next = applySet(current, sets, name);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, path);
}
