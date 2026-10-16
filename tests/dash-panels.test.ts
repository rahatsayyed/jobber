// tests/dash-panels.test.ts
import { describe, it, expect } from 'vitest';
import { sessionsPanel } from '../src/dash/sessionsPanel.js';
import { buildConfigView, catalogItem } from '../src/dash/configView.js';
import { FIXTURE_CATALOG, specOf } from './fixtures/settings/catalog.fixture.js';
import type { Run } from '../src/platform/tmux.js';
import type { Snapshot } from '../src/status/snapshot.js';

function fakeRun(windows: string, pane: string, calls: string[][] = []): Run {
  return async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'list-windows') {
      return args[2] === '=ccgram' ? { stdout: windows, code: 0 } : { stdout: '', code: 1 };
    }
    if (args[0] === 'capture-pane') return { stdout: pane, code: 0 };
    return { stdout: '', code: 1 };
  };
}

describe('sessionsPanel', () => {
  it('extracts the last non-empty line, cleaned', async () => {
    const run = fakeRun('0|Main|1|claude\n', 'first\nwork \u001b[0m done\u0007\n\n   \n');
    const r = await sessionsPanel(run, ['ccgram']);
    expect(r[0].up).toBe(true);
    expect(r[0].windows[0]).toMatchObject({ window: 'Main', index: 0, command: 'claude', active: true });
    expect(r[0].windows[0].lastLine).not.toMatch(/[\u0000-\u0008\u000B-\u001F]/);
    expect(r[0].windows[0].lastLine).toContain('done');
  });
  it('redacts secrets in pane output', async () => {
    const run = fakeRun('0|Main|1|claude\n', 'key sk-abcdefghijklmnopqrstuvwxyz0123456789\n');
    const r = await sessionsPanel(run, ['ccgram']);
    expect(r[0].windows[0].lastLine).not.toContain('sk-abcdefghijklmnop');
  });
  it('never passes a hostile window name to tmux', async () => {
    const calls: string[][] = [];
    const run = fakeRun('0|a;b|1|bash\n1|ok|0|bash\n', 'x', calls);
    const r = await sessionsPanel(run, ['ccgram']);
    expect(r[0].windows.map((w) => w.window)).toEqual(['ok']);
    expect(calls.flat().some((a) => a.includes('a;b'))).toBe(false);
  });
  it('reports a missing session as down', async () => {
    const r = await sessionsPanel(fakeRun('', ''), ['ccgram-daemon']);
    expect(r).toEqual([{ session: 'ccgram-daemon', up: false, windows: [] }]);
  });
  it('captures 20 lines by default', async () => {
    const calls: string[][] = [];
    await sessionsPanel(fakeRun('0|Main|1|claude\n', 'x', calls), ['ccgram']);
    expect(calls.find((c) => c[0] === 'capture-pane')).toContain('-20');
  });
});

describe('catalogItem', () => {
  it('masks exactly what isSecret says, shows other values, reports unset', () => {
    expect(catalogItem(specOf('FX_API_KEY'), 'FIXTURE-SECRET-1')).toEqual({ name: 'FX_API_KEY', value: 'set', masked: true });
    expect(catalogItem(specOf('FX_BOT_TOKEN'), undefined)).toEqual({ name: 'FX_BOT_TOKEN', value: 'unset', masked: true });
    expect(catalogItem(specOf('FX_MAX_PER_DAY'), '5')).toEqual({ name: 'FX_MAX_PER_DAY', value: '5', masked: false });
    expect(catalogItem(specOf('FX_MAX_PER_DAY'), '')).toEqual({ name: 'FX_MAX_PER_DAY', value: 'unset', masked: false });
  });
  it('masks a key by its type even when the secret flag is missing', () => {
    expect(catalogItem({ ...specOf('FX_API_KEY'), secret: false }, 'FIXTURE-SECRET-2').masked).toBe(true);
  });
});

describe('buildConfigView', () => {
  const snapshot = { halts: [{ platform: 'x', reason: 'r', setAt: 't' }], ceilings: {} } as unknown as Snapshot;
  it('reads only allowed paths and summarizes', () => {
    const reads: string[] = [];
    const files: Record<string, string> = {
      '.env.example': 'FX_MAX_PER_DAY=60\nFX_API_KEY=\n# comment\nFOO=1\n',
      'config/portals.json': JSON.stringify({ tracked_companies: [1, 2, 3], enabled: true, n: 4, s: 'secretish', o: { a: 1 } }),
    };
    const v = buildConfigView({
      root: 'ROOT',
      env: { FX_MAX_PER_DAY: '70', FX_API_KEY: 'FIXTURE-SECRET-3', FOO: 'bar' },
      read: (p) => {
        reads.push(p);
        return files[p.replace(/^ROOT[\\/]/, '')] ?? null;
      },
      snapshot,
      catalog: FIXTURE_CATALOG,
    });
    expect(reads.length).toBeGreaterThan(0);
    for (const p of reads) expect(p).not.toMatch(/user-data|secrets|\.dashboard|\.env(?!\.example)/);
    expect(v.env.find((e) => e.name === 'FX_MAX_PER_DAY')?.value).toBe('70');
    expect(v.env.find((e) => e.name === 'FX_API_KEY')).toMatchObject({ value: 'set', masked: true });
    expect(v.env.find((e) => e.name === 'FOO')?.value).toBe('set');
    const p = v.files.find((f) => f.path === 'config/portals.json')!;
    expect(p.summary).toMatchObject({ tracked_companies: 3, enabled: true, n: 4 });
    expect(JSON.stringify(p.summary)).not.toContain('secretish');
    expect(v.files.find((f) => f.path === 'config/replies.json')?.summary).toEqual({ missing: true });
    expect(v.halts).toBe(snapshot.halts);
    expect(JSON.stringify(v)).not.toContain('FIXTURE-SECRET');
  });
});

describe('buildConfigView with a catalog', () => {
  const snapshot = { halts: [], ceilings: {} } as unknown as Snapshot;
  const secretKeys = FIXTURE_CATALOG.filter((c) => c.secret || c.type === 'secret').map((c) => c.key);
  it('masks exactly the secret keys, shows other values, lists unknown names by name only', () => {
    const env: Record<string, string> = { FX_PORT: '9000', UNKNOWN_EXAMPLE_NAME: 'FIXTURE-SECRET-9' };
    secretKeys.forEach((k, i) => { env[k] = `FIXTURE-SECRET-${i}`; });
    const v = buildConfigView({
      root: 'ROOT', env, snapshot, catalog: FIXTURE_CATALOG,
      read: (p) => (p.endsWith('.env.example') ? 'UNKNOWN_EXAMPLE_NAME=\nFX_PORT=1\n' : null),
    });
    expect(secretKeys.length).toBeGreaterThan(0);
    expect(v.env.filter((e) => e.masked).map((e) => e.name).sort()).toEqual([...secretKeys].sort());
    expect(v.env.find((e) => e.name === 'FX_PORT')?.value).toBe('9000');
    expect(v.env.find((e) => e.name === 'UNKNOWN_EXAMPLE_NAME')).toEqual({ name: 'UNKNOWN_EXAMPLE_NAME', value: 'set', masked: false });
    expect(JSON.stringify(v)).not.toContain('FIXTURE-SECRET');
  });
});
