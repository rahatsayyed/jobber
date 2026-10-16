// tests/dash-panels.test.ts
import { describe, it, expect } from 'vitest';
import { sessionsPanel } from '../src/dash/sessionsPanel.js';
import { buildConfigView, maskValue } from '../src/dash/configView.js';
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

describe('maskValue', () => {
  it('masks secrets even if allowlisted', () => {
    expect(maskValue('GMAIL_APP_PASSWORD', 'hunter2')).toEqual({ name: 'GMAIL_APP_PASSWORD', value: 'set', masked: true });
    expect(maskValue('TELEGRAM_BOT_TOKEN', undefined)).toEqual({ name: 'TELEGRAM_BOT_TOKEN', value: 'unset', masked: true });
    expect(maskValue('MAX_AUTH_PER_DAY', '3').masked).toBe(true);
  });
  it('shows allowlisted values', () => {
    expect(maskValue('MATCH_THRESHOLD', '60')).toEqual({ name: 'MATCH_THRESHOLD', value: '60', masked: false });
    expect(maskValue('MAX_APPLIES_PER_DAY', '5').value).toBe('5');
    expect(maskValue('NAUKRI_HEADLESS', 'true').value).toBe('true');
  });
  it('shows only set for unknown names', () => {
    expect(maskValue('SOME_UNKNOWN', 'abc')).toEqual({ name: 'SOME_UNKNOWN', value: 'set', masked: false });
    expect(maskValue('SOME_UNKNOWN', '')).toEqual({ name: 'SOME_UNKNOWN', value: 'unset', masked: false });
  });
});

describe('buildConfigView', () => {
  const snapshot = { halts: [{ platform: 'x', reason: 'r', setAt: 't' }], ceilings: {} } as unknown as Snapshot;
  it('reads only allowed paths and summarizes', () => {
    const reads: string[] = [];
    const files: Record<string, string> = {
      '.env.example': 'MATCH_THRESHOLD=60 # c\nGMAIL_APP_PASSWORD=\n# comment\nFOO=1\n',
      'config/portals.json': JSON.stringify({ tracked_companies: [1, 2, 3], enabled: true, n: 4, s: 'secretish', o: { a: 1 } }),
    };
    const v = buildConfigView({
      root: 'ROOT',
      env: { MATCH_THRESHOLD: '70', GMAIL_APP_PASSWORD: 'pw', FOO: 'bar' },
      read: (p) => {
        reads.push(p);
        return files[p.replace(/^ROOT[\\/]/, '')] ?? null;
      },
      snapshot,
    });
    expect(reads.length).toBeGreaterThan(0);
    for (const p of reads) expect(p).not.toMatch(/user-data|secrets|\.dashboard|\.env(?!\.example)/);
    expect(v.env.find((e) => e.name === 'MATCH_THRESHOLD')?.value).toBe('70');
    expect(v.env.find((e) => e.name === 'GMAIL_APP_PASSWORD')).toMatchObject({ value: 'set', masked: true });
    expect(v.env.find((e) => e.name === 'FOO')?.value).toBe('set');
    const p = v.files.find((f) => f.path === 'config/portals.json')!;
    expect(p.summary).toMatchObject({ tracked_companies: 3, enabled: true, n: 4 });
    expect(JSON.stringify(p.summary)).not.toContain('secretish');
    expect(v.files.find((f) => f.path === 'config/replies.json')?.summary).toEqual({ missing: true });
    expect(v.halts).toBe(snapshot.halts);
    expect(JSON.stringify(v)).not.toContain('"pw"');
  });
});
