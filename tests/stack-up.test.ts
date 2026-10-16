// tests/stack-up.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckOutcome } from '../src/platform/doctor.js';
import type { Run } from '../src/platform/tmux.js';
import { runUp, type StackDeps } from '../src/stack/up.js';
import { markPending, readPending } from '../src/settings/pendingRestart.js';
import { MemFs } from './helpers/memFs.js';

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

function setEnvFile(extra: string): void {
  writeFileSync(join(root, '.env'), `SOME_API_KEY=${SECRET}\nTELEGRAM_BOT_TOKEN=tok-${SECRET}\n${extra}`);
}

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
    const d = deps(f, {}, { SCHEDULER_DRY_RUN: undefined });
    await runUp(d, { status: false });
    expect(d.out[0]).toBe('MODE: DRY RUN (nothing is sent)');
    expect(d.out[d.out.length - 3]).toBe('MODE: DRY RUN (nothing is sent)');
    expect(d.out.filter((l) => l.startsWith('warning: shell exports'))).toEqual([]);
    expect(d.out[2]).toBe('  JOBBER_KILL=(unset)');
    setEnvFile('SCHEDULER_DRY_RUN=false\nLINKEDIN_DRY_RUN=false\nJOBBER_DRY_RUN=0\n');
    const live = deps(fake(), {}, { SCHEDULER_DRY_RUN: undefined });
    await runUp(live, { status: true });
    expect(live.out[0]).toContain('MODE: LIVE');
    setEnvFile('SCHEDULER_DRY_RUN=false\n');
    const half = deps(fake(), {}, { SCHEDULER_DRY_RUN: undefined });
    await runUp(half, { status: true });
    expect(half.out[0]).toContain('DRY RUN');
  });

  it('banner follows .env, not the shell, and warns on divergence (top and bottom)', async () => {
    setEnvFile('SCHEDULER_DRY_RUN=true\nLINKEDIN_DRY_RUN=true\n');
    const a = deps(fake(), {}, { SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'true' });
    await runUp(a, { status: true });
    expect(a.out[0]).toContain('DRY RUN');
    const w = a.out.filter((l) => l.includes('shell exports SCHEDULER_DRY_RUN=false'));
    expect(w.length).toBe(2);
    expect(w[0]).toContain('use .env (true)');
    expect(a.out.some((l) => l.includes('shell exports LINKEDIN_DRY_RUN'))).toBe(false);

    setEnvFile('SCHEDULER_DRY_RUN=false\nLINKEDIN_DRY_RUN=false\n');
    const b = deps(fake(), {}, { SCHEDULER_DRY_RUN: 'true', JOBBER_DRY_RUN: '0' });
    await runUp(b, { status: true });
    expect(b.out[0]).toContain('MODE: LIVE');
    expect(b.out.filter((l) => l.includes('shell exports SCHEDULER_DRY_RUN=true')).length).toBe(2);
    expect(b.out.some((l) => l.includes('shell exports JOBBER_DRY_RUN=0') && l.includes('(unset)'))).toBe(true);
  });

  it('warns when a started window exits immediately and shows it as not running', async () => {
    const f = fake();
    const base = f.run;
    f.run = async (c, a, o) => {
      const r = await base(c, a, o);
      if (c === 'tmux' && a[0] === 'new-session' && a.includes('scheduler')) f.sessions.get('jobber-stack')?.splice(0);
      return r;
    };
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(1);
    expect(d.out.join('\n')).toContain('warning: window scheduler exited immediately');
    expect(d.out.some((l) => /scheduler\s+not running/.test(l))).toBe(true);
    expect(d.out.join('\n')).toContain('Stop: npm stop (or npm run down)');
  });

  it('a bridge start failure exits 1 but still prints the table; --status stays 0', async () => {
    const f = fake();
    const base = f.run;
    f.run = async (c, a, o) => (c === 'bash' ? { stdout: 'nope', code: 1 } : base(c, a, o));
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(1);
    const text = d.out.join('\n');
    expect(text).toContain('warning: bridge: start.sh failed');
    expect(text).toContain('components:');
    const s = deps(f);
    expect(await runUp(s, { status: true })).toBe(0);
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

  it('prints the dashboard auth mode and the token hint only in token mode with no token', async () => {
    const noDb = deps(fake());
    await runUp(noDb, { status: true });
    const t = noDb.out.join('\n');
    expect(t).toContain('dashboard auth mode: token');
    expect(t).toContain('npm run dashboard -- token');

    mkdirSync(join(root, '.dashboard'));
    writeFileSync(join(root, '.dashboard', 'auth.sqlite'), '');
    const withTok = deps(fake(), { authTokenSet: () => true });
    await runUp(withTok, { status: true });
    expect(withTok.out.join('\n')).toContain('dashboard auth mode: token');
    expect(withTok.out.join('\n')).not.toContain('npm run dashboard -- token');

    setEnvFile('WEB_AUTH_MODE=oidc\n');
    const oidc = deps(fake());
    await runUp(oidc, { status: true });
    expect(oidc.out.join('\n')).toContain('dashboard auth mode: oidc');
    expect(oidc.out.join('\n')).not.toContain('npm run dashboard -- token');
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
      "const FLAG_NAMES = ['JOBBER_DRY_RUN', 'SCHEDULER_DRY_RUN', 'LINKEDIN_DRY_RUN'] as const;",
      "const tail = Object.entries(flags).map(([k, v]) => `${k}=${v}`).join('  ');",
    ]);
    const re = /JOBBER_DRY_RUN|SCHEDULER_DRY_RUN|LINKEDIN_DRY_RUN|applyResume|applyStop|halt_flags|permissions|settings\.local/;
    const files = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(dir, f));
    expect(files.length).toBeGreaterThanOrEqual(3);
    const assign = /\.(JOBBER|SCHEDULER|LINKEDIN)_DRY_RUN\s*=[^=]/;
    const procAssign = /process\.env(\.\w+|\[[^\]]+\])?\s*=[^=]/;
    const bad: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/writeFile|appendFile|unlink|rmSync/);
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (assign.test(t) || procAssign.test(t)) bad.push(`ASSIGN ${file}: ${t}`);
        if (!re.test(line)) continue;
        if (t.startsWith('//') || allowed.has(t)) continue;
        bad.push(`${file}: ${t}`);
      }
    }
    expect(bad).toEqual([]);
    // the guard itself catches what it should
    expect(assign.test('env.SCHEDULER_DRY_RUN = "false"')).toBe(true);
    expect(procAssign.test("process.env['X'] = 'y'")).toBe(true);
    expect(assign.test('env.SCHEDULER_DRY_RUN ?? 1')).toBe(false);
  });
});

describe('pending restart list', () => {
  const seed = (): MemFs => {
    const fs = new MemFs();
    markPending({ root, fs }, [
      { key: 'WEB_X', scope: 'dashboard' }, { key: 'SCH_X', scope: 'scheduler' },
      { key: 'MCP_X', scope: 'mcp' }, { key: 'STK_X', scope: 'stack' },
    ]);
    return fs;
  };
  const left = (fs: MemFs): string[] => readPending({ root, fs }).map((e) => e.key).sort();

  it('a full start clears dashboard, scheduler and stack, never mcp', async () => {
    const fs = seed();
    expect(await runUp(deps(fake(), { pendingFs: fs }), { status: false })).toBe(0);
    expect(left(fs)).toEqual(['MCP_X']);
  });

  it('clears only the scope of the component it started', async () => {
    const fs = seed();
    const f = fake({ preSessions: { 'jobber-stack': ['scheduler'] } });
    const d = deps(f, { pendingFs: fs }, { STACK_TMUX_SESSION: 'jobber-stack' });
    expect(await runUp(d, { status: false })).toBe(0);
    expect(left(fs)).toEqual(['MCP_X', 'SCH_X', 'STK_X']);
  });

  it('clears nothing when the start is refused or status only', async () => {
    const fs = seed();
    writeFileSync(join(root, '.jobber', 'STOP'), 'x');
    expect(await runUp(deps(fake(), { pendingFs: fs }), { status: false })).toBe(4);
    rmSync(join(root, '.jobber', 'STOP'));
    expect(await runUp(deps(fake(), { pendingFs: fs }), { status: true })).toBe(0);
    expect(left(fs)).toEqual(['MCP_X', 'SCH_X', 'STK_X', 'WEB_X']);
  });
});
