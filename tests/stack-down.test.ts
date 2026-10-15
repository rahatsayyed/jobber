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
  writeFileSync(join(root, 'config', 'manager-windows.json'), readFileSync('config/manager-windows.json', 'utf8'));
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
    if (cmd === 'bash') {
      sessions.delete('ccgram-daemon');
      return { stdout: 'Stopped', code: 0 };
    }
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
  'jobber-stack': ['scheduler', 'web'],
  ccgram: ['hunt', 'followups', 'manager'],
  'ccgram-daemon': ['bridge'],
});
const OPTS: DownOpts = { keepBridge: false, force: false, yes: true };
const kills = (f: Fake): string[] => f.calls.filter((c) => c[0] === 'tmux' && c[1] === 'kill-window').map((c) => c[c.length - 1]);

describe('down', () => {
  it('stops in order web, scheduler, hunt, followups, bridge; never manager', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    expect(await runDown(mk(f), OPTS)).toBe(0);
    const order = f.calls
      .filter((c) => (c[0] === 'tmux' && (c[1] === 'kill-window' || c[1] === 'send-keys')) || c[0] === 'bash')
      .map((c) => (c[0] === 'bash' ? 'bridge' : c[c.length - (c[1] === 'send-keys' ? 2 : 1)].replace(/^=.*:=?/, '')));
    expect(order).toEqual(['web', 'scheduler', 'hunt', 'followups', 'bridge']);
    expect(f.sessions.get('ccgram')).toEqual(['manager']);
    expect(f.calls.flat().some((a) => a.endsWith('manager') && a.includes(':') )).toBe(false);
  });

  it('scheduler gets C-c and is not killed when it stays; message printed', async () => {
    const f = fake({ sessions: full() });
    const d = mk(f, {}, { STACK_DOWN_WAIT_SEC: '7' });
    await runDown(d, OPTS);
    expect(f.calls.some((c) => c[1] === 'send-keys' && c.includes('C-c') && c.includes('=jobber-stack:=scheduler'))).toBe(true);
    expect(kills(f)).not.toContain('=jobber-stack:=scheduler');
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
    expect(kills(f)).toContain('=jobber-stack:=scheduler');
    expect(f.sessions.get('jobber-stack')).toEqual([]);
  });

  it('--keep-bridge skips the bridge', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    await runDown(mk(f), { ...OPTS, keepBridge: true });
    expect(f.calls.some((c) => c[0] === 'bash')).toBe(false);
    expect(f.sessions.has('ccgram-daemon')).toBe(true);
  });

  it('is idempotent: a second down records zero kills and reports absent', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    await runDown(mk(f), OPTS);
    f.calls.length = 0;
    const d = mk(f);
    expect(await runDown(d, OPTS)).toBe(0);
    expect(kills(f)).toEqual([]);
    expect(f.calls.some((c) => c[1] === 'send-keys' || c[0] === 'bash')).toBe(false);
    expect(d.out.filter((l) => l.endsWith('absent')).length).toBeGreaterThanOrEqual(5);
  });

  it('non-TTY without --yes leaves hunt and followups', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    const d = mk(f);
    await runDown(d, { ...OPTS, yes: false });
    expect(f.sessions.get('ccgram')).toEqual(['hunt', 'followups', 'manager']);
    expect(d.out.join('\n')).toContain('pass --yes');
  });

  it('TTY asks once per window', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    const asked: string[] = [];
    const d = mk(f, { isTTY: true, ask: async (q) => (asked.push(q), q.includes('hunt')) });
    await runDown(d, { ...OPTS, yes: false });
    expect(asked.length).toBe(2);
    expect(f.sessions.get('ccgram')).toEqual(['followups', 'manager']);
  });

  it('a scheduler owned by a launchd unit is never stopped; unload hint printed', async () => {
    const f = fake({ sessions: full(), launchd: true });
    const d = mk(f);
    await runDown(d, { ...OPTS, force: true });
    expect(kills(f)).not.toContain('=jobber-stack:=scheduler');
    expect(f.calls.some((c) => c[1] === 'send-keys')).toBe(false);
    expect(d.out.join('\n')).toContain('launchctl unload');
  });

  it('only issues allowed tmux subcommands and leaves STOP', async () => {
    const f = fake({ sessions: full(), exitOnCtrlC: true });
    await runDown(mk(f), OPTS);
    const allowed = new Set(['has-session', 'list-windows', 'send-keys', 'kill-window']);
    for (const c of f.calls) {
      if (c[0] === 'tmux') expect(allowed.has(c[1]), c.join(' ')).toBe(true);
      else expect(['launchctl', 'systemctl', 'bash']).toContain(c[0]);
    }
    expect(existsSync(join(root, '.jobber', 'STOP'))).toBe(true);
  });
});
