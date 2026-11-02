// Shared browser host hardening: heartbeat during a slow start, bounded shutdown, no second open of a held profile, lease start check,
// hung-host kill. Fakes only: no Chrome is started and no site is opened.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHost } from '../src/webcore/hostServer.js';
import { createHostClient } from '../src/webcore/hostClient.js';
import { hostProcessExists, liveLeases, readHostFile, writeHostFile, writeLease } from '../src/webcore/hostFile.js';
import { openPlatformContext } from '../src/webcore/platformProfile.js';

const WS = 'ws://127.0.0.1:41234/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab';
const HOST_PID = 424242;
let dir: string;
const pidPath = () => path.join(dir, 'secrets', 'browser-host.json');
const leaseDir = () => path.join(dir, 'secrets', 'browser-host-clients');
const alive = new Set<number>();
const isAlive = (pid: number) => alive.has(pid);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bhost-hard-'));
  mkdirSync(path.join(dir, 'secrets'), { mode: 0o700 });
  alive.clear(); alive.add(process.pid); alive.add(HOST_PID);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function ctxWith(close: () => Promise<void>) {
  return { pages: () => [], on: () => undefined, close, storageState: async () => ({ cookies: [] }), addCookies: async () => undefined };
}
const baseDeps = (over: Record<string, unknown>) => ({
  mode: 'headless' as const, pidPath: pidPath(), leaseDir: leaseDir(), startLockPath: path.join(dir, 'secrets', 'host.lock'),
  profileDir: path.join(dir, 'secrets', 'browser-profile'), sessionDir: path.join(dir, 'secrets', 'sessions'), secretsRoot: path.join(dir, 'secrets'),
  readPortFile: () => WS, killed: () => false, allHalted: () => false, idleMs: 60_000, pid: HOST_PID, isAlive, log: () => undefined, ...over,
});

describe('host heartbeat and shutdown', () => {
  it('keeps the heartbeat fresh while Chrome is still launching', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = startHost(baseDeps({
      heartbeatMs: 20,
      launch: async () => { await gate; return ctxWith(async () => undefined) as never; },
    }) as never);
    await new Promise((r) => setTimeout(r, 30));
    const first = readHostFile(pidPath())!;
    expect(first.state).toBe('starting');
    await new Promise((r) => setTimeout(r, 80));
    const later = readHostFile(pidPath())!;
    expect(Date.parse(later.heartbeatAt)).toBeGreaterThan(Date.parse(first.heartbeatAt));
    release();
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) await r.handle.shutdown('test');
  });

  it('exits after a bounded wait when Chrome never finishes closing, and removes the pidfile', async () => {
    let exitCode: number | null = null;
    const r = await startHost(baseDeps({
      closeTimeoutMs: 30, exit: (c: number) => { exitCode = c; },
      launch: async () => ctxWith(() => new Promise<void>(() => undefined)) as never,
    }) as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.handle.shutdown('test');
    expect(exitCode).toBe(1);
    expect(existsSync(pidPath())).toBe(false);
  });
});

describe('leases and process checks', () => {
  it('ignores a lease written before the host started (a reused pid)', () => {
    writeLease(leaseDir(), process.pid, new Date('2026-01-01T00:00:00Z'));
    expect(liveLeases(leaseDir(), isAlive)).toBe(1);
    expect(liveLeases(leaseDir(), isAlive, Date.parse('2026-06-01T00:00:00Z'))).toBe(0);
    expect(liveLeases(leaseDir(), isAlive)).toBe(0);
  });

  it('hostProcessExists is true for an alive pid even with a stale heartbeat', () => {
    expect(hostProcessExists(pidPath(), isAlive)).toBe(false);
    writeHostFile({ v: 1, pid: HOST_PID, mode: 'headless', state: 'starting', startedAt: '2020-01-01T00:00:00Z', heartbeatAt: '2020-01-01T00:00:00Z' }, pidPath());
    expect(hostProcessExists(pidPath(), isAlive)).toBe(true);
    alive.delete(HOST_PID);
    expect(hostProcessExists(pidPath(), isAlive)).toBe(false);
  });
});

describe('client against a hung host', () => {
  it('kills a stale-but-alive host before it spawns another', async () => {
    writeHostFile({ v: 1, pid: HOST_PID, mode: 'headless', state: 'starting', startedAt: '2020-01-01T00:00:00Z', heartbeatAt: '2020-01-01T00:00:00Z' }, pidPath());
    const signals: string[] = [];
    let spawned = 0;
    const client = createHostClient({
      pidPath: pidPath(), leaseDir: leaseDir(), startLockPath: path.join(dir, 'secrets', 'start.lock'), env: { BROWSER_HOST: 'true' },
      stopFile: path.join(dir, 'STOP'), isAlive, sleep: async () => undefined, readyWaitMs: 5, exitWaitMs: 5, lockWaitMs: 500,
      signal: (pid, sig) => { signals.push(`${pid}:${sig}`); alive.delete(pid); },
      spawnHost: () => { spawned++; },
    });
    const r = await client.attach();
    expect(signals).toContain(`${HOST_PID}:SIGKILL`);
    expect(spawned).toBe(1);
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('stop falls back to SIGKILL when SIGTERM does not end the host', async () => {
    writeHostFile({ v: 1, pid: HOST_PID, mode: 'headless', state: 'ready', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), ws: WS }, pidPath());
    const signals: string[] = [];
    const client = createHostClient({
      pidPath: pidPath(), leaseDir: leaseDir(), env: { BROWSER_HOST: 'true' }, stopFile: path.join(dir, 'STOP'),
      isAlive, sleep: async () => undefined, exitWaitMs: 0,
      signal: (pid, sig) => { signals.push(sig); if (sig === 'SIGKILL') alive.delete(pid); },
    });
    expect(await client.stop()).toBe(true);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(existsSync(pidPath())).toBe(false);
  });
});

describe('platform context with a host process that does not answer', () => {
  it('returns session_locked instead of opening the same profile a second time', async () => {
    writeHostFile({ v: 1, pid: process.pid, mode: 'headless', state: 'starting', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }, pidPath());
    const profile = path.join(dir, 'secrets', 'browser-profile');
    mkdirSync(profile, { recursive: true });
    let launched = 0;
    const launcher = { launch: async () => { launched++; return { newContext: async () => ctxWith(async () => undefined) as never, close: async () => undefined }; } };
    const state = path.join(dir, 'secrets', 'naukri-state.json');
    writeFileSync(state, JSON.stringify({ cookies: [] }), { mode: 0o600 });
    const r = await openPlatformContext({
      name: 'naukri', statePath: state, launcher: launcher as never, profileDir: profile, hostPidPath: pidPath(),
      host: async () => ({ ok: false, code: 'unavailable', reason: 'x' }),
    });
    expect(r).toMatchObject({ ok: false, code: 'session_locked' });
    expect(launched).toBe(0);
  });
});
