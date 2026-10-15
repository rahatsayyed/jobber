// tests/stack-up.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckOutcome } from '../src/platform/doctor.js';
import type { Run } from '../src/platform/tmux.js';
import { runUp, type StackDeps } from '../src/stack/up.js';

let root: string;
const SECRET = 'sk-invented-secret-value-123';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stack-up-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, '.jobber'));
  writeFileSync(join(root, 'config', 'manager-windows.json'), readFileSync('config/manager-windows.json', 'utf8'));
  writeFileSync(join(root, '.env'), `SOME_API_KEY=${SECRET}\nTELEGRAM_BOT_TOKEN=tok-${SECRET}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Fake { run: Run; calls: string[][]; sessions: Map<string, string[]> }

function fake(opts: { launchd?: boolean; preSessions?: Record<string, string[]> } = {}): Fake {
  const sessions = new Map<string, string[]>(Object.entries(opts.preSessions ?? {}));
  const calls: string[][] = [];
  const sess = (t: string): string => t.replace(/^=/, '').replace(/:.*$/, '');
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'launchctl') return { stdout: opts.launchd ? '1\t0\tdev.jobber.scheduler\n' : '', code: 0 };
    if (cmd === 'systemctl') return { stdout: 'inactive', code: 3 };
    if (cmd === 'bash') {
      sessions.set('ccgram-daemon', ['bridge']);
      return { stdout: 'Started ccgram', code: 0 };
    }
    if (cmd !== 'tmux') return { stdout: '', code: 0 };
    const t = args[args.indexOf('-t') + 1] ?? '';
    switch (args[0]) {
      case 'has-session': return { stdout: '', code: sessions.has(sess(t)) ? 0 : 1 };
      case 'new-session': {
        const name = args[args.indexOf('-s') + 1];
        const n = args.includes('-n') ? args[args.indexOf('-n') + 1] : 'shell';
        sessions.set(name, [n]);
        return { stdout: '', code: 0 };
      }
      case 'new-window': {
        const s = sessions.get(sess(t));
        if (!s) return { stdout: '', code: 1 };
        s.push(args[args.indexOf('-n') + 1]);
        return { stdout: '', code: 0 };
      }
      case 'list-windows': {
        const s = sessions.get(sess(t));
        if (!s) return { stdout: '', code: 1 };
        return { stdout: s.map((w, i) => `${i}|${w}|${i === 0 ? 1 : 0}|bash`).join('\n'), code: 0 };
      }
      default: return { stdout: '', code: 0 };
    }
  };
  return { run, calls, sessions };
}

function deps(f: Fake, over: Partial<StackDeps> = {}, env: NodeJS.ProcessEnv = {}): StackDeps & { out: string[] } {
  const out: string[] = [];
  return {
    root,
    env: { HOME: '/home/x', PATH: '/usr/bin', TERM: 'xterm', LANG: 'C', TZ: 'UTC', SCHEDULER_DRY_RUN: 'true', ...env },
    run: f.run,
    fs: { exists: (p) => existsSync(p), read: (p) => readFileSync(p, 'utf8') },
    now: () => new Date('2026-10-15T00:00:00Z'),
    doctor: async (): Promise<CheckOutcome[]> => [],
    say: (l) => void out.push(l),
    sleep: async () => {},
    probe: async () => true,
    out,
    ...over,
  };
}

const starts = (f: Fake): string[][] => f.calls.filter((c) => c[0] === 'tmux' && (c[1] === 'new-window' || c[1] === 'new-session'));

describe('up', () => {
  it('starts in order bridge, windows, scheduler, web; second run starts nothing', async () => {
    const f = fake();
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(0);
    const order = f.calls
      .filter((c) => c[0] === 'bash' || c[1] === 'new-window' || c[1] === 'new-session')
      .map((c) => {
        if (c[0] === 'bash') return 'bridge';
        const n = c.indexOf('-n');
        return n >= 0 ? c[n + 1] : c[c.indexOf('-s') + 1];
      });
    expect(order).toEqual(['bridge', 'ccgram', 'hunt', 'followups', 'manager', 'scheduler', 'web']);
    f.calls.length = 0;
    expect(await runUp(deps(f), { status: false })).toBe(0);
    expect(starts(f).filter((c) => c[1] === 'new-window' || c[1] === 'new-session')).toEqual([]);
  });

  it('refuses with exit 4 on STOP and starts nothing', async () => {
    writeFileSync(join(root, '.jobber', 'STOP'), 'x');
    const f = fake();
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(4);
    expect(starts(f)).toEqual([]);
    expect(f.calls.some((c) => c[0] === 'bash')).toBe(false);
    expect(existsSync(join(root, '.jobber', 'STOP'))).toBe(true);
  });

  it('refuses with exit 4 on JOBBER_KILL=1', async () => {
    const f = fake();
    expect(await runUp(deps(f, {}, { JOBBER_KILL: '1' }), { status: false })).toBe(4);
    expect(starts(f)).toEqual([]);
  });

  it('exits 1 on a doctor fail and starts nothing', async () => {
    const f = fake();
    const d = deps(f, {
      doctor: async () => [{ id: 'x-check', title: 't', result: { status: 'fail', detail: 'bad', fix: 'do it' } }],
    });
    expect(await runUp(d, { status: false })).toBe(1);
    expect(starts(f)).toEqual([]);
    expect(d.out.join('\n')).toContain('x-check');
    expect(d.out.join('\n')).toContain('do it');
  });

  it('skips the scheduler when a launchd unit is loaded', async () => {
    const f = fake({ launchd: true });
    expect(await runUp(deps(f), { status: false })).toBe(0);
    expect(starts(f).some((c) => c.includes('scheduler'))).toBe(false);
    expect(starts(f).some((c) => c.includes('web'))).toBe(true);
  });

  it('skips the scheduler when SCHEDULER_ENABLED=false', async () => {
    const f = fake();
    await runUp(deps(f, {}, { SCHEDULER_ENABLED: 'false' }), { status: false });
    expect(starts(f).some((c) => c.includes('scheduler'))).toBe(false);
  });

  it('starts scheduler and web with env -i and no .env value', async () => {
    const f = fake();
    await runUp(deps(f), { status: false });
    const sw = starts(f).filter((c) => c.includes('scheduler') || c.includes('web'));
    expect(sw.length).toBe(2);
    for (const c of sw) {
      const i = c.indexOf('env');
      expect(c[i + 1]).toBe('-i');
      expect(c.join(' ')).not.toContain(SECRET);
    }
    expect(f.calls.flat().join(' ')).not.toContain(SECRET);
  });

  it('prints the mode banner first and last; LIVE only when all flags are explicitly live', async () => {
    const f = fake();
    const d = deps(f);
    await runUp(d, { status: false });
    expect(d.out[0]).toBe('MODE: DRY RUN (nothing is sent)');
    expect(d.out[d.out.length - 2]).toBe('MODE: DRY RUN (nothing is sent)');
    const live = deps(fake(), {}, { SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false', JOBBER_DRY_RUN: '0' });
    await runUp(live, { status: true });
    expect(live.out[0]).toContain('MODE: LIVE');
    const half = deps(fake(), {}, { SCHEDULER_DRY_RUN: 'false' });
    await runUp(half, { status: true });
    expect(half.out[0]).toContain('DRY RUN');
  });

  it('status starts nothing, runs no doctor, exits 0 even with STOP', async () => {
    writeFileSync(join(root, '.jobber', 'STOP'), 'x');
    const f = fake();
    let doctor = 0;
    const d = deps(f, { doctor: async () => { doctor++; return []; } });
    expect(await runUp(d, { status: true })).toBe(0);
    expect(doctor).toBe(0);
    expect(starts(f)).toEqual([]);
    expect(f.calls.some((c) => c[0] === 'bash')).toBe(false);
  });

  it('shows the last verify result and never fails on a missing one', async () => {
    writeFileSync(join(root, '.jobber', 'verify.json'), JSON.stringify({ at: 'T', passed: 3, failed: 0, skipped: 1, stages: [] }));
    const d = deps(fake());
    await runUp(d, { status: true });
    expect(d.out.join('\n')).toContain('passed 3 failed 0 skipped 1');
  });

  it('a manager window failure is a warning, not a failure', async () => {
    const f = fake();
    const base = f.run;
    f.run = async (c, a, o) => (c === 'tmux' && a[0] === 'new-window' && a.includes('manager') ? { stdout: '', code: 1 } : base(c, a, o));
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(0);
    expect(d.out.join('\n')).toContain('warning: window manager');
  });
});

describe('mode immutability', () => {
  it('src/stack only reads dry-run flags and never touches halts, resume, stop or settings', () => {
    const dir = join(process.cwd(), 'src', 'stack');
    const allowed = new Set([
      "JOBBER_DRY_RUN: env.JOBBER_DRY_RUN ?? '(unset)',",
      "SCHEDULER_DRY_RUN: env.SCHEDULER_DRY_RUN ?? '(unset)',",
      "LINKEDIN_DRY_RUN: env.LINKEDIN_DRY_RUN ?? '(unset)',",
      "const tail = Object.entries(flags).map(([k, v]) => `${k}=${v}`).join('  ');",
    ]);
    const re = /JOBBER_DRY_RUN|SCHEDULER_DRY_RUN|LINKEDIN_DRY_RUN|applyResume|applyStop|halt_flags|permissions|settings\.local/;
    const bad: string[] = [];
    for (const f of readdirSync(dir)) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!re.test(line)) continue;
        const t = line.trim();
        if (t.startsWith('//') || allowed.has(t)) continue;
        bad.push(`${f}: ${t}`);
      }
    }
    expect(bad).toEqual([]);
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/writeFile|appendFile|unlink|rmSync/);
    }
  });
});
