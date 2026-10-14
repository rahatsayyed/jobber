// src/platform/ccgramHooks.ts
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { backupTarget, writeSecure } from './permissions.js';

export const CCGRAM_EVENTS = [
  'SessionStart',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
] as const;

const ASYNC_EVENTS = new Set<string>([
  'StopFailure',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
]);

const HOOK_SUFFIX = ' -m ccgram.main hook';
// shellQuote output: one single-quoted string, embedded quotes written as '\''.
const QUOTED_PATH = /^'(?:[^']|'\\'')*'$/;

// True only for the exact shape hookCommand emits (quoted interpreter path + HOOK_SUFFIX, end of
// string). Both halves come from the same constants, so emitter and matcher cannot drift.
export function isCcgramHookCommand(command: string): boolean {
  return command.endsWith(HOOK_SUFFIX) && QUOTED_PATH.test(command.slice(0, -HOOK_SUFFIX.length));
}

export interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
  [k: string]: unknown;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
  [k: string]: unknown;
}
export interface HookSettings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(pythonPath: string): string {
  return `${shellQuote(pythonPath)}${HOOK_SUFFIX}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// Description of the first wrong-typed hooks shape, or null when safe to merge.
export function hooksShapeProblem(settings: unknown): string | null {
  if (!isPlainObject(settings)) return 'top level is not a JSON object';
  if (!('hooks' in settings)) return null;
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return 'hooks is not an object';
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return `hooks.${event} is not an array`;
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) return `hooks.${event} has a group without a hooks array`;
      for (const h of g.hooks) {
        if (!isPlainObject(h)) return `hooks.${event} has a hook entry that is not an object`;
      }
    }
  }
  return null;
}

function assertShape(settings: HookSettings): void {
  const problem = hooksShapeProblem(settings);
  if (problem) throw new Error(`settings: ${problem}`);
}

const isCcgramEntry = (h: HookEntry): boolean => typeof h.command === 'string' && isCcgramHookCommand(h.command);

export function removeHooks(settings: HookSettings): HookSettings {
  assertShape(settings);
  const hooks: Record<string, HookGroup[]> = {};
  let changed = false;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept: HookGroup[] = [];
    for (const g of groups) {
      if (!g.hooks.some(isCcgramEntry)) {
        kept.push(g);
        continue;
      }
      changed = true;
      const rest = g.hooks.filter((h) => !isCcgramEntry(h));
      if (rest.length > 0) kept.push({ ...g, hooks: rest });
    }
    if (kept.length > 0) hooks[event] = kept;
  }
  // Nothing matched: return the input untouched (no `hooks: {}` or empty containers injected).
  if (!changed) return settings;
  return { ...settings, hooks };
}

export function mergeHooks(settings: HookSettings, pythonPath: string): HookSettings {
  const cleaned = removeHooks(settings);
  const hooks = { ...(cleaned.hooks ?? {}) };
  for (const event of CCGRAM_EVENTS) {
    const entry: HookEntry = { type: 'command', command: hookCommand(pythonPath), timeout: 5 };
    if (ASYNC_EVENTS.has(event)) entry.async = true;
    hooks[event] = [...(hooks[event] ?? []), { hooks: [entry] }];
  }
  return { ...cleaned, hooks };
}

export function hooksStatus(settings: HookSettings): Record<string, boolean> {
  assertShape(settings);
  const out: Record<string, boolean> = {};
  for (const event of CCGRAM_EVENTS) {
    out[event] = (settings.hooks?.[event] ?? []).some((g) => g.hooks.some(isCcgramEntry));
  }
  return out;
}

export function pythonFromShebang(line: string): string | null {
  const m = /^#!\s*(\/\S*python[\d.]*)\s*$/.exec(line.trim());
  return m ? m[1] : null;
}

export function resolveCcgramPython(deps: {
  which(name: string): string | null;
  readFirstLine(path: string): string;
}): string | null {
  const exe = deps.which('ccgram');
  if (!exe) return null;
  return pythonFromShebang(deps.readFirstLine(exe));
}

function readSettingsFile(path: string): HookSettings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    copyFileSync(path, backupTarget(path, 'invalid.bak'));
    throw new Error(`${path} is not valid JSON; refusing to overwrite it (copy kept as .invalid.bak)`);
  }
  const problem = hooksShapeProblem(parsed);
  if (problem) {
    copyFileSync(path, backupTarget(path, 'invalid.bak'));
    throw new Error(`${path}: ${problem}; refusing to overwrite it (copy kept as .invalid.bak)`);
  }
  return parsed as HookSettings;
}

function writeSettingsFile(path: string, next: HookSettings): void {
  if (existsSync(path)) copyFileSync(path, backupTarget(path, 'bak'));
  writeSecure(path, JSON.stringify(next, null, 2) + '\n');
}

// Writes ccgram hooks into a project settings file (0600, atomic). Never call with ~/.claude or
// the committed .claude/settings.json.
export function installHooksToFile(path: string, pythonPath: string): void {
  const current = readSettingsFile(path);
  writeSettingsFile(path, mergeHooks(current, pythonPath));
}

export function removeHooksFromFile(path: string): void {
  if (!existsSync(path)) return;
  const current = readSettingsFile(path);
  const next = removeHooks(current);
  if (next === current) return; // nothing of ours in the file: no write, no .bak
  writeSettingsFile(path, next);
}

// Read-only: never writes or copies anything, even for invalid input.
export function hooksStatusFromFile(path: string): Record<string, boolean> {
  if (!existsSync(path)) return hooksStatus({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('settings file is not valid JSON');
  }
  if (hooksShapeProblem(parsed)) throw new Error('settings file has an invalid hooks shape');
  return hooksStatus(parsed as HookSettings);
}
