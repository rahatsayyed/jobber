// Client side of the shared browser host: an MCP process (LinkedIn, Naukri, Wellfound, scout, applier, sources runner, contacts
// dork) or an owner command attaches to the ONE host Chrome over CDP and gets its OWN TAB in the shared profile. The returned
// LiBrowser's close() closes only the tabs this client opened (and their popups), removes the client lease and disconnects; it never
// closes the host's browser. Only the runtimes listed in tests/browser-launch-lint.test.ts may import this file.
//
// attach(): kill switch -> start lock -> live pidfile? (stale ones are removed) -> mode check -> start the host when none runs ->
// connect -> first tab -> lease -> unlock. Headed (owner) and headless (tasks) use the same profile, so cookies and history stay in
// sync: an owner command asks a headless host with no clients to hand over (it exits), starts the host headed, and stops it again
// when done; while the host is headed, task clients get `busy_headed` (the owner has the window), exactly like the old web lock.
// Any other failure is `unavailable` and the caller falls back to its own browser (the old behaviour).
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectChromeOverCDP, type CdpBrowser, type CdpConnector } from '../linkedin/browser.js';
import type { LiBrowser, LiContext, LiPage } from '../linkedin/types.js';
import { acquireLock, type LockHandle } from '../linkedin/session.js';
import { loadHostConfig } from './config.js';
import {
  DEFAULT_HOST_LEASE_DIR, DEFAULT_HOST_PIDFILE, DEFAULT_HOST_START_LOCK, hostLiveness, pidAlive, removeLease, writeLease, type HostMode,
} from './hostFile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HOST_SCRIPT = path.join(ROOT, 'scripts', 'browser-host.ts');
const STOP_FILE = path.join(ROOT, '.jobber', 'STOP');

export type HostAttachCode = 'disabled' | 'unavailable' | 'halted' | 'busy' | 'busy_headed';
export type HostAttachResult =
  | { ok: true; browser: LiBrowser; context: LiContext; mode: HostMode }
  | { ok: false; code: HostAttachCode; reason: string };

export interface AttachOpts {
  headed?: boolean;
  /** Fingerprint options applied to each tab where the page allows it (viewport, user agent, locale, timezone). */
  contextOptions?: Record<string, unknown>;
}
export type HostAttach = (opts?: AttachOpts) => Promise<HostAttachResult>;

export interface HostClientDeps {
  env?: NodeJS.ProcessEnv;
  pidPath?: string;
  leaseDir?: string;
  startLockPath?: string;
  stopFile?: string;
  connector?: CdpConnector;
  /** Starts the host process in the given mode (default: a detached `node --import tsx scripts/browser-host.ts run`). */
  spawnHost?: (mode: HostMode) => void;
  /** Sends a signal to the host pid (default process.kill). */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a started host to be ready, and for a stopped one to exit. */
  readyWaitMs?: number;
  exitWaitMs?: number;
  lockWaitMs?: number;
}

const killed = (stopFile: string, env: NodeJS.ProcessEnv): boolean => {
  if (env.JOBBER_KILL === '1') return true;
  try { return existsSync(stopFile); } catch { return true; }
};

function defaultSpawn(mode: HostMode, env: NodeJS.ProcessEnv): void {
  const logDir = path.join(ROOT, '.jobber');
  mkdirSync(logDir, { recursive: true });
  const out = openSync(path.join(logDir, 'browser-host.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', HOST_SCRIPT, 'run', '--mode', mode], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out], env,
  });
  child.unref();
  try { closeSync(out); } catch { /* the child keeps its own copy */ }
}

async function waitLock(p: string, ms: number, sleep: (ms: number) => Promise<void>, now: () => number): Promise<LockHandle | null> {
  const until = now() + ms;
  for (;;) {
    const l = acquireLock(p);
    if (l.ok) return l.handle;
    if (now() >= until) return null;
    await sleep(100);
  }
}

/** True when the shared host may be used by default: enabled, the real launcher (no test fake), not under vitest, not Windows. */
export function hostDefaultOn(env: NodeJS.ProcessEnv, launcher: unknown): boolean {
  // Under the test runner the real host is never started, whatever env object a test passes.
  return loadHostConfig(env).enabled && launcher === undefined && env.VITEST !== 'true' && process.env.VITEST !== 'true' && process.platform !== 'win32';
}

/** The attach function a runtime uses: an injected one (tests), else the real one when hostDefaultOn, else null (old behaviour). */
export function resolveHost(injected: HostAttach | null | undefined, env: NodeJS.ProcessEnv, launcher: unknown): HostAttach | null {
  if (injected !== undefined) return injected;
  return hostDefaultOn(env, launcher) ? createHostClient({ env }).attach : null;
}

export interface HostClient {
  attach: HostAttach;
  /** Stops the running host (SIGTERM) and waits for it to exit. True when none is left. */
  stop(): Promise<boolean>;
}

export function createHostClient(deps: HostClientDeps = {}): HostClient {
  const env = deps.env ?? process.env;
  const pidPath = deps.pidPath ?? DEFAULT_HOST_PIDFILE;
  const leaseDir = deps.leaseDir ?? DEFAULT_HOST_LEASE_DIR;
  const startLock = deps.startLockPath ?? DEFAULT_HOST_START_LOCK;
  const stopFile = deps.stopFile ?? STOP_FILE;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isAlive = deps.isAlive ?? pidAlive;
  const signal = deps.signal ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); });
  const spawnHost = deps.spawnHost ?? ((mode: HostMode) => defaultSpawn(mode, env));
  const readyWaitMs = deps.readyWaitMs ?? 30000;
  const exitWaitMs = deps.exitWaitMs ?? 15000;
  const lockWaitMs = deps.lockWaitMs ?? 40000;
  const fail = (code: HostAttachCode, reason: string): HostAttachResult => ({ ok: false, code, reason });

  const live = () => hostLiveness(pidPath, { now, isAlive });

  async function waitExit(pid: number): Promise<boolean> {
    const until = now() + exitWaitMs;
    while (isAlive(pid) && live().kind === 'live') {
      if (now() >= until) return false;
      await sleep(100);
    }
    return true;
  }

  async function stopPid(pid: number, sig: NodeJS.Signals): Promise<boolean> {
    try { signal(pid, sig); } catch { return !isAlive(pid); }
    return waitExit(pid);
  }

  async function waitReady(): Promise<{ pid: number; ws: string; mode: HostMode } | null> {
    const until = now() + readyWaitMs;
    for (;;) {
      const l = live();
      if (l.kind === 'live' && l.info.state === 'ready' && l.info.ws) return { pid: l.info.pid, ws: l.info.ws, mode: l.info.mode };
      if (now() >= until) return null;
      await sleep(150);
    }
  }

  async function attach(opts: AttachOpts = {}): Promise<HostAttachResult> {
    if (!loadHostConfig(env).enabled) return fail('disabled', 'the shared browser host is off (BROWSER_HOST=false)');
    if (killed(stopFile, env)) return fail('halted', 'kill switch is on');
    const want: HostMode = opts.headed ? 'headed' : 'headless';
    const lock = await waitLock(startLock, lockWaitMs, sleep, now);
    if (!lock) return fail('unavailable', 'the shared browser host is starting elsewhere');
    let lease: string | null = null;
    let cdp: CdpBrowser | null = null;
    let first: PageLike | null = null;
    try {
      let l = live();
      if (l.kind === 'stale') {
        // A stale pidfile: the host died (or hung). A hung but alive host is killed first, so it cannot keep the profile lock.
        if (l.why === 'heartbeat' && l.pid > 0 && isAlive(l.pid)) { try { signal(l.pid, 'SIGKILL'); } catch { /* gone */ } }
        try { unlinkSync(pidPath); } catch { /* raced */ }
        l = { kind: 'none' };
      }
      if (l.kind === 'live' && l.info.mode !== want) {
        if (want === 'headless') return fail('busy_headed', 'the owner has the shared browser open in a window; try again when that command is done');
        // The owner wants a window: a headless host with no clients hands over (exits); one with clients is busy.
        if ((l.info.clients ?? 0) > 0) return fail('busy', 'the shared browser is in use by a running task; try again in a few minutes');
        try { signal(l.info.pid, 'SIGUSR1'); } catch { /* gone */ }
        if (!(await waitExit(l.info.pid))) return fail('busy', 'the shared browser is in use by a running task; try again in a few minutes');
        l = { kind: 'none' };
      } else if (l.kind === 'live' && want === 'headed') {
        return fail('busy', 'another owner command has the shared browser window open');
      }
      let ready: { pid: number; ws: string; mode: HostMode } | null = null;
      if (l.kind === 'live') ready = await waitReady();
      else {
        try { spawnHost(want); } catch { return fail('unavailable', 'could not start the shared browser host'); }
        ready = await waitReady();
      }
      if (!ready || ready.mode !== want) return fail('unavailable', 'the shared browser host did not become ready');
      try { cdp = await connectChromeOverCDP(ready.ws, { connector: deps.connector }); } catch { return fail('unavailable', 'could not attach to the shared browser host'); }
      const ctx = cdp.contexts()[0];
      if (!ctx) { await cdp.close().catch(() => undefined); cdp = null; return fail('unavailable', 'the shared browser has no profile context'); }
      // The first tab is opened under the start lock, so the host cannot go idle between attach and the first page.
      first = (await ctx.newPage()) as PageLike;
      if (killed(stopFile, env)) { await first.close?.().catch(() => undefined); await cdp.close().catch(() => undefined); cdp = null; return fail('halted', 'kill switch is on'); }
      lease = writeLease(leaseDir);
      const shared = wrapShared(cdp, ctx, first, opts.contextOptions, async () => {
        if (lease) removeLease(lease);
        if (want === 'headed') await stopPid(ready!.pid, 'SIGTERM');
      });
      cdp = null;
      return { ok: true, browser: shared.browser, context: shared.context, mode: want };
    } catch {
      if (lease) removeLease(lease);
      if (first) await first.close?.().catch(() => undefined);
      if (cdp) await cdp.close().catch(() => undefined);
      return fail('unavailable', 'could not attach to the shared browser host');
    } finally {
      lock.release();
    }
  }

  async function stop(): Promise<boolean> {
    const l = live();
    if (l.kind !== 'live') return true;
    if (await stopPid(l.info.pid, 'SIGTERM')) return true;
    // SIGTERM did not end it (a hung Chrome): SIGKILL and drop the pidfile.
    const gone = await stopPid(l.info.pid, 'SIGKILL');
    if (gone || !isAlive(l.info.pid)) { try { unlinkSync(pidPath); } catch { /* gone */ } return true; }
    return false;
  }

  return { attach, stop };
}

type PageLike = LiPage & { close?: () => Promise<void>; isClosed?: () => boolean; opener?: () => Promise<unknown>; setViewportSize?: (v: unknown) => Promise<void> };
type CtxLike = LiContext & { pages?: () => PageLike[]; newCDPSession?: (p: unknown) => Promise<{ send(m: string, p?: unknown): Promise<unknown>; detach?(): Promise<void> }> };

/** Viewport, user agent, locale and timezone on one tab, best effort (the host context already carries the same options). */
async function applyFingerprint(ctx: CtxLike, page: PageLike, o: Record<string, unknown> | undefined): Promise<void> {
  if (!o) return;
  const vp = o.viewport as { width: number; height: number } | undefined;
  if (vp && typeof page.setViewportSize === 'function') await page.setViewportSize(vp).catch(() => undefined);
  if (typeof ctx.newCDPSession !== 'function') return;
  try {
    const s = await ctx.newCDPSession(page);
    if (typeof o.userAgent === 'string') await s.send('Emulation.setUserAgentOverride', { userAgent: o.userAgent, ...(typeof o.locale === 'string' ? { acceptLanguage: o.locale } : {}) }).catch(() => undefined);
    if (typeof o.locale === 'string') await s.send('Emulation.setLocaleOverride', { locale: o.locale }).catch(() => undefined);
    if (typeof o.timezoneId === 'string') await s.send('Emulation.setTimezoneOverride', { timezoneId: o.timezoneId }).catch(() => undefined);
  } catch { /* best effort */ }
}

/**
 * The shared context as this client sees it: newPage() and waitForEvent('page') track the tabs, close() closes only those (and any
 * popup they opened). Every other property passes through to the real context.
 */
export function wrapShared(cdp: CdpBrowser, ctx: LiContext, first: LiPage | null, contextOptions: Record<string, unknown> | undefined, onClose: () => Promise<void>): { browser: LiBrowser; context: LiContext } {
  const c = ctx as CtxLike;
  const mine = new Set<PageLike>();
  let pending: PageLike | null = first as PageLike | null;
  let closed = false;
  const track = async (p: PageLike): Promise<PageLike> => { mine.add(p); await applyFingerprint(c, p, contextOptions); return p; };
  if (pending) mine.add(pending);
  let firstApplied = false;

  const closeTabs = async (): Promise<void> => {
    const all = typeof c.pages === 'function' ? c.pages() : [];
    for (const p of all) {
      if (mine.has(p)) continue;
      try { const op = typeof p.opener === 'function' ? await p.opener() : null; if (op && mine.has(op as PageLike)) mine.add(p); } catch { /* ignore */ }
    }
    for (const p of mine) { try { if (!p.isClosed?.()) await p.close?.(); } catch { /* already gone */ } }
    mine.clear();
  };

  const context = new Proxy(ctx as object, {
    get(target, prop, recv) {
      if (prop === 'newPage') {
        return async () => {
          if (closed) throw new Error('shared tab closed');
          if (pending) {
            const p = pending; pending = null;
            if (!firstApplied) { firstApplied = true; await applyFingerprint(c, p, contextOptions); }
            return p;
          }
          return track((await ctx.newPage()) as PageLike);
        };
      }
      if (prop === 'waitForEvent') {
        return async (name: 'page', o?: { timeout?: number }) => track((await ctx.waitForEvent(name, o)) as PageLike);
      }
      if (prop === 'close') return async () => { await closeTabs(); };
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as LiContext;

  const browser: LiBrowser = {
    newContext: async () => context,
    close: async () => {
      if (closed) return;
      closed = true;
      if (pending) { mine.add(pending); pending = null; }
      await closeTabs();
      await cdp.close().catch(() => undefined);
      await onClose().catch(() => undefined);
    },
  };
  return { browser, context };
}
