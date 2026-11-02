// Files of the shared browser host (no browser code here): the pidfile secrets/browser-host.json (mode 0600, the ONLY place the
// DevTools endpoint is written), the client leases secrets/browser-host-clients/<pid>-<id>.json (one per attached client, so the
// host can count live clients and exit when none is left), and the read-only status the doctor and `npm run browser:host -- status`
// print. Nothing here logs or returns the endpoint: status() leaves it out.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'secrets');
export const DEFAULT_HOST_PIDFILE = path.join(SECRETS, 'browser-host.json');
export const DEFAULT_HOST_LEASE_DIR = path.join(SECRETS, 'browser-host-clients');
export const DEFAULT_HOST_START_LOCK = path.join(SECRETS, 'browser-host.start.lock');
/** A heartbeat older than this means the host is gone or hung: the pidfile is treated as stale. */
export const HOST_STALE_MS = 2 * 60 * 1000;

export type HostMode = 'headless' | 'headed';
export interface HostInfo {
  v: 1;
  pid: number;
  mode: HostMode;
  state: 'starting' | 'ready';
  startedAt: string;
  heartbeatAt: string;
  /** Loopback DevTools websocket endpoint; absent while starting. Never printed. */
  ws?: string;
  clients?: number;
  tabs?: number;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Parsed pidfile or null (missing, unreadable, not a regular 0600 file, wrong shape). */
export function readHostFile(p: string = DEFAULT_HOST_PIDFILE): HostInfo | null {
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return null;
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return null;
    const j = JSON.parse(readFileSync(p, 'utf8')) as Partial<HostInfo>;
    if (j.v !== 1 || !Number.isInteger(j.pid) || (j.mode !== 'headless' && j.mode !== 'headed')) return null;
    if (j.ws !== undefined && typeof j.ws !== 'string') return null;
    return j as HostInfo;
  } catch { return null; }
}

/** Atomic 0600 write (tmp + rename). */
export function writeHostFile(info: HostInfo, p: string = DEFAULT_HOST_PIDFILE): void {
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

/** Exclusive create (the start claim): false when a pidfile already exists. */
export function claimHostFile(info: HostInfo, p: string = DEFAULT_HOST_PIDFILE): boolean {
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  try { writeFileSync(p, JSON.stringify(info), { mode: 0o600, flag: 'wx' }); return true; } catch { return false; }
}

/** Removes the pidfile only when it still names this pid. */
export function removeHostFile(pid: number, p: string = DEFAULT_HOST_PIDFILE): void {
  try {
    const cur = JSON.parse(readFileSync(p, 'utf8')) as { pid?: number };
    if (cur.pid === pid) unlinkSync(p);
  } catch { /* gone */ }
}

export type HostLiveness =
  | { kind: 'none' }
  | { kind: 'stale'; pid: number; why: 'dead' | 'heartbeat' | 'unreadable' }
  | { kind: 'live'; info: HostInfo };

export interface LivenessDeps { now?: () => number; isAlive?: (pid: number) => boolean; staleMs?: number }

/** Reads the pidfile and classifies it. A pid that is alive but has not written a heartbeat for HOST_STALE_MS is stale too. */
export function hostLiveness(p: string = DEFAULT_HOST_PIDFILE, deps: LivenessDeps = {}): HostLiveness {
  if (!existsSync(p)) return { kind: 'none' };
  const info = readHostFile(p);
  if (!info) return { kind: 'stale', pid: -1, why: 'unreadable' };
  const isAlive = deps.isAlive ?? pidAlive;
  if (!isAlive(info.pid)) return { kind: 'stale', pid: info.pid, why: 'dead' };
  const beat = Date.parse(info.heartbeatAt);
  const now = (deps.now ?? Date.now)();
  if (!Number.isFinite(beat) || now - beat > (deps.staleMs ?? HOST_STALE_MS)) return { kind: 'stale', pid: info.pid, why: 'heartbeat' };
  return { kind: 'live', info };
}

/** Removes a stale pidfile (dead pid, stale heartbeat or unreadable). Returns true when one was removed. */
export function cleanStaleHostFile(p: string = DEFAULT_HOST_PIDFILE, deps: LivenessDeps = {}): boolean {
  const l = hostLiveness(p, deps);
  if (l.kind !== 'stale') return false;
  try { unlinkSync(p); return true; } catch { return false; }
}

// ---- Client leases ----

const LEASE_RE = /^(\d+)-[a-z0-9]{6,16}\.json$/;

export function writeLease(dir: string = DEFAULT_HOST_LEASE_DIR, pid: number = process.pid): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `${pid}-${Math.random().toString(36).slice(2, 12).padEnd(6, '0')}.json`);
  writeFileSync(p, JSON.stringify({ pid, at: new Date().toISOString() }), { mode: 0o600 });
  return p;
}

export function removeLease(p: string): void { try { unlinkSync(p); } catch { /* gone */ } }

/** Live leases (pid alive); leases of dead pids are removed on the way. */
export function liveLeases(dir: string = DEFAULT_HOST_LEASE_DIR, isAlive: (pid: number) => boolean = pidAlive): number {
  let n = 0;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const m = LEASE_RE.exec(name);
    if (!m) continue;
    if (isAlive(Number(m[1]))) n++;
    else removeLease(path.join(dir, name));
  }
  return n;
}

// ---- Status (doctor, browser:host status) ----

export interface HostStatus { running: boolean; line: string; stale?: boolean }

/** One line for people: pid, mode, attached clients and tabs; never the endpoint. */
export function hostStatus(p: string = DEFAULT_HOST_PIDFILE, deps: LivenessDeps = {}): HostStatus {
  const l = hostLiveness(p, deps);
  if (l.kind === 'none') return { running: false, line: 'shared browser host: not running (it starts on first use)' };
  if (l.kind === 'stale') {
    const why = l.why === 'dead' ? `pid ${l.pid} is gone` : l.why === 'heartbeat' ? `pid ${l.pid} stopped answering` : 'pidfile unreadable';
    return { running: false, stale: true, line: `shared browser host: stale pidfile (${why})` };
  }
  const i = l.info;
  const age = Math.max(0, Math.round(((deps.now ?? Date.now)() - Date.parse(i.startedAt)) / 60000));
  return {
    running: true,
    line: `shared browser host: pid ${i.pid}, ${i.mode}, ${i.state}, ${i.clients ?? 0} client${i.clients === 1 ? '' : 's'} attached, ${i.tabs ?? 0} tab${i.tabs === 1 ? '' : 's'}, up ${age} min`,
  };
}
