// The shared browser host (one Chrome on secrets/browser-profile/ for every platform and the web group).
//   npm run browser:host -- status   pid, mode, attached clients and tabs (never the endpoint); removes a stale pidfile
//   npm run browser:host -- stop     asks the running host to close Chrome and exit
//   (internal) browser-host.ts run --mode headless|headed   started by src/webcore/hostClient.ts, detached, on first use
// The host exits by itself after BROWSER_HOST_IDLE_MIN minutes with no client, at once on the kill switch, and when Chrome closes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost, killSwitchOn } from '../src/webcore/hostServer.js';
import { cleanStaleHostFile, hostStatus } from '../src/webcore/hostFile.js';
import { createHostClient } from '../src/webcore/hostClient.js';
import { loadHostConfig } from '../src/webcore/config.js';
import { stopFileForRoot } from '../src/scheduler/control.js';
import { haltReason } from '../src/outreach/limits.js';
import { openDb } from '../src/db.js';
import type BetterSqlite3 from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: npm run browser:host -- status|stop';

async function runHost(mode: 'headless' | 'headed'): Promise<number> {
  const env = process.env;
  const stopFile = stopFileForRoot(ROOT);
  let db: BetterSqlite3.Database | null = null;
  const allHalted = (): boolean => {
    // Fails closed: unreadable halt state refuses new tabs.
    try { db ??= openDb(); return haltReason(db, 'all') !== null; } catch { return true; }
  };
  const cfg = loadHostConfig(env);
  const r = await startHost({
    mode, killed: () => killSwitchOn(stopFile, env), allHalted, idleMs: cfg.idleMs, heartbeatMs: 5000,
  });
  if (!r.ok) { console.error(`[browser-host] not started: ${r.code}`); return r.code === 'running' ? 0 : 1; }
  const h = r.handle;
  process.on('SIGTERM', () => { void h.shutdown('stop requested'); });
  process.on('SIGINT', () => { void h.shutdown('interrupted'); });
  process.on('SIGHUP', () => { void h.shutdown('hangup'); });
  process.on('SIGUSR1', () => { void h.handover(); });
  await h.done;
  try { db?.close(); } catch { /* ignore */ }
  return 0;
}

export async function main(argv: string[]): Promise<{ code: number; lines: string[] }> {
  const [cmd, ...rest] = argv;
  if (cmd === 'status') {
    const removed = cleanStaleHostFile();
    const s = hostStatus();
    return { code: 0, lines: [removed ? 'shared browser host: removed a stale pidfile; not running' : s.line] };
  }
  if (cmd === 'stop') {
    const ok = await createHostClient().stop();
    return { code: ok ? 0 : 1, lines: [ok ? 'shared browser host: stopped (or was not running)' : 'shared browser host: did not stop in time'] };
  }
  if (cmd === 'run') {
    const i = rest.indexOf('--mode');
    const mode = rest[i + 1];
    if (i < 0 || (mode !== 'headless' && mode !== 'headed')) return { code: 2, lines: [USAGE] };
    return { code: await runHost(mode), lines: [] };
  }
  return { code: 2, lines: [USAGE] };
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((r) => { for (const l of r.lines) console.log(l); process.exit(r.code); }, () => { console.error('browser:host failed'); process.exit(1); });
}
