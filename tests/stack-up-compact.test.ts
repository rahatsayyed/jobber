// tests/stack-up-compact.test.ts
// The quiet default output of `npm run up` (compact), through runUp with a fake tmux.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckOutcome } from '../src/platform/doctor.js';
import type { Run } from '../src/platform/tmux.js';
import { runUp, type StackDeps } from '../src/stack/up.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stack-compact-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, '.jobber'));
  writeFileSync(join(root, 'config', 'manager-windows.json'), readFileSync('config/manager-windows.json', 'utf8'));
  writeFileSync(join(root, '.env'), 'TELEGRAM_BOT_TOKEN=tok-invented\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeRun(): Run {
  const sessions = new Map<string, string[]>();
  const sess = (t: string): string => t.replace(/^=/, '').replace(/:.*$/, '');
  return async (cmd, args) => {
    if (cmd === 'launchctl') return { stdout: '', code: 0 };
    if (cmd === 'systemctl') return { stdout: 'inactive', code: 3 };
    if (cmd !== 'tmux') return { stdout: '', code: 0 };
    const t = args[args.indexOf('-t') + 1] ?? '';
    switch (args[0]) {
      case 'has-session': return { stdout: '', code: sessions.has(sess(t)) ? 0 : 1 };
      case 'new-session': {
        sessions.set(args[args.indexOf('-s') + 1], [args.includes('-n') ? args[args.indexOf('-n') + 1] : 'shell']);
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
        return { stdout: s.map((w, i) => `${i}|${w}|${i === 0 ? 1 : 0}|claude`).join('\n'), code: 0 };
      }
      default: return { stdout: '', code: 0 };
    }
  };
}

function deps(doctor: () => Promise<CheckOutcome[]>, env: NodeJS.ProcessEnv = {}): StackDeps & { out: string[] } {
  const out: string[] = [];
  return {
    root,
    env: { HOME: '/home/x', PATH: '/usr/bin', TERM: 'xterm', LANG: 'C', TZ: 'UTC', ...env },
    run: fakeRun(),
    fs: { exists: (p) => existsSync(p), read: (p) => readFileSync(p, 'utf8') },
    now: () => new Date('2026-10-15T00:00:00Z'),
    doctor,
    say: (l) => void out.push(l),
    sleep: async () => {},
    probe: async () => true,
    out,
  };
}

const w = (id: string, detail: string, fix?: string): CheckOutcome => ({ id, title: id, result: { status: 'warn', detail, fix } });

describe('up (compact output)', () => {
  it('prints only the status line and the dashboard URL when all runs; routine doctor warnings stay quiet', async () => {
    const d = deps(async () => [w('backup-config', 'backup not configured'), w('layout_drift', 'drift streak: linkedin/x streak 2')]);
    expect(await runUp(d, { status: false, compact: true })).toBe(0);
    expect(d.out.length).toBe(2);
    expect(d.out[0]).toMatch(/^Jobber: all \d+ components running$/);
    expect(d.out[1]).toBe('dashboard: http://127.0.0.1:8787');
  });

  it('shows a needs-you line for a stale window, and the MODE line only in a dry run', async () => {
    writeFileSync(join(root, '.env'), 'TELEGRAM_BOT_TOKEN=tok-invented\nJOBBER_DRY_RUN=true\n');
    const d = deps(
      async () => [w('window-foundation', 'the mail window is running with an old daily email limit', 'restart it: npx tsx scripts/manager.ts restart mail')],
      { JOBBER_DRY_RUN: undefined },
    );
    await runUp(d, { status: false, compact: true });
    expect(d.out.some((l) => l.startsWith('NEEDS YOU: the mail window is running with an old daily email limit'))).toBe(true);
    expect(d.out).toContain('MODE: DRY RUN (nothing is sent)');
  });

  it('a doctor failure and the kill switch are still printed in compact mode', async () => {
    const d = deps(async () => [{ id: 'x-check', title: 't', result: { status: 'fail', detail: 'bad', fix: 'do it' } }]);
    expect(await runUp(d, { status: false, compact: true })).toBe(1);
    expect(d.out.join('\n')).toContain('do it');
    writeFileSync(join(root, '.jobber', 'STOP'), 'x');
    const k = deps(async () => []);
    expect(await runUp(k, { status: false, compact: true })).toBe(4);
    expect(k.out.join('\n')).toContain('kill switch is on');
  });
});
