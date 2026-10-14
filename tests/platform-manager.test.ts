// tests/platform-manager.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  listManaged,
  loadManagerConfig,
  readWindow,
  restartWindow,
  sessionName,
  startWindow,
  stopWindow,
  SUBCOMMANDS,
  USAGE,
} from '../src/platform/manager.js';
import { redactPane } from '../src/platform/redact.js';
import type { Run } from '../src/platform/tmux.js';

const cfg = loadManagerConfig(readFileSync('config/manager-windows.json', 'utf8'));

function fake(windows: string[] = [], capText = ''): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (_c, args) => {
    calls.push(args);
    if (args[0] === 'list-windows') {
      return { stdout: windows.map((w, i) => `${i}|${w}|${i === 0 ? 1 : 0}|bash`).join('\n'), code: 0 };
    }
    if (args[0] === 'capture-pane') return { stdout: capText, code: 0 };
    return { stdout: '', code: 0 };
  };
  return { run, calls };
}

describe('config and session', () => {
  it('loads the committed config', () => {
    expect(cfg.session).toBe('ccgram');
    expect(Object.keys(cfg.windows)).toEqual(['hunt', 'followups']);
  });
  it('rejects bad argv, flags and protected windows', () => {
    const mk = (w: unknown, p = ['manager']) => JSON.stringify({ session: 's', protected: p, windows: w });
    expect(() => loadManagerConfig(mk({ a: { argv: ['sh', 'x'] } }))).toThrow();
    expect(() => loadManagerConfig(mk({ a: { argv: ['claude', '--dangerously-skip-permissions'] } }))).toThrow();
    expect(() => loadManagerConfig(mk({ manager: { argv: ['bash', 'x'] } }))).toThrow();
    expect(() => loadManagerConfig(mk({ '-bad': { argv: ['bash', 'x'] } }))).toThrow();
  });
  it('session override is validated', () => {
    expect(sessionName(cfg, { MANAGER_TMUX_SESSION: 'other' })).toBe('other');
    expect(() => sessionName(cfg, { MANAGER_TMUX_SESSION: '-x;y' })).toThrow();
    expect(sessionName(cfg, {})).toBe('ccgram');
  });
});

describe('listManaged', () => {
  it('marks managed and protected', async () => {
    const { run } = fake(['manager', 'hunt', 'other']);
    const w = await listManaged(run, cfg, {});
    expect(w.map((x) => [x.name, x.managed, x.protected])).toEqual([
      ['manager', false, true],
      ['hunt', true, false],
      ['other', false, false],
    ]);
  });
});

describe('start, stop, restart', () => {
  it('starts an allowlisted window with a quoted command', async () => {
    const { run, calls } = fake([]);
    expect(await startWindow(run, cfg, {}, 'hunt', '/proj')).toBe('started');
    const nw = calls.find((c) => c[0] === 'new-window')!;
    expect(nw).toEqual(['new-window', '-d', '-t', '=ccgram', '-n', 'hunt', '-c', '/proj', "'bash' 'scripts/ccgram/claude-session.sh'"]);
  });
  it('returns exists without starting', async () => {
    const { run, calls } = fake(['hunt']);
    expect(await startWindow(run, cfg, {}, 'hunt', '/p')).toBe('exists');
    expect(calls.some((c) => c[0] === 'new-window')).toBe(false);
  });
  it('refuses protected, unknown and invalid names before any process call', async () => {
    const { run, calls } = fake(['manager']);
    for (const n of ['manager', 'ccgram-daemon', 'nope', '-x', 'a;b']) {
      await expect(startWindow(run, cfg, {}, n, '/p')).rejects.toThrow();
      await expect(stopWindow(run, cfg, {}, n)).rejects.toThrow();
      await expect(restartWindow(run, cfg, {}, n, '/p')).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
  it('rejects an unsafe argv element', async () => {
    const bad = { ...cfg, windows: { x: { argv: ['bash', 'a b;rm'], description: '' } } };
    const { run, calls } = fake([]);
    await expect(startWindow(run, bad, {}, 'x', '/p')).rejects.toThrow(/unsafe argv/);
    expect(calls).toEqual([]);
  });
  it('stops with kill-window, absent when missing', async () => {
    const a = fake(['hunt']);
    expect(await stopWindow(a.run, cfg, {}, 'hunt')).toBe('stopped');
    expect(a.calls.find((c) => c[0] === 'kill-window')).toEqual(['kill-window', '-t', '=ccgram:=hunt']);
    const b = fake([]);
    expect(await stopWindow(b.run, cfg, {}, 'hunt')).toBe('absent');
  });
  it('restart stops then starts', async () => {
    let present = true;
    const calls: string[] = [];
    const run: Run = async (_c, args) => {
      calls.push(args[0]);
      if (args[0] === 'list-windows') return { stdout: present ? '0|hunt|1|bash' : '', code: 0 };
      if (args[0] === 'kill-window') present = false;
      return { stdout: '', code: 0 };
    };
    expect(await restartWindow(run, cfg, {}, 'hunt', '/p')).toBe('restarted');
    expect(calls.indexOf('kill-window')).toBeLessThan(calls.indexOf('new-window'));
    expect(await restartWindow(fake([]).run, cfg, {}, 'hunt', '/p')).toBe('started');
  });
});

describe('readWindow', () => {
  it('clamps lines and redacts', async () => {
    const { run, calls } = fake(['hunt'], 'ANTHROPIC_AUTH_TOKEN=abc\nhello world');
    const out = await readWindow(run, cfg, {}, 'hunt', 9999);
    expect(out).toBe('[redacted line]\nhello world');
    expect(calls.find((c) => c[0] === 'capture-pane')!.slice(-2)).toEqual(['-S', '-200']);
    await readWindow(run, cfg, {}, 'hunt', 0);
    expect(calls.filter((c) => c[0] === 'capture-pane')[1].slice(-1)).toEqual(['-1']);
  });
  it('can read any window of the session, but validates the name', async () => {
    const { run } = fake([], 'x');
    expect(await readWindow(run, cfg, {}, 'manager')).toBe('x');
    await expect(readWindow(run, cfg, {}, 'a b')).rejects.toThrow();
  });
});

describe('redactPane', () => {
  it.each([
    ['123456789:AAH-abcdefghijklmnopqrstuvwxyz012345'],
    ['key sk-or-v1-abcdef1234567890'],
    ['Authorization header Bearer abc123def456'],
    ['hash 0123456789abcdef0123456789abcdef01234567'],
  ])('masks %s', (input) => {
    const out = redactPane(input);
    expect(out).toContain('[redacted');
    expect(out).not.toMatch(/AAH-abc|abcdef1234567890|abc123def456|0123456789abcdef/);
  });
  it('replaces credential lines and leaves prose', () => {
    expect(redactPane('ANTHROPIC_AUTH_TOKEN=xyz')).toBe('[redacted line]');
    expect(redactPane('Cookie: a=b')).toBe('[redacted line]');
    expect(redactPane('Applied to 3 jobs today.')).toBe('Applied to 3 jobs today.');
  });
});

describe('source constraints and exports', () => {
  it('has no forbidden tmux verbs', () => {
    for (const f of ['src/platform/manager.ts', 'src/platform/redact.ts']) {
      const s = readFileSync(f, 'utf8');
      for (const bad of ['send-keys', 'paste-buffer', 'load-buffer', 'kill-session', 'kill-server', 'sendText']) {
        expect(s.includes(bad), `${f} has ${bad}`).toBe(false);
      }
    }
  });
  it('exports SUBCOMMANDS and USAGE', () => {
    expect([...SUBCOMMANDS]).toEqual(['list', 'read', 'start', 'stop', 'restart', 'status']);
    expect(USAGE).toMatch(/usage/);
  });
});
