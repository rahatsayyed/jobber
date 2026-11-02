// The shared browser HOST process (scripts/browser-host.ts runs it; nothing else may import this file, see
// tests/browser-launch-lint.test.ts). It owns the ONE persistent Chrome profile secrets/browser-profile/ for every platform and the
// web group, headless or headed, with extensions allowed. The MCP processes attach over CDP (src/webcore/hostClient.ts) and open
// their own tab; a client closing its tab never closes the browser.
//
// Safety: the DevTools port is loopback only and picked by Chrome, the endpoint is written only into the 0600 pidfile (never to a
// log), the host exits when no client lease is left for BROWSER_HOST_IDLE_MIN, exits at once on the kill switch, and closes any NEW
// tab while the kill switch or an `all` halt is on (the client runtimes check their own platform halts before they open a tab).
// On first start it imports the old storage-state files (site sessions and the platform state files) into the profile once.
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { launchHostChrome, type HostContext, type HostPage } from '../linkedin/browser.js';
import type { LiLauncher } from '../linkedin/types.js';
import { DEFAULT_PROFILE_DIR, importLegacySessions, prepareProfileDir } from './profile.js';
import { DEFAULT_SITE_SESSION_DIR } from './session.js';
import { importStateOnce, platformStatePath, PLATFORM_PROFILE_NAMES } from './platformProfile.js';
import { acquireLock } from '../linkedin/session.js';
import {
  claimHostFile, DEFAULT_HOST_LEASE_DIR, DEFAULT_HOST_PIDFILE, DEFAULT_HOST_START_LOCK, hostLiveness, liveLeases, removeHostFile,
  writeHostFile, type HostInfo, type HostMode,
} from './hostFile.js';

export interface HostServerDeps {
  mode: HostMode;
  profileDir?: string;
  pidPath?: string;
  leaseDir?: string;
  startLockPath?: string;
  sessionDir?: string;
  /** Secrets directory holding the platform state files (tests). */
  secretsRoot?: string;
  launcher?: LiLauncher;
  /** Test seam for the Chrome launch. */
  launch?: (o: { userDataDir: string; headed: boolean }) => Promise<HostContext>;
  /** Reads <profile>/DevToolsActivePort; test seam. */
  readPortFile?: (profileDir: string) => string | null;
  /** Kill switch: STOP file or JOBBER_KILL. */
  killed: () => boolean;
  /** The `all` halt (or unreadable halt state): refuse new tabs. */
  allHalted: () => boolean;
  idleMs: number;
  heartbeatMs?: number;
  /** Longest wait for Chrome to close at shutdown before the process exits anyway (default 10000). */
  closeTimeoutMs?: number;
  /** Test seam for process.exit. */
  exit?: (code: number) => void;
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Wait for the DevTools port file (ms). */
  portWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface HostHandle {
  /** One heartbeat: kill check, idle check, pidfile refresh. The real host runs it every heartbeatMs. */
  tick(): Promise<void>;
  /** Handover request (an owner command wants the other mode): shuts down only when no client is attached. */
  handover(): Promise<boolean>;
  shutdown(reason: string): Promise<void>;
  /** Resolves when the host has shut down. */
  done: Promise<string>;
  clients(): number;
  tabs(): number;
}

export type StartResult = { ok: true; handle: HostHandle } | { ok: false; code: 'halted' | 'running' | 'profile_refused' | 'chrome_unavailable' | 'no_port' };

export const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';

export function readDevToolsPortFile(profileDir: string): string | null {
  try {
    const [port, wsPath] = readFileSync(path.join(profileDir, DEVTOOLS_PORT_FILE), 'utf8').split('\n').map((s) => s.trim());
    if (!port || !/^\d{2,5}$/.test(port) || !wsPath || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(wsPath)) return null;
    return `ws://127.0.0.1:${port}${wsPath}`;
  } catch { return null; }
}

export async function startHost(deps: HostServerDeps): Promise<StartResult> {
  const pidPath = deps.pidPath ?? DEFAULT_HOST_PIDFILE;
  const leaseDir = deps.leaseDir ?? DEFAULT_HOST_LEASE_DIR;
  const startLock = deps.startLockPath ?? DEFAULT_HOST_START_LOCK;
  const profileDir = deps.profileDir ?? DEFAULT_PROFILE_DIR;
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((l: string) => console.error(`[browser-host] ${l}`));
  const iso = () => new Date(now()).toISOString();

  if (deps.killed()) return { ok: false, code: 'halted' };
  const live = hostLiveness(pidPath, { now, isAlive });
  if (live.kind === 'live' && live.info.pid !== pid) return { ok: false, code: 'running' };
  if (live.kind !== 'none') { try { unlinkSync(pidPath); } catch { /* raced */ } }
  const base: HostInfo = { v: 1, pid, mode: deps.mode, state: 'starting', startedAt: iso(), heartbeatAt: iso(), clients: 0, tabs: 0 };
  if (!claimHostFile(base, pidPath)) return { ok: false, code: 'running' };
  // Heartbeat from the claim on: a slow Chrome launch or profile import must not leave the 'starting' stamp to go stale, or another
  // client would delete the pidfile and start a second host on the same profile.
  let preBeat: ReturnType<typeof setInterval> | null = null;
  if (deps.heartbeatMs && deps.heartbeatMs > 0) {
    preBeat = setInterval(() => { try { writeHostFile({ ...base, heartbeatAt: iso() }, pidPath); } catch { /* next beat */ } }, deps.heartbeatMs);
    preBeat.unref?.();
  }
  const stopPreBeat = (): void => { if (preBeat) { clearInterval(preBeat); preBeat = null; } };

  const prep = prepareProfileDir(profileDir);
  if (!prep.ok) { stopPreBeat(); removeHostFile(pid, pidPath); log('profile refused'); return { ok: false, code: 'profile_refused' }; }
  // A port file left by an earlier Chrome would point at a dead port.
  try { unlinkSync(path.join(profileDir, DEVTOOLS_PORT_FILE)); } catch { /* none */ }

  let ctx: HostContext;
  try {
    ctx = await (deps.launch ?? ((o) => launchHostChrome({ ...o, launcher: deps.launcher })))({ userDataDir: profileDir, headed: deps.mode === 'headed' });
  } catch {
    stopPreBeat();
    removeHostFile(pid, pidPath);
    log('chrome could not be started on the shared profile');
    return { ok: false, code: 'chrome_unavailable' };
  }
  const readPort = deps.readPortFile ?? readDevToolsPortFile;
  let ws: string | null = null;
  const until = now() + (deps.portWaitMs ?? 15000);
  for (;;) {
    ws = readPort(profileDir);
    if (ws || now() >= until) break;
    await sleep(100);
  }
  if (!ws) {
    stopPreBeat();
    await ctx.close().catch(() => undefined);
    removeHostFile(pid, pidPath);
    log('chrome did not open its DevTools port');
    return { ok: false, code: 'no_port' };
  }

  // The old storage-state files, once each (marker files in the profile); the files stay as the fallback.
  try { await importLegacySessions(ctx, profileDir, deps.sessionDir ?? DEFAULT_SITE_SESSION_DIR); } catch { /* never fatal */ }
  for (const name of PLATFORM_PROFILE_NAMES) {
    try { await importStateOnce(ctx, profileDir, platformStatePath(name, deps.secretsRoot), `.platform-state-imported-${name}.json`); } catch { /* never fatal */ }
  }

  stopPreBeat();
  const hostPages = new Set<HostPage>(ctx.pages());
  let closed = false;
  let resolveDone!: (r: string) => void;
  const done = new Promise<string>((r) => { resolveDone = r; });
  let idleSince = now();
  let clients = 0;
  const startedAtMs = Date.parse(base.startedAt);
  // A headed window with no client lease is only left over (an owner command that is gone): it exits after about a minute.
  const idleLimit = deps.mode === 'headed' ? Math.min(deps.idleMs, 60_000) : deps.idleMs;
  let timer: ReturnType<typeof setInterval> | null = null;

  const refuseNew = (): boolean => { try { return deps.killed() || deps.allHalted(); } catch { return true; } };
  ctx.on('page', (p: HostPage) => {
    if (refuseNew()) { void p.close().catch(() => undefined); log('new tab refused (kill switch or halt)'); }
  });
  ctx.on('close', () => { void shutdown('browser closed'); });

  const tabs = (): number => { try { return ctx.pages().filter((p) => !hostPages.has(p) && !p.isClosed()).length; } catch { return 0; } };
  const write = (): void => {
    if (closed) return;
    try { writeHostFile({ ...base, state: 'ready', ws: ws!, heartbeatAt: iso(), clients, tabs: tabs() }, pidPath); } catch { /* next beat */ }
  };

  async function shutdown(reason: string): Promise<void> {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    log(`shutting down (${reason})`);
    // Chrome can hang on close: wait a bounded time, then drop the pidfile and exit so nothing is left half-dead.
    const limit = deps.closeTimeoutMs ?? 10000;
    let timedOut = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ctx.close().catch(() => undefined),
      new Promise<void>((r) => { t = setTimeout(() => { timedOut = true; r(); }, limit); t.unref?.(); }),
    ]);
    if (t) clearTimeout(t);
    removeHostFile(pid, pidPath);
    resolveDone(reason);
    if (timedOut) { log('chrome did not close in time, exiting'); (deps.exit ?? ((c: number) => process.exit(c)))(1); }
  }

  async function tick(): Promise<void> {
    if (closed) return;
    if (deps.killed()) { await shutdown('kill switch'); return; }
    clients = liveLeases(leaseDir, isAlive, startedAtMs);
    if (clients > 0) idleSince = now();
    else if (now() - idleSince >= idleLimit) {
      // The start lock keeps a client from attaching while the host goes away; busy means try again next beat.
      const l = acquireLock(startLock);
      if (l.ok) {
        try { if (liveLeases(leaseDir, isAlive, startedAtMs) === 0) { await shutdown('idle'); return; } } finally { l.handle.release(); }
      }
    }
    write();
  }

  async function handover(): Promise<boolean> {
    if (closed) return true;
    if (liveLeases(leaseDir, isAlive, startedAtMs) > 0) return false;
    await shutdown('handover');
    return true;
  }

  write();
  if (deps.heartbeatMs && deps.heartbeatMs > 0) {
    timer = setInterval(() => { void tick(); }, deps.heartbeatMs);
  }
  log(`ready (${deps.mode})`);
  return { ok: true, handle: { tick, handover, shutdown, done, clients: () => clients, tabs } };
}

/** True when the kill switch is on (STOP file or JOBBER_KILL=1); unreadable STOP path counts as on. */
export function killSwitchOn(stopFile: string, env: NodeJS.ProcessEnv): boolean {
  if (env.JOBBER_KILL === '1') return true;
  try { return existsSync(stopFile); } catch { return true; }
}
