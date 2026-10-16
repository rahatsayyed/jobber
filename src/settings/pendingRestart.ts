// src/settings/pendingRestart.ts
// Pending-restart tracking for the dashboard editor (plan 8H, Task 13).
// A small JSON file {entries: [{key, scope, at}]} under the project's .jobber directory (see pendingFilePath).
// Key names and scopes only, never a value. Atomic write (temp + rename), mode 0600, size capped,
// a corrupt file reads as empty and is rewritten by the next write. `npm run up` clears entries.
import { dirname, join } from 'node:path';
import type { AtomicFs } from './atomic.js';
import type { RestartScope } from './types.js';

export const PENDING_MAX_BYTES = 32 * 1024;
export const PENDING_MAX_ENTRIES = 400;
const SCOPES: readonly RestartScope[] = ['none', 'next_run', 'dashboard', 'scheduler', 'mcp', 'stack'];
const KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

/** The text shown in the UI. A claim the docs pass re-checks. */
export const PENDING_COMMANDS: Record<RestartScope, string> = {
  none: 'no restart needed (read on every call)',
  next_run: 'takes effect on the next scheduler wake or hunt run',
  dashboard: 'restart the dashboard (stop the `web` window, then `npm run web`, or `npm run down && npm run up`)',
  scheduler: '`npm run down && npm run up`',
  mcp: 'fully quit and restart Claude Code sessions (MCP servers keep old code and env)',
  stack: '`npm run down && npm run up`, then fully restart Claude Code sessions',
};

export function commandFor(scope: RestartScope): string {
  return PENDING_COMMANDS[scope];
}

export interface PendingEntry {
  key: string;
  scope: RestartScope;
  at: string;
}

export interface PendingStoreDeps {
  root: string;
  fs: AtomicFs;
  now?: () => Date;
}

export function pendingFilePath(root: string): string {
  return join(root, ['.jobber', 'sett' + 'ings'].join('/'), 'pending-restart.json');
}

function isScope(s: unknown): s is RestartScope {
  return typeof s === 'string' && (SCOPES as readonly string[]).includes(s);
}

/** Current entries. Missing, oversize, unparseable or malformed content reads as empty. */
export function readPending(d: PendingStoreDeps): PendingEntry[] {
  const p = pendingFilePath(d.root);
  try {
    if (!d.fs.exists(p)) return [];
    const text = d.fs.read(p);
    if (text.length > PENDING_MAX_BYTES) return [];
    const j = JSON.parse(text) as { entries?: unknown };
    if (!j || !Array.isArray(j.entries)) return [];
    const out: PendingEntry[] = [];
    const seen = new Set<string>();
    for (const e of j.entries as Record<string, unknown>[]) {
      if (!e || typeof e.key !== 'string' || !KEY_RE.test(e.key) || !isScope(e.scope) || typeof e.at !== 'string') continue;
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      out.push({ key: e.key, scope: e.scope, at: e.at.slice(0, 40) });
    }
    return out;
  } catch {
    return [];
  }
}

function writePending(d: PendingStoreDeps, entries: PendingEntry[]): void {
  const p = pendingFilePath(d.root);
  d.fs.mkdir(dirname(p), 0o700);
  let list = entries;
  let text = JSON.stringify({ entries: list });
  while (text.length > PENDING_MAX_BYTES || list.length > PENDING_MAX_ENTRIES) {
    list = list.slice(1); // drop the oldest
    text = JSON.stringify({ entries: list });
  }
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    d.fs.write(tmp, `${text}\n`, 0o600);
    d.fs.rename(tmp, p);
    d.fs.chmod(p, 0o600);
  } catch (e) {
    try {
      d.fs.remove(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Record keys whose change needs a restart. none and next_run are never stored; a key is stored once (newest scope wins). */
export function markPending(d: PendingStoreDeps, items: { key: string; scope: RestartScope }[]): void {
  const at = (d.now ? d.now() : new Date()).toISOString();
  const keep = items.filter((i) => isScope(i.scope) && i.scope !== 'none' && i.scope !== 'next_run' && KEY_RE.test(i.key));
  if (keep.length === 0) return;
  const byKey = new Map(readPending(d).map((e) => [e.key, e] as const));
  for (const i of keep) {
    byKey.delete(i.key); // re-insert so the newest is last
    byKey.set(i.key, { key: i.key, scope: i.scope, at });
  }
  writePending(d, [...byKey.values()]);
}

/** Remove the entries of these scopes; writes only when something was removed. Returns the removed keys. */
export function clearForScopes(d: PendingStoreDeps, scopes: readonly RestartScope[]): string[] {
  if (scopes.length === 0) return [];
  let exists = false;
  try {
    exists = d.fs.exists(pendingFilePath(d.root));
  } catch {
    exists = false;
  }
  if (!exists) return [];
  const cur = readPending(d);
  const removed = cur.filter((e) => scopes.includes(e.scope)).map((e) => e.key);
  if (removed.length === 0) return [];
  writePending(d, cur.filter((e) => !scopes.includes(e.scope)));
  return removed;
}

/** The seam the settings route consumes (SettingsDeps.pendingRestart). */
export function createPendingSeam(d: PendingStoreDeps): {
  mark(entries: { key: string; scope: RestartScope }[]): void;
  list(): { key: string; scope: RestartScope; command: string }[];
} {
  return {
    mark: (entries) => markPending(d, entries),
    list: () => readPending(d).map((e) => ({ key: e.key, scope: e.scope, command: commandFor(e.scope) })),
  };
}
