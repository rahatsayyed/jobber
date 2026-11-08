// Shared browser host: pidfile and leases, host start and discovery, stale pidfile, attach failure fallback, tab-only close,
// headed/headless handover, halt and kill refusal. Fakes only: no Chrome is started and no site is opened.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHost, readDevToolsPortFile, type HostHandle } from '../src/webcore/hostServer.js';
import { createHostClient, hostDefaultOn, resolveHost, wrapShared, type HostClientDeps } from '../src/webcore/hostClient.js';
import { cleanStaleHostFile, hostLiveness, hostStatus, liveLeases, readHostFile, writeHostFile, writeLease } from '../src/webcore/hostFile.js';
import { connectChromeOverCDP } from '../src/linkedin/browser.js';
import { openPlatformContext } from '../src/webcore/platformProfile.js';
import { createWebRuntime } from '../src/webcore/runtime.js';
import { openDb } from '../src/db.js';

const WS = 'ws://127.0.0.1:41234/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab';
const HOST_PID = 424242;

interface FakePage { closed: boolean; u: string; close(): Promise<void>; isClosed(): boolean; goto(u: string): Promise<void>; url(): string; waitForTimeout(): Promise<void>; opener(): Promise<unknown>; [k: string]: unknown }
function mkPage(): FakePage {
  const p: FakePage = {
    closed: false, u: 'about:blank',
    async close() { p.closed = true; }, isClosed: () => p.closed,
    async goto(u: string) { p.u = u; }, url: () => p.u, async waitForTimeout() {}, async opener() { return null; },
  };
  return p;
}
function fakeCtx() {
  const pages: FakePage[] = [mkPage()]; // the host's own first tab
  const on: Record<string, Array<(x?: unknown) => void>> = { page: [], close: [] };
  const added: unknown[] = [];
  const ctx = {
    closed: false,
    pages: () => pages.filter((p) => !p.closed),
    on: (ev: string, fn: (x?: unknown) => void) => { on[ev]!.push(fn); },
    async newPage() { const p = mkPage(); pages.push(p); for (const f of on.page!) f(p); return p; },
    async close() { if (ctx.closed) return; ctx.closed = true; for (const p of pages) p.closed = true; for (const f of on.close!) f(); },
    async storageState() { return { cookies: [] }; },
    async waitForEvent() { return ctx.newPage(); },
    async addCookies(c: unknown[]) { added.push(...c); },
  };
  return { ctx, pages, added };
}

let dir: string;
let alive: Set<number>;
const isAlive = (pid: number) => alive.has(pid);
const sleep = () => new Promise<void>((r) => setTimeout(r, 2));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bhost-'));
  mkdirSync(path.join(dir, 'secrets'), { mode: 0o700 });
  alive = new Set([process.pid, HOST_PID]);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const paths = () => ({
  pidPath: path.join(dir, 'secrets', 'browser-host.json'),
  leaseDir: path.join(dir, 'secrets', 'browser-host-clients'),
  startLockPath: path.join(dir, 'secrets', 'browser-host.start.lock'),
});

function hostDeps(fc: ReturnType<typeof fakeCtx>, over: Record<string, unknown> = {}) {
  return {
    mode: 'headless' as const, ...paths(), profileDir: path.join(dir, 'secrets', 'browser-profile'),
    sessionDir: path.join(dir, 'secrets', 'site-sessions'), secretsRoot: path.join(dir, 'secrets'),
    launch: async () => fc.ctx as never, readPortFile: () => WS,
    killed: () => false, allHalted: () => false, idleMs: 60_000, pid: HOST_PID, isAlive, sleep, log: () => undefined,
    ...over,
  };
}

/** A client wired to an in-process fake host: spawnHost starts it, signals reach its handle, connect returns its context. */
function wiredClient(fc: ReturnType<typeof fakeCtx>, handles: HostHandle[], over: Partial<HostClientDeps> = {}) {
  const connects: string[] = [];
  let disconnects = 0;
  const client = createHostClient({
    ...paths(), env: { BROWSER_HOST: 'true' }, stopFile: path.join(dir, 'STOP'), isAlive, sleep,
    readyWaitMs: 2000, exitWaitMs: 300, lockWaitMs: 2000,
    spawnHost: (mode) => { void startHost(hostDeps(fc, { mode })).then((r) => { if (r.ok) handles.push(r.handle); }); },
    signal: (_pid, sig) => { const h = handles[handles.length - 1]!; void (sig === 'SIGUSR1' ? h.handover() : h.shutdown('stop')); },
    connector: { connectOverCDP: async (ws: string) => { connects.push(ws); return { contexts: () => [fc.ctx as never], close: async () => { disconnects++; } }; } },
    ...over,
  });
  return { client, connects, disconnects: () => disconnects };
}

describe('host pidfile and leases', () => {
  it('classifies none, live, stale by dead pid and stale by heartbeat, and cleans only stale ones', () => {
    const { pidPath } = paths();
    expect(hostLiveness(pidPath, { isAlive }).kind).toBe('none');
    const now = Date.now();
    writeHostFile({ v: 1, pid: HOST_PID, mode: 'headless', state: 'ready', startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString(), ws: WS }, pidPath);
    expect(statSync(pidPath).mode & 0o777).toBe(0o600);
    expect(hostLiveness(pidPath, { isAlive }).kind).toBe('live');
    expect(cleanStaleHostFile(pidPath, { isAlive })).toBe(false);
    expect(hostLiveness(pidPath, { isAlive, now: () => now + 3 * 60_000 })).toMatchObject({ kind: 'stale', why: 'heartbeat' });
    alive.delete(HOST_PID);
    expect(hostLiveness(pidPath, { isAlive })).toMatchObject({ kind: 'stale', why: 'dead' });
    expect(hostStatus(pidPath, { isAlive }).stale).toBe(true);
    expect(cleanStaleHostFile(pidPath, { isAlive })).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('refuses a pidfile that is readable by others, and the status line never shows the endpoint', () => {
    const { pidPath } = paths();
    const now = new Date().toISOString();
    writeHostFile({ v: 1, pid: HOST_PID, mode: 'headed', state: 'ready', startedAt: now, heartbeatAt: now, ws: WS, clients: 2, tabs: 3 }, pidPath);
    const s = hostStatus(pidPath, { isAlive });
    expect(s.line).toContain(`pid ${HOST_PID}, headed, ready, 2 clients attached, 3 tabs`);
    expect(s.line).not.toMatch(/ws:|41234|devtools/);
    chmodSync(pidPath, 0o644);
    expect(readHostFile(pidPath)).toBeNull();
  });

  it('counts live leases and removes the leases of dead pids', () => {
    const { leaseDir } = paths();
    writeLease(leaseDir, process.pid);
    const dead = writeLease(leaseDir, 777001);
    expect(liveLeases(leaseDir, isAlive)).toBe(1);
    expect(existsSync(dead)).toBe(false);
  });

  it('reads the DevTools port file Chrome writes, and the connector refuses anything but a loopback endpoint', async () => {
    const prof = path.join(dir, 'p');
    mkdirSync(prof);
    writeFileSync(path.join(prof, 'DevToolsActivePort'), '41234\n/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab\n');
    expect(readDevToolsPortFile(prof)).toBe(WS);
    writeFileSync(path.join(prof, 'DevToolsActivePort'), 'x\ny\n');
    expect(readDevToolsPortFile(prof)).toBeNull();
    const connector = { connectOverCDP: async () => ({ contexts: () => [], close: async () => {} }) };
    await expect(connectChromeOverCDP('ws://10.0.0.5:41234/devtools/browser/abc', { connector })).rejects.toThrow('cdp_endpoint_refused');
    await expect(connectChromeOverCDP(WS, { connector })).resolves.toBeTruthy();
  });
});

describe('host process (startHost)', () => {
  it('starts, writes a ready 0600 pidfile with the endpoint, and imports the old state files once', async () => {
    const fc = fakeCtx();
    writeFileSync(path.join(dir, 'secrets', 'linkedin-main-state.json'), JSON.stringify({ cookies: [{ name: 'li_at', value: 'x', domain: '.linkedin.com' }] }), { mode: 0o600 });
    const r = await startHost(hostDeps(fc));
    expect(r.ok).toBe(true);
    const info = readHostFile(paths().pidPath)!;
    expect(info).toMatchObject({ pid: HOST_PID, mode: 'headless', state: 'ready', ws: WS });
    expect(fc.added).toHaveLength(1);
    if (r.ok) await r.handle.shutdown('test');
    expect(existsSync(paths().pidPath)).toBe(false);
    const fc2 = fakeCtx();
    const r2 = await startHost(hostDeps(fc2));
    expect(fc2.added).toHaveLength(0); // marker: imported once
    if (r2.ok) await r2.handle.shutdown('test');
  });

  it('refuses to start on the kill switch or while another live host runs; takes over a stale pidfile', async () => {
    expect(await startHost(hostDeps(fakeCtx(), { killed: () => true }))).toEqual({ ok: false, code: 'halted' });
    const first = await startHost(hostDeps(fakeCtx()));
    expect(first.ok).toBe(true);
    expect(await startHost(hostDeps(fakeCtx(), { pid: 515151 }))).toEqual({ ok: false, code: 'running' });
    alive.delete(HOST_PID); // the first host died without cleaning up
    const second = await startHost(hostDeps(fakeCtx(), { pid: 515151 }));
    expect(second.ok).toBe(true);
    expect(readHostFile(paths().pidPath)!.pid).toBe(515151);
  });

  it('removes its pidfile when Chrome never opens a DevTools port', async () => {
    const fc = fakeCtx();
    const r = await startHost(hostDeps(fc, { readPortFile: () => null, portWaitMs: 5 }));
    expect(r).toEqual({ ok: false, code: 'no_port' });
    expect(fc.ctx.closed).toBe(true);
    expect(existsSync(paths().pidPath)).toBe(false);
  });

  it('exits after the idle time with no client lease, stays while a client is attached, and exits at once on the kill switch', async () => {
    let t = 1_000_000;
    const fc = fakeCtx();
    const r = await startHost(hostDeps(fc, { now: () => t, idleMs: 1000 }));
    if (!r.ok) throw new Error('start');
    const lease = writeLease(paths().leaseDir, process.pid);
    t += 5000; await r.handle.tick();
    expect(fc.ctx.closed).toBe(false);
    rmSync(lease);
    await r.handle.tick(); // idle starts now
    t += 999; await r.handle.tick();
    expect(fc.ctx.closed).toBe(false);
    t += 2; await r.handle.tick();
    expect(await r.handle.done).toBe('idle');
    expect(existsSync(paths().pidPath)).toBe(false);

    let kill = false;
    const fc2 = fakeCtx();
    const r2 = await startHost(hostDeps(fc2, { killed: () => kill }));
    if (!r2.ok) throw new Error('start');
    kill = true;
    await r2.handle.tick();
    expect(await r2.handle.done).toBe('kill switch');
    expect(fc2.ctx.closed).toBe(true);
  });

  it('closes any new tab while an all halt is on', async () => {
    let halted = false;
    const fc = fakeCtx();
    const r = await startHost(hostDeps(fc, { allHalted: () => halted }));
    if (!r.ok) throw new Error('start');
    const ok = await fc.ctx.newPage();
    halted = true;
    const refused = await fc.ctx.newPage();
    await sleep();
    expect(ok.closed).toBe(false);
    expect(refused.closed).toBe(true);
    await r.handle.shutdown('test');
  });
});

describe('when the shared host is used', () => {
  it('is never the real host under the test runner, nor with a fake launcher or BROWSER_HOST=false; an injected one wins', () => {
    const fake = async () => ({ ok: false as const, code: 'unavailable' as const, reason: '' });
    expect(hostDefaultOn({}, undefined)).toBe(false); // vitest
    expect(resolveHost(undefined, {}, undefined)).toBeNull();
    expect(resolveHost(undefined, { BROWSER_HOST: 'true' }, { launch: async () => ({}) })).toBeNull();
    expect(resolveHost(fake, { BROWSER_HOST: 'false' }, undefined)).toBe(fake);
    expect(resolveHost(null, {}, undefined)).toBeNull();
  });
});

describe('client attach (hostClient)', () => {
  it('starts the host on first use, gives each client its own tab, and closing a client closes only its tab', async () => {
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    const a = wiredClient(fc, handles);
    const r1 = await a.client.attach();
    const r2 = await a.client.attach();
    if (!r1.ok || !r2.ok) throw new Error(`attach: ${JSON.stringify([r1, r2])}`);
    expect(handles).toHaveLength(1); // one host for both
    expect(a.connects).toEqual([WS, WS]);
    const p1 = (await r1.context.newPage()) as unknown as FakePage;
    const p1b = (await r1.context.newPage()) as unknown as FakePage;
    const p2 = (await r2.context.newPage()) as unknown as FakePage;
    expect(liveLeases(paths().leaseDir, isAlive)).toBe(2);
    await r1.browser.close();
    expect(p1.closed && p1b.closed).toBe(true);
    expect(p2.closed).toBe(false);
    expect(fc.ctx.closed).toBe(false); // the browser stays
    expect(a.disconnects()).toBe(1);
    expect(liveLeases(paths().leaseDir, isAlive)).toBe(1);
    await r2.browser.close();
    expect(fc.ctx.closed).toBe(false); // a headless host only goes away when idle
    await handles[0]!.shutdown('test');
  });

  it('closing the context of a client never closes the shared context', async () => {
    const fc = fakeCtx();
    const first = await fc.ctx.newPage();
    const s = wrapShared({ contexts: () => [], close: async () => {} }, fc.ctx as never, first as never, undefined, async () => {});
    const other = await fc.ctx.newPage(); // someone else's tab
    await (s.context as unknown as { close(): Promise<void> }).close();
    expect(first.closed).toBe(true);
    expect(other.closed).toBe(false);
    expect(fc.ctx.closed).toBe(false);
  });

  it('removes a stale pidfile and starts a fresh host', async () => {
    const now = new Date().toISOString();
    writeHostFile({ v: 1, pid: 888001, mode: 'headless', state: 'ready', startedAt: now, heartbeatAt: now, ws: WS }, paths().pidPath);
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    const r = await wiredClient(fc, handles).client.attach();
    expect(r.ok).toBe(true);
    expect(readHostFile(paths().pidPath)!.pid).toBe(HOST_PID);
    if (r.ok) await r.browser.close();
    await handles[0]!.shutdown('test');
  });

  it('reports unavailable when the attach fails, and the platform context then falls back to its own browser', async () => {
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    const a = wiredClient(fc, handles, { connector: { connectOverCDP: async () => { throw new Error('refused'); } } });
    const r = await a.client.attach();
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
    expect(liveLeases(paths().leaseDir, isAlive)).toBe(0);
    await handles[0]!.shutdown('test');

    const launched: unknown[] = [];
    const launcher = { launch: async (o: unknown) => { launched.push(o); return { newContext: async () => fakeCtx().ctx as never, close: async () => {} }; } };
    const state = path.join(dir, 'secrets', 'naukri-state.json');
    writeFileSync(state, JSON.stringify({ cookies: [] }), { mode: 0o600 });
    const pc = await openPlatformContext({ name: 'naukri', statePath: state, launcher: launcher as never, profileDir: path.join(dir, 'none'), host: a.client.attach, hostPidPath: path.join(dir, 'no-such-host.json') });
    expect(pc.ok && pc.shared).toBeFalsy();
    expect(pc.ok).toBe(true);
    expect(launched).toHaveLength(1);

    // A live host pid that does not answer: no second browser on the same profile, session_locked instead.
    const livePid = path.join(dir, 'live-host.json');
    writeFileSync(livePid, JSON.stringify({ v: 1, pid: process.pid, mode: 'headless', at: Date.now() }), { mode: 0o600 });
    const locked = await openPlatformContext({ name: 'naukri', statePath: state, launcher: launcher as never, profileDir: path.join(dir, 'none'), host: a.client.attach, hostPidPath: livePid });
    expect(locked.ok).toBe(false);
    expect(launched).toHaveLength(1);
  });

  it('a platform context on the shared host is a shared tab and keeps the platform lock semantics', async () => {
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    const a = wiredClient(fc, handles);
    const state = path.join(dir, 'secrets', 'naukri-state.json');
    writeFileSync(state, JSON.stringify({ cookies: [] }), { mode: 0o600 });
    const lockPath = path.join(dir, 'secrets', 'naukri-profile.lock');
    const r = await openPlatformContext({ name: 'naukri', statePath: state, profileDir: path.join(dir, 'p'), host: a.client.attach, profileLockPath: lockPath });
    if (!r.ok) throw new Error('open');
    expect(r.shared).toBe(true);
    expect(r.lock).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    await r.browser.close();
    r.lock?.release();
    await handles[0]!.shutdown('test');
  });

  it('refuses on the kill switch without starting anything', async () => {
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    const a = wiredClient(fc, handles, { env: { BROWSER_HOST: 'true', JOBBER_KILL: '1' } });
    expect(await a.client.attach()).toMatchObject({ ok: false, code: 'halted' });
    writeFileSync(path.join(dir, 'STOP'), '');
    const b = wiredClient(fc, handles);
    expect(await b.client.attach()).toMatchObject({ ok: false, code: 'halted' });
    expect(handles).toHaveLength(0);
    expect(await wiredClient(fc, handles, { env: { BROWSER_HOST: 'false' } }).client.attach()).toMatchObject({ ok: false, code: 'disabled' });
  });

  it('hands a headless host over to a window and back: same profile, tasks wait while the owner has the window', async () => {
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    const a = wiredClient(fc, handles);
    const task = await a.client.attach();
    if (!task.ok) throw new Error('attach');
    // A task is attached: the owner window is refused.
    expect(await a.client.attach({ headed: true })).toMatchObject({ ok: false, code: 'busy' });
    await task.browser.close();
    // No client left: the headless host hands over, a headed host starts on the same profile directory.
    const owner = await a.client.attach({ headed: true });
    if (!owner.ok) throw new Error(`headed: ${JSON.stringify(owner)}`);
    expect(await handles[0]!.done).toBe('handover');
    expect(handles).toHaveLength(2);
    expect(readHostFile(paths().pidPath)!.mode).toBe('headed');
    // While the owner has the window, a task gets busy_headed (no second Chrome on the profile).
    expect(await a.client.attach()).toMatchObject({ ok: false, code: 'busy_headed' });
    expect(await a.client.attach({ headed: true })).toMatchObject({ ok: false, code: 'busy' });
    // The owner is done: the headed host stops, and the next task starts a headless one.
    await owner.browser.close();
    expect(await handles[1]!.done).toBe('stop');
    const again = await a.client.attach();
    expect(again).toMatchObject({ ok: true, mode: 'headless' });
    if (again.ok) await again.browser.close();
    await handles[2]!.shutdown('test');
  });
});

describe('owner window request (owner-wait marker)', () => {
  const ownerPath = () => path.join(dir, 'secrets', 'browser-host-owner-wait.json');

  it('waits for the running task, blocks new task attaches meanwhile, then takes the window and removes the marker', async () => {
    alive.add(process.pid);
    alive.add(4242);
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    let t = 1_000_000;
    let ticks = 0;
    const lines: string[] = [];
    const tick = async () => { t += 2000; ticks++; await new Promise<void>((r) => setTimeout(r, 2)); };
    const a = wiredClient(fc, handles, { ownerWaitPath: ownerPath(), now: () => t });
    const task = await a.client.attach();
    if (!task.ok) throw new Error('attach');
    let checked = false;
    const b = wiredClient(fc, handles, {
      ownerWaitPath: ownerPath(), now: () => t,
      sleep: async () => {
        await tick();
        if (ticks === 1 && !checked) {
          checked = true;
          expect(existsSync(ownerPath())).toBe(true);
          expect(statSync(ownerPath()).mode & 0o777).toBe(0o600);
          const other = createHostClient({ ...paths(), env: { BROWSER_HOST: 'true' }, stopFile: path.join(dir, 'STOP'), isAlive, sleep, now: () => t, ownerWaitPath: ownerPath(), spawnHost: () => { throw new Error('must not start'); } });
          const mine = readFileSync(ownerPath(), 'utf8');
          writeFileSync(ownerPath(), JSON.stringify({ pid: 4242, at: t }), { mode: 0o600 });
          expect(await other.attach()).toMatchObject({ ok: false, code: 'busy' });
          writeFileSync(ownerPath(), mine, { mode: 0o600 });
        }
        if (ticks === 3) await task.browser.close();
      },
    });
    const owner = await b.client.attach({ headed: true, waitForTasksMs: 600_000, onWait: (l) => lines.push(l) });
    if (!owner.ok) throw new Error(`headed: ${JSON.stringify(owner)}`);
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(existsSync(ownerPath())).toBe(false);
    expect(owner.mode).toBe('headed');
    await owner.browser.close();
    alive.delete(4242);
  });

  it('gives up after the wait time with the manual fallback, removes the marker and never closes the task client', async () => {
    alive.add(process.pid);
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    let t = 5_000_000;
    const lines: string[] = [];
    const sl = async () => { t += 2000; await new Promise<void>((r) => setTimeout(r, 1)); };
    const a = wiredClient(fc, handles, { ownerWaitPath: ownerPath(), now: () => t, sleep: sl });
    const task = await a.client.attach();
    if (!task.ok) throw new Error('attach');
    const r = await a.client.attach({ headed: true, waitForTasksMs: 40_000, onWait: (l) => lines.push(l) });
    expect(r).toMatchObject({ ok: false, code: 'busy' });
    expect(r.ok === false && r.reason).toMatch(/jobber-stack/);
    expect(lines.some((l) => /waiting for the running task to finish/.test(l))).toBe(true);
    expect(existsSync(ownerPath())).toBe(false);
    expect(liveLeases(paths().leaseDir, isAlive)).toBe(1);
    await task.browser.close();
    await handles[0]!.shutdown('test');
  });

  it('ignores a stale or dead-pid marker', async () => {
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    writeFileSync(ownerPath(), JSON.stringify({ pid: 999999, at: Date.now() }), { mode: 0o600 });
    const a = wiredClient(fc, handles, { ownerWaitPath: ownerPath() });
    const task = await a.client.attach();
    expect(task.ok).toBe(true);
    if (task.ok) await task.browser.close();
    await handles[0]!.shutdown('test');
  });
});

describe('web runtime on the shared host', () => {
  it('opens a shared tab without the web lock, shares the per-host gap by file, and falls back when the host is unavailable', async () => {
    const db = openDb(':memory:');
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    const a = wiredClient(fc, handles);
    const lockPath = path.join(dir, 'secrets', 'webcore.lock');
    const navFile = path.join(dir, 'nav.json');
    const rt = createWebRuntime({ db, host: a.client.attach, lockPath, sessionDir: path.join(dir, 'ss'), profileDir: path.join(dir, 'prof'), navFile, config: { minGapSec: 0, settleMs: 0 } });
    const r = await rt.open('https://jobs.example.com/a', { allowedHosts: ['example.com'], jobId: 'j1' });
    expect(r).toMatchObject({ ok: true });
    expect(existsSync(lockPath)).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(navFile, 'utf8')))).toEqual(['jobs.example.com']);
    // A second runtime (another MCP process) opens its own tab at the same time: no session_locked.
    const rt2 = createWebRuntime({ db, host: a.client.attach, lockPath, sessionDir: path.join(dir, 'ss'), profileDir: path.join(dir, 'prof'), navFile, config: { minGapSec: 0, settleMs: 0 } });
    expect(await rt2.open('https://other.example.org/', { allowedHosts: ['example.org'], jobId: 'j2' })).toMatchObject({ ok: true });
    expect(await rt.close()).toBe(true);
    expect(fc.ctx.closed).toBe(false);
    await rt2.close();
    await handles[0]!.shutdown('test');

    const launched: unknown[] = [];
    const launcher = { launch: async () => { launched.push(1); return { newContext: async () => fakeCtx().ctx as never, close: async () => {} }; } };
    const down = async () => ({ ok: false as const, code: 'unavailable' as const, reason: 'x' });
    const rt3 = createWebRuntime({ db, host: down, launcher: launcher as never, lockPath, sessionDir: path.join(dir, 'ss'), profileDir: null, navFile, config: { minGapSec: 0, settleMs: 0 } });
    expect(await rt3.open('https://jobs.example.com/b', { allowedHosts: ['example.com'], jobId: 'j3' })).toMatchObject({ ok: true });
    expect(launched).toHaveLength(1);
    await rt3.close();
    const busy = async () => ({ ok: false as const, code: 'busy_headed' as const, reason: 'owner window' });
    const rt4 = createWebRuntime({ db, host: busy, launcher: launcher as never, lockPath, sessionDir: path.join(dir, 'ss'), profileDir: path.join(dir, 'prof'), navFile, config: { minGapSec: 0, settleMs: 0 } });
    expect(await rt4.open('https://jobs.example.com/c', { allowedHosts: ['example.com'], jobId: 'j4' })).toMatchObject({ ok: false, code: 'session_locked' });
  });
});

describe('BROWSER_HOST_HEADED debug knob (visible task host)', () => {
  it('reads only the exact value true', async () => {
    const { loadHostConfig } = await import('../src/webcore/config.js');
    expect(loadHostConfig({ BROWSER_HOST_HEADED: 'true' }).headed).toBe(true);
    expect(loadHostConfig({ BROWSER_HOST_HEADED: ' true ' }).headed).toBe(true);
    for (const v of [undefined, '', 'false', '1', 'TRUE', 'yes']) expect(loadHostConfig({ BROWSER_HOST_HEADED: v }).headed).toBe(false);
  });

  it('passes headed to the launcher only when visible (or in the owner headed mode)', async () => {
    const seen: boolean[] = [];
    const run = async (mode: 'headless' | 'headed', visible: boolean | undefined) => {
      const fc = fakeCtx();
      const r = await startHost(hostDeps(fc, { mode, visible, launch: async (o: { headed: boolean }) => { seen.push(o.headed); return fc.ctx as never; } }));
      if (!r.ok) throw new Error(r.code);
      await r.handle.shutdown('test');
    };
    await run('headless', undefined);
    await run('headless', false);
    await run('headless', true);
    await run('headed', undefined);
    expect(seen).toEqual([false, false, true, true]);
  });

  it('a visible task host keeps the headless label and still hands over to the owner window and back', async () => {
    const fc = fakeCtx();
    const handles: HostHandle[] = [];
    const launched: Array<{ mode: string; headed: boolean }> = [];
    const a = wiredClient(fc, handles, {
      spawnHost: (mode) => {
        void startHost(hostDeps(fc, { mode, visible: mode === 'headless', launch: async (o: { headed: boolean }) => { launched.push({ mode, headed: o.headed }); return fc.ctx as never; } }))
          .then((r) => { if (r.ok) handles.push(r.handle); });
      },
    });
    const task = await a.client.attach();
    if (!task.ok) throw new Error('attach');
    expect(task.mode).toBe('headless');
    expect(readHostFile(paths().pidPath)!.mode).toBe('headless');
    await task.browser.close();
    const owner = await a.client.attach({ headed: true });
    if (!owner.ok) throw new Error(`headed: ${JSON.stringify(owner)}`);
    expect(await handles[0]!.done).toBe('handover');
    expect(readHostFile(paths().pidPath)!.mode).toBe('headed');
    await owner.browser.close();
    expect(await handles[1]!.done).toBe('stop');
    const again = await a.client.attach();
    expect(again).toMatchObject({ ok: true, mode: 'headless' });
    if (again.ok) await again.browser.close();
    await handles[2]!.shutdown('test');
    expect(launched).toEqual([{ mode: 'headless', headed: true }, { mode: 'headed', headed: true }, { mode: 'headless', headed: true }]);
  });

  it('a visible host still closes new tabs during a halt', async () => {
    const fc = fakeCtx();
    const r = await startHost(hostDeps(fc, { visible: true, allHalted: () => true }));
    if (!r.ok) throw new Error(r.code);
    const p = await fc.ctx.newPage();
    expect(p.closed).toBe(true);
    await r.handle.shutdown('test');
  });
});
