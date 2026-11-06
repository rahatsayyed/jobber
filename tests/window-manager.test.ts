// tests/window-manager.test.ts
// Phase 2 (manager): send, clear, restart with startup line, handoff CLI, reminder tick, recycle, up and down with worker windows,
// the env catalog entries. Fakes only: a fake tmux, a temp project root, no live process.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addHandoff, ensureHandoffFile, handoffFile, noteSkippedItem, startupLine } from '../src/platform/handoff.js';
import {
  loadManagerConfig, recycleWindow, restartWindowWithMemory, startWindowWithMemory, windowRecycleHours, type ManagerConfig,
} from '../src/platform/manager.js';
import { clearWindow, sendToWindow, validateManagerText } from '../src/platform/managerTyping.js';
import { parseEtime } from '../src/platform/windowAge.js';
import { takeWindowLock } from '../src/platform/windowLock.js';
import type { Run } from '../src/platform/tmux.js';
import { projectTranscriptDir, readWindowSession, typeStartupLine, writeWindowSession } from '../src/platform/windowSession.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { runDown } from '../src/stack/down.js';
import { runUp } from '../src/stack/up.js';
import {
  composeReminder, dueEntries, handoffRemindEveryMin, readRemindState, windowUpkeep, type WindowTickDeps,
} from '../src/scheduler/windowTick.js';

const SID = '11111111-2222-4333-8444-555555555555';
const NEW_SID = '99999999-2222-4333-8444-555555555555';
const HOUR = 3_600_000;
const sleep = async (): Promise<void> => undefined;

let root: string;
let claudeHome: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'win-mgr-'));
  claudeHome = path.join(root, 'claude-home');
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(root, '.jobber'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CONFIG = {
  session: 'Jobber',
  protected: ['manager', 'bridge', 'chat'],
  windows: {
    mail: { kind: 'worker', recycle_hours: 2 },
    boards: { kind: 'worker' },
    plain: { argv: ['bash', 'scripts/claude-session.sh'], description: 'not a worker' },
  },
};
const cfg = (): ManagerConfig => loadManagerConfig(JSON.stringify(CONFIG));

interface Win { name: string; command: string; pid: number; activitySec: number }
interface Fake {
  run: Run; calls: string[][]; typed: Array<{ window: string; text: string }>; wins: Win[]; etime: Record<number, string>;
}

function fake(initial: Array<Partial<Win> & { name: string }>, now = Date.now()): Fake {
  let nextPid = 5000;
  const wins: Win[] = initial.map((w) => ({ command: 'claude', pid: nextPid++, activitySec: Math.floor(now / 1000) - 3600, ...w }));
  const f: Fake = { run: undefined as unknown as Run, calls: [], typed: [], wins, etime: {} };
  const winOf = (t: string): string => /:=?(.*)$/.exec(t)?.[1] ?? '';
  f.run = async (cmd, args) => {
    f.calls.push([cmd, ...args]);
    if (cmd === 'ps') return { stdout: `${f.etime[Number(args[args.indexOf('-p') + 1])] ?? ''}\n`, code: f.etime[Number(args[args.indexOf('-p') + 1])] ? 0 : 1 };
    if (cmd !== 'tmux') return { stdout: '', code: 0 };
    const t = args[args.indexOf('-t') + 1] ?? '';
    switch (args[0]) {
      case 'has-session': return { stdout: '', code: 0 };
      case 'list-windows': return { stdout: wins.map((w, i) => `${i}|${w.name}|0|${w.command}`).join('\n'), code: 0 };
      case 'display-message': {
        const w = wins.find((x) => x.name === winOf(t));
        const fmt = args[args.length - 1];
        if (!w) return { stdout: '', code: 1 };
        return { stdout: fmt === '#{pane_pid}' ? `${w.pid}\n` : `${w.activitySec}\n`, code: 0 };
      }
      case 'send-keys':
        if (args.includes('-l')) f.typed.push({ window: winOf(t), text: args[args.length - 1] });
        return { stdout: '', code: 0 };
      case 'kill-window': {
        const i = wins.findIndex((x) => x.name === winOf(t));
        if (i >= 0) wins.splice(i, 1);
        return { stdout: '', code: 0 };
      }
      case 'new-window': {
        wins.push({ name: args[args.indexOf('-n') + 1], command: 'claude', pid: nextPid++, activitySec: Math.floor(now / 1000) });
        return { stdout: '', code: 0 };
      }
      default: return { stdout: '', code: 0 };
    }
  };
  return f;
}

const deps = (over: Record<string, unknown> = {}) => ({ root, killed: () => false, sleep, settleMs: 0, claudeHome, ...over });

describe('text rules of send', () => {
  it('accepts a short plain line', () => {
    expect(() => validateManagerText('please check the mail queue when you are free')).not.toThrow();
  });
  it.each([
    ['empty', '   '],
    ['newline', 'a\nb'],
    ['leading bang', '!ls'],
    ['leading hash', '# x'],
    ['leading amp', '& x'],
    ['slash command', '/compact'],
    ['owner command', 'please run STOP now'],
    ['kill switch name', 'set JOBBER_KILL=1'],
    ['dry run flag', 'flip JOBBER_DRY_RUN'],
    ['skip permissions', 'use --dangerously-skip-permissions'],
    ['secret shape', 'use key sk-abcdefghijklmnop1234'],
    ['too long', 'x '.repeat(260)],
  ])('refuses %s', (_n, text) => {
    expect(() => validateManagerText(text)).toThrow();
  });
});

describe('typing code stays in one file', () => {
  it('manager.ts never types; managerTyping.ts uses sendText and no raw tmux verb', () => {
    expect(readFileSync('src/platform/manager.ts', 'utf8')).not.toContain('sendText');
    const t = readFileSync('src/platform/managerTyping.ts', 'utf8');
    for (const bad of ['send-keys', 'paste-buffer', 'load-buffer']) expect(t).not.toContain(bad);
    expect(t).toContain('assertClaudePane');
    expect(t).toContain('validateSendText');
  });
});

describe('send', () => {
  it('types one line into a worker window and reports only name and length', async () => {
    const f = fake([{ name: 'mail' }]);
    const text = 'check the mail queue';
    const r = await sendToWindow(f.run, cfg(), {}, 'mail', text, deps());
    expect(r).toBe(`sent to mail (${text.length} chars)`);
    expect(r).not.toContain(text);
    expect(f.typed).toEqual([{ window: 'mail', text }]);
  });
  it('refuses protected, unlisted and non-worker windows and types nothing', async () => {
    const f = fake([{ name: 'manager' }, { name: 'ghost' }, { name: 'plain' }, { name: 'chat' }]);
    for (const w of ['manager', 'chat', 'bridge']) await expect(sendToWindow(f.run, cfg(), {}, w, 'hi', deps())).rejects.toThrow(/protected/);
    await expect(sendToWindow(f.run, cfg(), {}, 'ghost', 'hi', deps())).rejects.toThrow(/allowlist/);
    await expect(sendToWindow(f.run, cfg(), {}, 'plain', 'hi', deps())).rejects.toThrow(/not a worker/);
    expect(f.typed).toEqual([]);
  });
  it('refuses on the kill switch', async () => {
    const f = fake([{ name: 'mail' }]);
    await expect(sendToWindow(f.run, cfg(), {}, 'mail', 'hi', deps({ killed: () => true }))).rejects.toThrow(/kill switch/);
    expect(f.typed).toEqual([]);
  });
  it('refuses window_busy while the dispatcher lock is held, and works again after release', async () => {
    const f = fake([{ name: 'mail' }]);
    const lock = takeWindowLock(root, 'mail', 'dispatch:mail');
    expect(lock).not.toBeNull();
    await expect(sendToWindow(f.run, cfg(), {}, 'mail', 'hi', deps())).rejects.toThrow(/window_busy/);
    expect(f.typed).toEqual([]);
    lock?.release();
    await sendToWindow(f.run, cfg(), {}, 'mail', 'hi', deps());
    expect(f.typed.length).toBe(1);
  });
  it('refuses a pane that is not claude, and a missing window', async () => {
    const f = fake([{ name: 'mail', command: 'zsh' }]);
    await expect(sendToWindow(f.run, cfg(), {}, 'mail', 'hi', deps())).rejects.toThrow(/not running claude/);
    await expect(sendToWindow(f.run, cfg(), {}, 'boards', 'hi', deps())).rejects.toThrow(/not found/);
    expect(f.typed).toEqual([]);
  });
  it('releases its lock after typing', async () => {
    const f = fake([{ name: 'mail' }]);
    await sendToWindow(f.run, cfg(), {}, 'mail', 'hi', deps());
    const again = takeWindowLock(root, 'mail', 'x');
    expect(again).not.toBeNull();
    again?.release();
  });
});

describe('clear', () => {
  const writeTranscript = (id: string): void => {
    const dir = projectTranscriptDir(root, claudeHome);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: '/clear' } })}\n`);
  };

  it('types /clear and records the new transcript when it is found', async () => {
    const f = fake([{ name: 'mail' }]);
    writeWindowSession(root, 'mail', SID);
    writeTranscript(NEW_SID);
    const r = await clearWindow(f.run, cfg(), {}, 'mail', deps());
    expect(f.typed).toEqual([{ window: 'mail', text: '/clear' }]);
    expect(r).toContain('found again');
    expect(readWindowSession(root, 'mail')).toMatchObject({ session_id: NEW_SID });
    expect(readWindowSession(root, 'mail')?.stale).toBeUndefined();
  });
  it('marks the record stale when the new transcript is not found', async () => {
    const f = fake([{ name: 'mail' }]);
    writeWindowSession(root, 'mail', SID);
    const r = await clearWindow(f.run, cfg(), {}, 'mail', deps());
    expect(r).toContain('not found');
    expect(readWindowSession(root, 'mail')).toMatchObject({ session_id: SID, stale: true });
  });
  it('refuses a busy window, a protected window, a non-claude pane and the kill switch', async () => {
    const f = fake([{ name: 'mail' }, { name: 'boards', command: 'zsh' }, { name: 'manager' }]);
    const lock = takeWindowLock(root, 'mail', 'dispatch:mail');
    await expect(clearWindow(f.run, cfg(), {}, 'mail', deps())).rejects.toThrow(/window_busy/);
    lock?.release();
    await expect(clearWindow(f.run, cfg(), {}, 'manager', deps())).rejects.toThrow(/protected/);
    await expect(clearWindow(f.run, cfg(), {}, 'boards', deps())).rejects.toThrow(/not running claude/);
    await expect(clearWindow(f.run, cfg(), {}, 'mail', deps({ killed: () => true }))).rejects.toThrow(/kill switch/);
    expect(f.typed).toEqual([]);
  });
});

describe('start and restart with the startup line', () => {
  it('startWindowWithMemory types the startup line for a worker window and creates the handoff file (0600)', async () => {
    const f = fake([]);
    const r = await startWindowWithMemory(f.run, cfg(), {}, 'mail', root, { sleep });
    expect(r).toEqual({ state: 'started', startup: 'typed' });
    expect(f.typed).toEqual([{ window: 'mail', text: startupLine('mail') }]);
    expect(existsSync(handoffFile(root))).toBe(true);
    expect(statSync(handoffFile(root)).mode & 0o777).toBe(0o600);
  });
  it('does not type for a window that already exists, nor for a non-worker window', async () => {
    const f = fake([{ name: 'mail' }]);
    expect((await startWindowWithMemory(f.run, cfg(), {}, 'mail', root, { sleep })).startup).toBe('skipped');
    expect((await startWindowWithMemory(f.run, cfg(), {}, 'plain', root, { sleep })).startup).toBe('skipped');
    expect(f.typed).toEqual([]);
  });
  it('restart of a worker window types the startup line; busy is refused; protected is refused', async () => {
    const f = fake([{ name: 'mail' }]);
    const lock = takeWindowLock(root, 'mail', 'dispatch:mail');
    await expect(restartWindowWithMemory(f.run, cfg(), {}, 'mail', root, { sleep })).rejects.toThrow(/window_busy/);
    lock?.release();
    const r = await restartWindowWithMemory(f.run, cfg(), {}, 'mail', root, { sleep });
    expect(r).toEqual({ state: 'restarted', startup: 'typed' });
    expect(f.typed.map((t) => t.text)).toEqual([startupLine('mail')]);
    await expect(restartWindowWithMemory(f.run, cfg(), {}, 'manager', root, { sleep })).rejects.toThrow(/protected/);
  });
  it('typeStartupLine retries a bounded number of times, then gives up without typing', async () => {
    const f = fake([{ name: 'mail', command: 'zsh' }]);
    let slept = 0;
    const r = await typeStartupLine(f.run, 'Jobber', 'mail', { tries: 4, sleep: async () => { slept++; } });
    expect(r).toBe('not_ready');
    expect(slept).toBe(4);
    expect(f.typed).toEqual([]);
  });
  it('the manager has its own startup line that points at the handoff file', () => {
    const l = startupLine('manager');
    expect(l).toContain('.jobber/handoff.md');
    expect(l).not.toContain('role file');
    expect(() => validateManagerText(l)).not.toThrow();
  });
  it('ensureHandoffFile creates an empty 0600 file once and never overwrites', () => {
    expect(ensureHandoffFile(root)).toBe(true);
    addHandoff(root, { window: 'mail', what: 'x', why: 'y' });
    expect(ensureHandoffFile(root)).toBe(false);
    expect(readFileSync(handoffFile(root), 'utf8')).toContain('mail | x | y');
  });
  it('noteSkippedItem is the lane call site: one pending entry per item', () => {
    const a = noteSkippedItem(root, { window: 'mail', item: 'cold email to job 41', reason: 'daily send cap reached' });
    const b = noteSkippedItem(root, { window: 'mail', item: 'cold email to job 41', reason: 'daily send cap reached' });
    expect(a && a.ok && !a.existing).toBe(true);
    expect(b && b.ok && b.existing).toBe(true);
  });
});

describe('handoff command of scripts/manager.ts', () => {
  const exec = promisify(execFile);
  const run = async (...args: string[]): Promise<{ code: number; out: string; err: string }> => {
    try {
      const r = await exec('npx', ['tsx', 'scripts/manager.ts', 'handoff', ...args], { cwd: process.cwd(), timeout: 60_000 });
      return { code: 0, out: r.stdout, err: r.stderr };
    } catch (e) {
      const x = e as { code?: number; stdout?: string; stderr?: string };
      return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
    }
  };

  it('add, list and resolve through the CLI; bad usage exits 2', async () => {
    const hf = handoffFile(process.cwd());
    const existed = existsSync(hf);
    try {
      expect((await run('add', 'mail')).code).toBe(2);
      expect((await run('bogus')).code).toBe(2);
      const add = await run('add', 'mail', 'phase2-test-item', 'why', 'because');
      expect(add.code).toBe(0);
      const id = /added: (h[0-9a-f]+)/.exec(add.out)?.[1];
      expect(id).toBeTruthy();
      const list = await run('list', 'mail');
      expect(list.out).toContain('phase2-test-item');
      expect((await run('resolve', id as string)).out).toContain('resolved');
      expect((await run('resolve', id as string)).code).toBe(1);
      expect((await run('list', 'mail')).out).not.toContain('phase2-test-item');
    } finally {
      if (!existed) rmSync(hf, { force: true });
    }
  }, 120_000);
});

describe('reminder tick', () => {
  const T0 = Date.parse('2026-11-04T12:00:00.000Z');
  const mk = (f: Fake, over: Partial<WindowTickDeps> = {}): WindowTickDeps & { alerts: string[] } => {
    const alerts: string[] = [];
    return {
      root, env: {}, run: f.run, config: () => cfg(), killed: () => false, inQuiet: () => false,
      alert: async (t) => { alerts.push(t); return { ok: true }; }, now: () => T0, sleep, alerts, ...over,
    };
  };
  const addAt = (window: string, what: string, minutesAgo: number): string => {
    const r = addHandoff(root, { window, what, why: 'cap' }, new Date(T0 - minutesAgo * 60_000));
    if (!r.ok) throw new Error('add failed');
    return r.entry.id;
  };

  it('env parsing: default 120, clamp 15..1440, blank and junk give the default', () => {
    expect(handoffRemindEveryMin({})).toBe(120);
    expect(handoffRemindEveryMin({ HANDOFF_REMIND_EVERY_MIN: '' })).toBe(120);
    expect(handoffRemindEveryMin({ HANDOFF_REMIND_EVERY_MIN: '15' })).toBe(15);
    expect(handoffRemindEveryMin({ HANDOFF_REMIND_EVERY_MIN: '1440' })).toBe(1440);
    expect(handoffRemindEveryMin({ HANDOFF_REMIND_EVERY_MIN: '14' })).toBe(120);
    expect(handoffRemindEveryMin({ HANDOFF_REMIND_EVERY_MIN: '1441' })).toBe(120);
    expect(handoffRemindEveryMin({ HANDOFF_REMIND_EVERY_MIN: 'abc' })).toBe(120);
  });

  it('only entries older than 30 minutes are due', () => {
    const young = { id: 'h1', window: 'mail', what: 'a', why: 'b', since: new Date(T0 - 29 * 60_000).toISOString() };
    const old = { id: 'h2', window: 'mail', what: 'a', why: 'b', since: new Date(T0 - 31 * 60_000).toISOString() };
    expect(dueEntries([young, old], {}, T0, 120).map((e) => e.id)).toEqual(['h2']);
  });

  it('groups several entries into one notice and types a reminder into an idle worker window', async () => {
    const f = fake([{ name: 'mail' }, { name: 'boards' }]);
    addAt('mail', 'skipped: cold email 41', 90);
    addAt('mail', 'skipped: follow-up 7', 60);
    addAt('boards', 'skipped: naukri inbox', 45);
    addAt('mail', 'too young', 5);
    const d = mk(f);
    const r = await windowUpkeep(d);
    expect(d.alerts.length).toBe(1);
    expect(d.alerts[0]).toContain('3 pending items');
    expect(d.alerts[0]).toContain('cold email 41');
    expect(d.alerts[0]).not.toContain('too young');
    expect(r.reminded.length).toBe(3);
    expect(r.typed.sort()).toEqual(['boards', 'mail']);
    expect(f.typed.map((t) => t.window).sort()).toEqual(['boards', 'mail']);
    expect(f.typed.find((t) => t.window === 'mail')?.text).toContain('2 pending handoff items');
  });

  it('the handoff reminder is forced loud (silent: false)', async () => {
    const f = fake([{ name: 'mail' }]);
    addAt('mail', 'skipped: x', 90);
    const seen: Array<{ silent?: boolean } | undefined> = [];
    const d = mk(f, { alert: async (_t, o) => { seen.push(o); return { ok: true }; } });
    await windowUpkeep(d);
    expect(seen).toEqual([{ silent: false }]);
  });

  it('reminds each entry at most once per interval, then again after it', async () => {
    const f = fake([{ name: 'mail' }]);
    const id = addAt('mail', 'skipped: x', 90);
    let t = T0;
    const d = mk(f, { now: () => t });
    await windowUpkeep(d);
    expect(d.alerts.length).toBe(1);
    expect(readRemindState(root)[id]).toBeTruthy();
    t = T0 + 119 * 60_000;
    await windowUpkeep(d);
    expect(d.alerts.length).toBe(1);
    t = T0 + 121 * 60_000;
    await windowUpkeep(d);
    expect(d.alerts.length).toBe(2);
  });

  it('a failed Telegram send does not mark the entry, so it is retried', async () => {
    const f = fake([{ name: 'mail' }]);
    addAt('mail', 'skipped: x', 90);
    const d = mk(f, { alert: async () => ({ ok: false }) });
    await windowUpkeep(d);
    expect(readRemindState(root)).toEqual({});
    expect(f.typed).toEqual([]);
  });

  it('does not type into a busy window but still sends the notice', async () => {
    const f = fake([{ name: 'mail' }]);
    addAt('mail', 'skipped: x', 90);
    const lock = takeWindowLock(root, 'mail', 'dispatch:mail');
    const d = mk(f);
    const r = await windowUpkeep(d);
    lock?.release();
    expect(d.alerts.length).toBe(1);
    expect(r.typed).toEqual([]);
    expect(f.typed).toEqual([]);
  });

  it('does nothing on the kill switch, and holds the reminder in quiet hours', async () => {
    const f = fake([{ name: 'mail' }]);
    addAt('mail', 'skipped: x', 90);
    const k = mk(f, { killed: () => true });
    await windowUpkeep(k);
    expect(k.alerts).toEqual([]);
    const q = mk(f, { inQuiet: () => true });
    await windowUpkeep(q);
    expect(q.alerts).toEqual([]);
  });

  it('the notice text is shortened and lists at most 12 lines', () => {
    const long = 'w'.repeat(400);
    const es = Array.from({ length: 20 }, (_, i) => ({ id: `h${i}abc`, window: 'mail', what: long, why: long, since: new Date(T0 - 3 * HOUR).toISOString() }));
    const text = composeReminder(es, T0);
    expect(text.split('\n').filter((l) => l.startsWith('• ')).length).toBe(12);
    expect(text).toContain('and 8 more');
    expect(text).toContain('🔔 <b>Handoff: 20 pending items need attention</b>');
    expect(text).toContain('<b>mail:</b>');
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThan(160);
  });
});

describe('recycle', () => {
  const NOW = Date.parse('2026-11-04T12:00:00.000Z');
  const base = (f: Fake, over: Record<string, unknown> = {}) => ({ root, killed: () => false, now: () => NOW, claudeHome, startup: { sleep }, ...over });
  const old = (f: Fake, name: string, etime = '09:30:00'): void => {
    const w = f.wins.find((x) => x.name === name) as Win;
    f.etime[w.pid] = etime;
    w.activitySec = Math.floor(NOW / 1000) - 3600;
  };

  it('parses ps etime', () => {
    expect(parseEtime('05:10')).toBe(310_000);
    expect(parseEtime('02:05:10')).toBe(7_510_000);
    expect(parseEtime('1-02:05:10')).toBe(93_910_000);
    expect(parseEtime('junk')).toBeNull();
  });
  it('recycle hours: default 8, clamp 1..72', () => {
    expect(windowRecycleHours({})).toBe(8);
    expect(windowRecycleHours({ WINDOW_RECYCLE_HOURS: '1' })).toBe(1);
    expect(windowRecycleHours({ WINDOW_RECYCLE_HOURS: '72' })).toBe(72);
    expect(windowRecycleHours({ WINDOW_RECYCLE_HOURS: '0' })).toBe(8);
    expect(windowRecycleHours({ WINDOW_RECYCLE_HOURS: '73' })).toBe(8);
    expect(windowRecycleHours({ WINDOW_RECYCLE_HOURS: 'x' })).toBe(8);
  });
  it('an old and idle worker window is restarted and gets its startup line', async () => {
    const f = fake([{ name: 'boards' }], NOW);
    old(f, 'boards');
    const r = await recycleWindow(f.run, cfg(), {}, 'boards', base(f));
    expect(r).toMatchObject({ status: 'recycled', startup: 'typed' });
    expect((r as { ageMs: number }).ageMs).toBe(9.5 * HOUR);
    expect(f.calls.some((c) => c[1] === 'kill-window')).toBe(true);
    expect(f.typed).toEqual([{ window: 'boards', text: startupLine('boards') }]);
  });
  it('a young window is left alone; the per-window recycle_hours override wins over the env', async () => {
    const f = fake([{ name: 'boards' }, { name: 'mail' }], NOW);
    old(f, 'boards', '03:00:00');
    old(f, 'mail', '03:00:00');
    expect(await recycleWindow(f.run, cfg(), {}, 'boards', base(f))).toEqual({ status: 'skipped', reason: 'young' });
    expect(await recycleWindow(f.run, cfg(), { WINDOW_RECYCLE_HOURS: '1' }, 'boards', base(f))).toMatchObject({ status: 'recycled' });
    // mail has recycle_hours 2 in the fixture, so 3 hours is old even though the env says 72
    expect(await recycleWindow(f.run, cfg(), { WINDOW_RECYCLE_HOURS: '72' }, 'mail', base(f))).toMatchObject({ status: 'recycled' });
  });
  it('skips while the dispatcher lock is held', async () => {
    const f = fake([{ name: 'boards' }], NOW);
    old(f, 'boards');
    const lock = takeWindowLock(root, 'boards', 'dispatch:boards');
    expect(await recycleWindow(f.run, cfg(), {}, 'boards', base(f))).toEqual({ status: 'skipped', reason: 'busy' });
    lock?.release();
    expect(f.calls.some((c) => c[1] === 'kill-window')).toBe(false);
  });
  it('skips when the pane or the transcript was active in the last 5 minutes', async () => {
    const f = fake([{ name: 'boards' }], NOW);
    old(f, 'boards');
    f.wins[0].activitySec = Math.floor(NOW / 1000) - 120;
    expect(await recycleWindow(f.run, cfg(), {}, 'boards', base(f))).toEqual({ status: 'skipped', reason: 'active' });
    f.wins[0].activitySec = Math.floor(NOW / 1000) - 3600;
    writeWindowSession(root, 'boards', SID);
    const dir = projectTranscriptDir(root, claudeHome);
    mkdirSync(dir, { recursive: true });
    const tr = path.join(dir, `${SID}.jsonl`);
    writeFileSync(tr, '{}\n');
    utimesSync(tr, new Date(NOW - 60_000), new Date(NOW - 60_000));
    expect(await recycleWindow(f.run, cfg(), {}, 'boards', base(f))).toEqual({ status: 'skipped', reason: 'active' });
    utimesSync(tr, new Date(NOW - 3600_000), new Date(NOW - 3600_000));
    expect(await recycleWindow(f.run, cfg(), {}, 'boards', base(f))).toMatchObject({ status: 'recycled' });
  });
  it('never recycles bridge, scheduler, web or chat, nor an unlisted or non-worker window', async () => {
    const f = fake([{ name: 'bridge' }, { name: 'scheduler' }, { name: 'web' }, { name: 'chat' }, { name: 'plain' }, { name: 'ghost' }], NOW);
    for (const w of f.wins) f.etime[w.pid] = '99:00:00';
    for (const n of ['bridge', 'scheduler', 'web', 'chat']) {
      expect(await recycleWindow(f.run, cfg(), {}, n, base(f))).toEqual({ status: 'skipped', reason: 'never_recycled' });
    }
    expect(await recycleWindow(f.run, cfg(), {}, 'plain', base(f))).toEqual({ status: 'skipped', reason: 'not_recyclable' });
    expect(await recycleWindow(f.run, cfg(), {}, 'ghost', base(f))).toEqual({ status: 'skipped', reason: 'not_recyclable' });
    expect(f.calls.some((c) => c[1] === 'kill-window')).toBe(false);
  });
  it('does nothing on the kill switch, and skips a missing window or an unknown age', async () => {
    const f = fake([{ name: 'boards' }], NOW);
    old(f, 'boards');
    expect(await recycleWindow(f.run, cfg(), {}, 'boards', base(f, { killed: () => true }))).toEqual({ status: 'skipped', reason: 'killed' });
    expect(await recycleWindow(f.run, cfg(), {}, 'mail', base(f))).toEqual({ status: 'skipped', reason: 'absent' });
    f.etime = {};
    expect(await recycleWindow(f.run, cfg(), {}, 'boards', base(f))).toEqual({ status: 'skipped', reason: 'age_unknown' });
  });
  it('recycles the manager window too, through the manager launcher, and types its startup line', async () => {
    const f = fake([{ name: 'manager' }], NOW);
    old(f, 'manager');
    const r = await recycleWindow(f.run, cfg(), {}, 'manager', base(f));
    expect(r).toMatchObject({ status: 'recycled', startup: 'typed' });
    const nw = f.calls.find((c) => c[1] === 'new-window') as string[];
    expect(nw[nw.length - 1]).toContain('claude-session.sh');
    expect(f.typed).toEqual([{ window: 'manager', text: startupLine('manager') }]);
  });
  it('the upkeep tick sends one alert line per recycled window', async () => {
    const f = fake([{ name: 'boards' }], NOW);
    old(f, 'boards');
    const alerts: string[] = [];
    await windowUpkeep({
      root, env: {}, run: f.run, config: () => cfg(), killed: () => false, inQuiet: () => true,
      alert: async (t) => { alerts.push(t); return { ok: true }; }, now: () => NOW, sleep,
    });
    expect(alerts).toEqual(['✅ <b>Window recycled</b>\n<b>Window:</b> <code>boards</code>\n<b>Age:</b> 9h 30m']);
  });
});

describe('up and down with two worker windows', () => {
  const workers = { session: 'Jobber', protected: ['manager', 'bridge', 'chat'], windows: { mail: { kind: 'worker' }, boards: { kind: 'worker' } } };
  const sayInto = (out: string[]) => (l: string): void => void out.push(l);
  const stackDeps = (f: Fake, out: string[]) => ({
    root,
    env: { HOME: '/home/x', PATH: '/usr/bin', TERM: 'xterm', LANG: 'C', TZ: 'UTC' } as NodeJS.ProcessEnv,
    run: f.run,
    fs: { exists: (p: string) => existsSync(p), read: (p: string) => readFileSync(p, 'utf8') },
    now: () => new Date('2026-11-04T00:00:00Z'),
    doctor: async () => [],
    say: sayInto(out),
    sleep,
    probe: async () => true,
  });

  it('up starts both worker windows, types their startup lines, and lists them in the table', async () => {
    writeFileSync(path.join(root, 'config', 'manager-windows.json'), JSON.stringify(workers));
    writeFileSync(path.join(root, '.env'), 'TELEGRAM_BOT_TOKEN=tok-x\n');
    const f = fake([{ name: 'scheduler' }, { name: 'web' }, { name: 'bridge' }, { name: 'chat' }]);
    const out: string[] = [];
    expect(await runUp(stackDeps(f, out), { status: false })).toBe(0);
    expect(f.wins.map((w) => w.name)).toEqual(expect.arrayContaining(['mail', 'boards', 'manager']));
    const texts = f.typed.map((t) => `${t.window}:${t.text}`);
    expect(texts).toContain(`mail:${startupLine('mail')}`);
    expect(texts).toContain(`boards:${startupLine('boards')}`);
    expect(texts).toContain(`manager:${startupLine('manager')}`);
    const table = out.join('\n');
    expect(table).toMatch(/mail\s+running/);
    expect(table).toMatch(/boards\s+running/);
    expect(existsSync(handoffFile(root))).toBe(true);
    // a second up starts nothing and types nothing again
    f.calls.length = 0;
    f.typed.length = 0;
    expect(await runUp(stackDeps(f, []), { status: false })).toBe(0);
    expect(f.calls.some((c) => c[1] === 'new-window')).toBe(false);
    expect(f.typed).toEqual([]);
  });

  it('down stops the worker windows in reverse config order and never the manager', async () => {
    writeFileSync(path.join(root, 'config', 'manager-windows.json'), JSON.stringify(workers));
    const f = fake([{ name: 'manager' }, { name: 'mail' }, { name: 'boards' }]);
    const out: string[] = [];
    const d = { ...stackDeps(f, out), isTTY: false, ask: async () => false };
    expect(await runDown(d, { keepBridge: false, force: false, yes: true })).toBe(0);
    const kills = f.calls.filter((c) => c[1] === 'kill-window').map((c) => c[c.length - 1]);
    expect(kills).toEqual(['=Jobber:=boards', '=Jobber:=mail']);
    expect(f.wins.map((w) => w.name)).toEqual(['manager']);
  });

  it('down asks for confirmation without --yes and leaves the windows when not a terminal', async () => {
    writeFileSync(path.join(root, 'config', 'manager-windows.json'), JSON.stringify(workers));
    const f = fake([{ name: 'mail' }, { name: 'boards' }]);
    const out: string[] = [];
    const d = { ...stackDeps(f, out), isTTY: false, ask: async () => false };
    await runDown(d, { keepBridge: false, force: false, yes: false });
    expect(f.wins.map((w) => w.name)).toEqual(['mail', 'boards']);
    expect(out.join('\n')).toContain('pass --yes');
  });
});

describe('config catalog', () => {
  it('lists the two Phase 2 keys with their documented ranges', () => {
    const r = ENV_CATALOG.find((s) => s.key === 'WINDOW_RECYCLE_HOURS');
    const h = ENV_CATALOG.find((s) => s.key === 'HANDOFF_REMIND_EVERY_MIN');
    expect([r?.default, r?.min, r?.max]).toEqual(['8', 1, 72]);
    expect([h?.default, h?.min, h?.max]).toEqual(['120', 15, 1440]);
  });
  it('recycle_hours in a window entry is validated', () => {
    const mk = (v: unknown): string => JSON.stringify({ session: 'Jobber', protected: ['manager'], windows: { mail: { kind: 'worker', recycle_hours: v } } });
    expect(loadManagerConfig(mk(4)).windows.mail.recycle_hours).toBe(4);
    for (const bad of [0, 73, 1.5, '8']) expect(() => loadManagerConfig(mk(bad))).toThrow(/recycle_hours/);
  });
});
