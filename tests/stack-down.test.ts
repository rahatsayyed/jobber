// tests/stack-down.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../src/platform/tmux.js';
import { runDown, waitSeconds, type DownDeps, type DownOpts } from '../src/stack/down.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stack-down-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, '.jobber'));
  // Fixture config with two arbitrary managed windows: the committed config has none, the loop is generic.
  const w = (d: string) => ({ argv: ['bash', 'scripts/claude-session.sh'], description: d });
  writeFileSync(
    join(root, 'config', 'manager-windows.json'),
    JSON.stringify({ session: 'Jobber', protected: ['manager', 'bridge', 'chat'], windows: { hunt: w('a'), followups: w('b') } }),
  );
  writeFileSync(join(root, '.jobber', 'STOP'), 'x');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Fake { run: Run; calls: string[][]; sessions: Map<string, string[]> }

function fake(opts: { sessions: Record<string, string[]>; exitOnCtrlC?: boolean; launchd?: boolean }): Fake {
  const sessions = new Map<string, string[]>(Object.entries(opts.sessions));
  const calls: string[][] = [];
  const parse = (t: string): { s: string; w: string } => {
    const m = /^=?([^:]*)(?::=?(.*))?$/.exec(t);
    return { s: m?.[1] ?? '', w: m?.[2] ?? '' };
  };
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'launchctl') return { stdout: opts.launchd ? '1\t0\tdev.jobber.scheduler\n' : '', code: 0 };
    if (cmd === 'systemctl') return { stdout: 'inactive', code: 3 };
    if (cmd !== 'tmux') return { stdout: '', code: 0 };
    const t = args[args.indexOf('-t') + 1] ?? '';
    const { s, w } = parse(t);
    switch (args[0]) {
      case 'has-session': return { stdout: '', code: sessions.has(s) ? 0 : 1 };
      case 'list-windows': {
        const ws = sessions.get(s);
        if (!ws) return { stdout: '', code: 1 };
        return { stdout: ws.map((n, i) => `${i}|${n}|0|bash`).join('\n'), code: 0 };
      }
      case 'send-keys': {
        if (opts.exitOnCtrlC) {
          const ws = sessions.get(s);
          if (ws) sessions.set(s, ws.filter((n) => n !== w));
        }
        return { stdout: '', code: 0 };
      }
      case 'kill-window': {
        const ws = sessions.get(s);
        if (ws) sessions.set(s, ws.filter((n) => n !== w));
        return { stdout: '', code: 0 };
      }
      default: return { stdout: '', code: 0 };
    }
  };
  return { run, calls, sessions };
}

function mk(f: Fake, over: Partial<DownDeps> = {}, env: NodeJS.ProcessEnv = {}): DownDeps & { out: string[]; slept: number } {
  const out: string[] = [];
  const d = {
    root,
    env: { HOME: '/home/x', PATH: '/usr/bin', ...env },
    run: f.run,
    fs: { exists: (p: string) => existsSync(p), read: (p: string) => readFileSync(p, 'utf8') },
    now: () => new Date('2026-10-15T00:00:00Z'),
    doctor: async () => [],
    say: (l: string) => void out.push(l),
    sleep: async () => {
      d.slept += 1;
    },
    probe: async () => true,
    isTTY: false,
    ask: async () => false,
    out,
    slept: 0,
    ...over,
  };
  return d as DownDeps & { out: string[]; slept: number };
}

const full = (): Record<string, string[]> => ({
  Jobber: ['bridge', 'scheduler', 'web', 'hunt', 'followups', 'manager'],
});
const OPTS: DownOpts = { keepBridge: false, force: false, verbose: true };
const kills = (f: Fake): string[] => f.calls.filter((c) => c[0] === 'tmux' && c[1] === 'kill-window').map((c) => c[c.length - 1]);

describe('down', () => {
  it('stops in order web, scheduler, the windows in reverse config order, bridge, then manager (nothing left, session ended)', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    expect(await runDown(mk(f), OPTS)).toBe(0);
    const order = f.calls
      .filter((c) => c[0] === 'tmux' && (c[1] === 'kill-window' || c[1] === 'send-keys'))
      .map((c) => c[c.length - (c[1] === 'send-keys' ? 2 : 1)].replace(/^=.*:=?/, ''));
    expect(order).toEqual(['web', 'scheduler', 'followups', 'hunt', 'bridge', 'manager']);
    expect(f.sessions.get('Jobber')).toEqual([]);
    expect(f.calls.some((c) => c[1] === 'kill-session' && c.includes('=Jobber'))).toBe(true);
  });

  it('scheduler gets C-c and is not killed when it stays; message printed', async () => {
    const f = fake({ sessions: full() });
    const d = mk(f, {}, { STACK_DOWN_WAIT_SEC: '7' });
    await runDown(d, OPTS);
    expect(f.calls.some((c) => c[1] === 'send-keys' && c.includes('C-c') && c.includes('=Jobber:=scheduler'))).toBe(true);
    expect(kills(f)).not.toContain('=Jobber:=scheduler');
    expect(d.slept).toBe(7);
    expect(d.out.join('\n')).toContain('scheduler is finishing a wake; run npm run down again, or npm run down -- --force');
  });

  it('wait is read from STACK_DOWN_WAIT_SEC and clamped', () => {
    expect(waitSeconds({})).toBe(60);
    expect(waitSeconds({ STACK_DOWN_WAIT_SEC: '1' })).toBe(5);
    expect(waitSeconds({ STACK_DOWN_WAIT_SEC: '9999' })).toBe(600);
    expect(waitSeconds({ STACK_DOWN_WAIT_SEC: 'abc' })).toBe(60);
    expect(waitSeconds({ STACK_DOWN_WAIT_SEC: '30' })).toBe(30);
  });

  it('--force kills the scheduler window', async () => {
    const f = fake({ sessions: full() });
    await runDown(mk(f), { ...OPTS, force: true });
    expect(kills(f)).toContain('=Jobber:=scheduler');
    expect(f.sessions.get('Jobber')).toEqual([]);
  });

  it('--keep-bridge skips the bridge', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    await runDown(mk(f), { ...OPTS, keepBridge: true });
    expect(kills(f)).not.toContain('=Jobber:=bridge');
    expect(f.sessions.get('Jobber')).toContain('bridge');
  });

  it('is idempotent: a second down records zero kills and reports absent', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    await runDown(mk(f), OPTS);
    f.calls.length = 0;
    const d = mk(f);
    expect(await runDown(d, OPTS)).toBe(0);
    expect(kills(f)).toEqual([]);
    expect(f.calls.some((c) => c[1] === 'send-keys')).toBe(false);
    expect(d.out.filter((l) => l.endsWith('absent')).length).toBeGreaterThanOrEqual(5);
  });

  it('never asks: stops every worker window without --yes or a terminal', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    const d = mk(f, { ask: async () => { throw new Error('must not ask'); } });
    await runDown(d, { keepBridge: false, force: false });
    expect(f.sessions.get('Jobber')).toEqual([]);
  });

  it('prints one summary line by default and no per-component lines', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    const d = mk(f);
    await runDown(d, { keepBridge: false, force: false });
    expect(d.out).toEqual(['Jobber stopped: web, scheduler, followups, hunt, bridge, manager.']);
  });

  it('--keep-windows stops only the daemons', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    const d = mk(f);
    await runDown(d, { ...OPTS, keepWindows: true });
    expect(f.sessions.get('Jobber')).toEqual(['hunt', 'followups', 'manager']);
    expect(d.out[d.out.length - 1]).toBe('Jobber stopped: web, scheduler, bridge. Left running: followups, hunt, manager.');
  });

  it('--keep-protected keeps manager and chat; everything else stops and the summary says so', async () => {
    const f = fake({ sessions: { Jobber: [...full().Jobber, 'chat'] }, exitOnCtrlC: true });
    const d = mk(f);
    await runDown(d, { ...OPTS, keepProtected: true });
    expect(f.sessions.get('Jobber')).toEqual(['manager', 'chat']);
    expect(f.calls.some((c) => c[1] === 'kill-session')).toBe(false);
    expect(d.out[d.out.length - 1]).toBe('Jobber stopped: web, scheduler, followups, hunt, bridge. Left running: chat, manager.');
  });

  it('stops chat and manager by default and names every stopped component in one line', async () => {
    const f = fake({ sessions: { Jobber: [...full().Jobber, 'chat'] }, exitOnCtrlC: true });
    const d = mk(f);
    await runDown(d, OPTS);
    expect(d.out[d.out.length - 1]).toBe('Jobber stopped: web, scheduler, followups, hunt, bridge, chat, manager.');
  });

  it('a window mid-item gets Escape then the exit command, and its unfinished item lands in the handoff file', async () => {
    const f = fake({ sessions: full() });
    const base = f.run;
    f.run = async (c, a, o) => {
      // claude pane check, and the window ends when the typed exit command is submitted
      if (c === 'tmux' && a[0] === 'list-windows') {
        const r = await base(c, a, o);
        return { ...r, stdout: r.stdout.replace(/\|bash/g, '|claude') };
      }
      if (c === 'tmux' && a[0] === 'send-keys' && a.includes('Enter') && a.includes('=Jobber:=hunt')) {
        f.sessions.set('Jobber', (f.sessions.get('Jobber') ?? []).filter((n) => n !== 'hunt'));
      }
      return base(c, a, o);
    };
    mkdirSync(join(root, '.jobber', 'work'), { recursive: true });
    writeFileSync(join(root, '.jobber', 'work', 'w-hunt-abc-1234.md'), 'x');
    const { takeWindowLock } = await import('../src/platform/windowLock.js');
    const lock = takeWindowLock(root, 'hunt', 'dispatch:hunt');
    expect(lock).not.toBeNull();
    const d = mk(f);
    expect(await runDown(d, { keepBridge: false, force: true })).toBe(0);
    lock?.release();
    const keys = f.calls.filter((c) => c[1] === 'send-keys' && c.includes('=Jobber:=hunt'));
    expect(keys[0][keys[0].length - 1]).toBe('Escape');
    expect(keys.some((c) => c.includes('-l'))).toBe(true);
    const { listHandoff } = await import('../src/platform/handoff.js');
    const h = listHandoff(root).filter((e) => e.window === 'hunt');
    expect(h.length).toBe(1);
    expect(h[0].what).toContain('w-hunt-abc-1234');
    expect(d.out.join('\n')).toContain('unfinished item is in .jobber/handoff.md');
  });

  it('a scheduler owned by a launchd unit is never stopped; unload hint printed', async () => {
    const f = fake({ sessions: full(), launchd: true });
    const d = mk(f);
    await runDown(d, { ...OPTS, force: true });
    expect(kills(f)).not.toContain('=Jobber:=scheduler');
    expect(f.calls.some((c) => c[1] === 'send-keys')).toBe(false);
    expect(d.out.join('\n')).toContain('launchctl unload');
  });

  it('only issues allowed tmux subcommands and leaves STOP', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    await runDown(mk(f), OPTS);
    const allowed = new Set(['has-session', 'list-windows', 'send-keys', 'kill-window', 'kill-session', 'capture-pane']);
    for (const c of f.calls) {
      if (c[0] === 'tmux') expect(allowed.has(c[1]), c.join(' ')).toBe(true);
      else expect(['launchctl', 'systemctl']).toContain(c[0]);
    }
    expect(existsSync(join(root, '.jobber', 'STOP'))).toBe(true);
  });
});
