// tests/stack-skips.test.ts
// Plan 8F task 9: `up`, the dashboard-login stage and the guide facts cope with skipped features.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckOutcome } from '../src/platform/doctor.js';
import type { Run } from '../src/platform/tmux.js';
import { runUp, type StackDeps } from '../src/stack/up.js';
import { dashboardLogin } from '../src/verify/stages.js';
import { buildCtx } from '../src/verify/engine.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stack-skips-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, '.jobber'));
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'config', 'manager-windows.json'), readFileSync('config/manager-windows.json', 'utf8'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(opts: { env?: string; skipped?: string[] }): void {
  writeFileSync(join(root, '.env'), opts.env ?? '');
  const steps: Record<string, { status: string; at: string }> = {};
  for (const id of opts.skipped ?? []) steps[id] = { status: 'skipped', at: '2026-10-15T00:00:00Z' };
  writeFileSync(join(root, 'user-data', '.setup-state.json'), JSON.stringify({ version: 1, steps, answers: {} }));
}

interface Fake { run: Run; calls: string[][]; sessions: Map<string, string[]> }
function fake(): Fake {
  const sessions = new Map<string, string[]>();
  const calls: string[][] = [];
  const sess = (t: string): string => t.replace(/^=/, '').replace(/:.*$/, '');
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'launchctl') return { stdout: '', code: 0 };
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
        sessions.set(name, [args.includes('-n') ? args[args.indexOf('-n') + 1] : 'shell']);
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

function deps(f: Fake, probes: string[] = []): StackDeps & { out: string[] } {
  const out: string[] = [];
  return {
    root,
    env: { HOME: '/home/x', PATH: '/usr/bin', SCHEDULER_DRY_RUN: 'true' },
    run: f.run,
    fs: { exists: (p) => existsSync(p), read: (p) => readFileSync(p, 'utf8') },
    now: () => new Date('2026-10-15T00:00:00Z'),
    doctor: async (): Promise<CheckOutcome[]> => [],
    say: (l) => void out.push(l),
    sleep: async () => {},
    probe: async (u) => { probes.push(u); return true; },
    out,
  };
}

const created = (f: Fake): string[] =>
  f.calls.filter((c) => c[0] === 'tmux' && (c[1] === 'new-window' || c[1] === 'new-session'))
    .map((c) => (c.includes('-n') ? c[c.indexOf('-n') + 1] : c[c.indexOf('-s') + 1]));

const TG = 'TELEGRAM_BOT_TOKEN=tok-abc\n';
const WEB = 'WEB_AUTH_MODE=oidc\n';

describe('up with skipped features', () => {
  it('both configured and nothing skipped: unchanged', async () => {
    setup({ env: TG });
    const f = fake();
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(0);
    expect(created(f)).toEqual(['ccgram', 'hunt', 'followups', 'manager', 'scheduler', 'web']);
    expect(d.out.join('\n')).not.toContain('(setup)');
    expect(d.out.join('\n')).not.toContain('STACK');
  });

  it('telegram skipped: no bridge, no manager windows, rows and hint', async () => {
    setup({ skipped: ['telegram'] });
    const f = fake();
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(0);
    expect(f.calls.some((c) => c[0] === 'bash')).toBe(false);
    expect(created(f)).toEqual(['scheduler', 'web']);
    const t = d.out.join('\n');
    expect(t).toMatch(/bridge\s+skipped \(setup\)\s+npm run setup -- --step telegram/);
    expect(t).toMatch(/windows\s+skipped \(setup\)\s+npm run setup -- --step telegram/);
    expect(t).toContain('npx tsx scripts/manager.ts start hunt');
    expect(t).toContain('STACK: skipped by choice: telegram.');
  });

  it('dashboard skipped: no web window, no probe, row and end line', async () => {
    setup({ env: TG, skipped: ['dashboard'] });
    const f = fake();
    const probes: string[] = [];
    const d = deps(f, probes);
    expect(await runUp(d, { status: false })).toBe(0);
    expect(created(f)).toEqual(['ccgram', 'hunt', 'followups', 'manager', 'scheduler']);
    expect(probes).toEqual([]);
    const t = d.out.join('\n');
    expect(t).toMatch(/web\s+skipped \(setup\)\s+npm run setup -- --step dashboard/);
    expect(t).toContain('STACK: skipped by choice: dashboard.');
    expect(t.match(/STACK:/g)?.length).toBe(1);
  });

  it('both skipped: only the scheduler starts, one end line lists both', async () => {
    setup({ skipped: ['telegram', 'dashboard'] });
    const f = fake();
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(0);
    expect(created(f)).toEqual(['scheduler']);
    expect(d.out.filter((l) => l.startsWith('STACK:'))).toEqual([
      'STACK: skipped by choice: telegram, dashboard. Re-enable: npm run setup -- --step <id>',
    ]);
  });

  it('telegram skipped but token present: configured wins', async () => {
    setup({ env: TG, skipped: ['telegram'] });
    const f = fake();
    const d = deps(f);
    expect(await runUp(d, { status: false })).toBe(0);
    expect(f.calls.some((c) => c[0] === 'bash')).toBe(true);
    expect(created(f)).toEqual(['ccgram', 'hunt', 'followups', 'manager', 'scheduler', 'web']);
    expect(d.out.join('\n')).not.toContain('skipped (setup)');
  });

  it('WEB_AUTH_MODE=token (shipped default) plus a dashboard skip stays skipped', async () => {
    setup({ env: TG + 'WEB_AUTH_MODE=token\n', skipped: ['dashboard'] });
    const f = fake();
    const d = deps(f);
    await runUp(d, { status: false });
    expect(created(f)).not.toContain('web');
    expect(d.out.join('\n')).toMatch(/web\s+skipped \(setup\)/);
  });

  it('google_desktop plus a dashboard skip: configured wins', async () => {
    setup({ env: TG + 'WEB_AUTH_MODE=google_desktop\n', skipped: ['dashboard'] });
    const f = fake();
    await runUp(deps(f), { status: false });
    expect(created(f)).toContain('web');
  });

  it('dashboard skipped but configured: web starts', async () => {
    setup({ env: TG + WEB, skipped: ['dashboard'] });
    const f = fake();
    await runUp(deps(f), { status: false });
    expect(created(f)).toContain('web');
  });

  it('--status prints the same rows and runs nothing', async () => {
    setup({ skipped: ['telegram', 'dashboard'] });
    const f = fake();
    const probes: string[] = [];
    const d = deps(f, probes);
    expect(await runUp(d, { status: true })).toBe(0);
    expect(created(f)).toEqual([]);
    expect(f.calls.some((c) => c[0] === 'bash')).toBe(false);
    expect(probes).toEqual([]);
    const t = d.out.join('\n');
    expect(t).toMatch(/bridge\s+skipped \(setup\)/);
    expect(t).toMatch(/windows\s+skipped \(setup\)/);
    expect(t).toMatch(/web\s+skipped \(setup\)/);
  });

  it('kill switch still refuses with skips', async () => {
    setup({ skipped: ['telegram'] });
    writeFileSync(join(root, '.jobber', 'STOP'), 'x');
    const f = fake();
    expect(await runUp(deps(f), { status: false })).toBe(4);
    expect(created(f)).toEqual([]);
  });
});

describe('dashboard-login stage with a skipped dashboard', () => {
  it('skips before starting a server', async () => {
    setup({ env: 'WEB_AUTH_MODE=token\n', skipped: ['dashboard'] });
    let started = 0;
    const ctx = buildCtx({
      root, env: { PATH: '/usr/bin' }, run: async () => ({ stdout: '', code: 0 }),
      fs: {
        mkdtemp: (p: string) => mkdtempSync(join(tmpdir(), p)),
        mkdir: (p: string) => { mkdirSync(p, { recursive: true }); },
        write: (p: string, d: string) => writeFileSync(p, d),
        read: (p: string) => readFileSync(p, 'utf8'),
        exists: (p: string) => existsSync(p),
        rm: (p: string) => rmSync(p, { recursive: true, force: true }),
      },
      now: () => new Date(),
      doctor: async () => [],
      openDb: (() => { throw new Error('unused'); }) as never,
      startWeb: async () => { started++; return { url: 'http://x', close: async () => {} }; },
      fixtures: (() => { throw new Error('unused'); }) as never,
    });
    const r = await dashboardLogin.run(ctx);
    rmSync(ctx.tmp, { recursive: true, force: true });
    expect(r.status).toBe('skip');
    expect(r.detail).toContain('dashboard skipped in setup');
    expect(started).toBe(0);
  });
});

describe('one definition of skipped', () => {
  it('src/stack and src/verify use skips.ts and do not re-derive skipped from state', () => {
    const files = ['src/stack', 'src/verify']
      .flatMap((d) => (readdirSync(d, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => join(d, f)));
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/status\s*===\s*'skipped'/);
      expect(t, f).not.toMatch(/setup-state/);
    }
    expect(readFileSync('src/stack/up.ts', 'utf8')).toContain("from '../setup/skips.js'");
    expect(readFileSync('src/verify/stages.ts', 'utf8')).toContain("from '../setup/skips.js'");
  });

  it('skips.ts, up.ts and stages.ts never write a dry flag, halt or permission file', () => {
    for (const f of ['src/setup/skips.ts', 'src/stack/up.ts', 'src/verify/stages.ts']) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/\.(JOBBER|SCHEDULER|LINKEDIN)_DRY_RUN\s*=[^=]/);
      expect(t, f).not.toMatch(/writeFile|appendFile|settings\.local|permission-sets|insertHalt|setHalt|clearHalt/);
    }
  });
});

describe('guide facts', () => {
  it('SKILL.md and setup-guide.json carry the skip facts and keep the tool list', () => {
    const skill = readFileSync('.claude/skills/setup-guide/SKILL.md', 'utf8');
    expect(skill).toMatch(/Telegram, the dashboard, Gmail and the optional API keys/);
    expect(skill).toContain('skip');
    expect(skill).toContain('npm run setup -- --step <id>');
    expect(skill).toMatch(/never skips anything for the owner/);
    const guide = JSON.parse(readFileSync('config/setup-guide.json', 'utf8')) as {
      skip_facts?: string[];
      steps: Array<{ id: string; skip?: string }>;
    };
    const facts = (guide.skip_facts ?? []).join(' ');
    expect(facts).toMatch(/telegram/i);
    expect(facts).toMatch(/expected and not a problem/);
    expect(facts).toContain('npm run setup -- --step <id>');
    expect(facts).toMatch(/never skips/);
  });
});
