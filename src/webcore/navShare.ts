// Per-host navigation times shared by every web-group process (scout, applier, sources runner, contacts dork) while they use tabs of
// the ONE shared browser: the WEB_MIN_GAP_SEC gap then holds across processes, not only inside one. Best effort: a file of
// { host: epoch ms } under .jobber/ (no secrets, host names only), written tmp + rename; a read or write problem never fails a page load.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_NAV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.jobber', 'web-nav.json');
const MAX_HOSTS = 500;

function readAll(file: string): Record<string, number> {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  } catch { return {}; }
}

export function sharedLastNav(host: string, file: string = DEFAULT_NAV_FILE): number | undefined {
  return readAll(file)[host];
}

export function recordSharedNav(host: string, at: number, file: string = DEFAULT_NAV_FILE): void {
  if (!host) return;
  try {
    const all = readAll(file);
    all[host] = Math.max(all[host] ?? 0, at);
    const keep = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, MAX_HOSTS);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)));
    renameSync(tmp, file);
  } catch { /* best effort */ }
}
