// Windows are the only path: a missing window is started through the manager path before an item is typed; if it cannot be used, the item is
// skipped (nothing runs elsewhere) with a handoff entry and at most one loud alert per hour. Fakes only: fake tmux, temp root, in-memory db.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { listHandoff } from '../src/platform/handoff.js';
import type { Run } from '../src/platform/tmux.js';
import { killLegacyWindows, makeEnsureReady, noteWindowUnavailable } from '../src/scheduler/windowReady.js';
import { WindowDispatcher } from '../src/scheduler/windowDispatch.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'win-ready-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  copyFileSync(path.join(ROOT, 'config', 'manager-windows.json'), path.join(root, 'config', 'manager-windows.json'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const sleep = async (): Promise<void> => undefined;

/** A fake tmux: windows by name; new-window adds one running `claude` unless `neverClaude`; send-keys is recorded. */
function fakeTmux(initial: Array<{ name: string; command: string }>, o: { neverClaude?: boolean; failNew?: boolean } = {}) {
  const wins = [...initial];
  const calls: string[][] = [];
  const run: Run = async (_c, args) => {
    calls.push(args);
    switch (args[0]) {
      case 'has-session': return { stdout: '', code: 0 };
      case 'list-windows': return { stdout: wins.map((w, i) => `${i}|${w.name}|0|${w.command}`).join('\n'), code: 0 };
      case 'new-window':
        if (o.failNew) return { stdout: '', code: 1 };
        wins.push({ name: args[args.indexOf('-n') + 1], command: o.neverClaude ? 'zsh' : 'claude' });
        return { stdout: '', code: 0 };
      case 'kill-window': {
        const n = (args[args.indexOf('-t') + 1] ?? '').split('=').pop();
        const i = wins.findIndex((w) => w.name === n);
        if (i >= 0) wins.splice(i, 1);
        return { stdout: '', code: 0 };
      }
      default: return { stdout: '', code: 0 };
    }
  };
  return { run, calls, wins };
}

describe('makeEnsureReady', () => {
  it('starts a missing worker window through the manager path (the launcher script) and reports ready', async () => {
    const t = fakeTmux([]);
    const ready = makeEnsureReady({ root, env: {}, run: t.run, tries: 3, sleep });
    expect(await ready('mail')).toBe('ready');
    const nw = t.calls.find((c) => c[0] === 'new-window') ?? [];
    expect(nw.join(' ')).toContain('claude-window.sh');
    expect(t.wins.map((w) => w.name)).toEqual(['mail']);
    // already running: no second window
    expect(await ready('mail')).toBe('ready');
    expect(t.calls.filter((c) => c[0] === 'new-window')).toHaveLength(1);
  });

  it('refuses a window that is not a worker of the config, and reports a start that fails or never shows claude (bounded)', async () => {
    expect(await makeEnsureReady({ root, env: {}, run: fakeTmux([]).run, tries: 2, sleep })('bridge')).toBe('not_a_worker');
    expect(await makeEnsureReady({ root, env: {}, run: fakeTmux([], { failNew: true }).run, tries: 2, sleep })('mail')).toBe('start_failed');
    expect(await makeEnsureReady({ root, env: {}, run: fakeTmux([], { neverClaude: true }).run, tries: 2, sleep })('mail')).toBe('not_ready');
  });
});

describe('dispatcher with ensureReady', () => {
  const mk = (t: ReturnType<typeof fakeTmux>, ensureReady?: (w: string) => Promise<string>) =>
    new WindowDispatcher({ root, session: 'Jobber', run: t.run, db: openDb(':memory:'), killed: () => false, sleep, ensureReady });
  const input = { window: 'mail', lane: 'mail', trigger: 'mail_drip', item: {}, promptText: 'do one thing', deadlineMs: 5000 };

  it('without ensureReady a missing window is refused as window_unavailable and nothing is typed', async () => {
    const t = fakeTmux([]);
    const r = await mk(t).dispatch(input);
    expect(r).toMatchObject({ status: 'unavailable', stopReason: 'window_unavailable:window_missing' });
    expect(t.calls.some((c) => c[0] === 'send-keys')).toBe(false);
  });

  it('a failed start refuses the item (still nothing typed); a not-claude pane too', async () => {
    const t = fakeTmux([{ name: 'mail', command: 'zsh' }]);
    const r = await mk(t, async () => 'not_ready').dispatch(input);
    expect(r).toMatchObject({ status: 'unavailable' });
    expect(r.stopReason).toMatch(/^window_unavailable:not_claude:not_ready/);
    expect(t.calls.some((c) => c[0] === 'send-keys')).toBe(false);
  });
});

describe('noteWindowUnavailable', () => {
  it('writes a handoff entry (once per pending item text) and sends at most one loud alert per hour per window', async () => {
    const db = openDb(':memory:');
    let t = Date.parse('2026-11-06T10:00:00Z');
    const posts: Array<{ topic: string; text: string; silent?: boolean }> = [];
    const d = { db, projectRoot: root, now: () => new Date(t), tg: async (topic: string, text: string, opts?: { silent?: boolean }) => void posts.push({ topic, text, silent: opts?.silent }) };
    await noteWindowUnavailable(d as never, 'mail', 'mail cold:1 (job j)', 'window_unavailable:window_missing:not_ready');
    await noteWindowUnavailable(d as never, 'mail', 'mail cold:1 (job j)', 'window_unavailable:window_missing:not_ready');
    expect(listHandoff(root).filter((e) => e.window === 'mail')).toHaveLength(1);
    expect(posts.filter((p) => p.topic === 'alerts')).toHaveLength(1);
    t += 30 * 60_000;
    await noteWindowUnavailable(d as never, 'mail', 'mail cold:2 (job k)', 'window_unavailable:window_missing:not_ready');
    expect(posts).toHaveLength(1);
    t += 40 * 60_000;
    await noteWindowUnavailable(d as never, 'mail', 'mail cold:3 (job m)', 'window_unavailable:window_missing:not_ready');
    expect(posts).toHaveLength(2);
    // another window has its own hour
    await noteWindowUnavailable(d as never, 'linkedin', 'linkedin inbox', 'window_unavailable:window_missing:not_ready');
    expect(posts).toHaveLength(3);
  });
});

describe('killLegacyWindows', () => {
  it('kills only leftover wake-* and drip-* windows, never a worker window', async () => {
    const t = fakeTmux([{ name: 'wake-abc', command: 'claude' }, { name: 'drip-mail-1', command: 'claude' }, { name: 'mail', command: 'claude' }, { name: 'scheduler', command: 'node' }]);
    const killed = await killLegacyWindows(t.run, 'Jobber');
    expect(killed.sort()).toEqual(['drip-mail-1', 'wake-abc']);
    expect(t.wins.map((w) => w.name)).toEqual(['mail', 'scheduler']);
  });
});
