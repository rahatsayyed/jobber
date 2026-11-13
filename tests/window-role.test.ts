// Role survives /clear (role file as appended system prompt), visible window state in tmux, and the idle restart of windows with an old role.
// Fakes only: fake tmux, temp root, in-memory db.
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { loadManagerConfig } from '../src/platform/manager.js';
import { setWindowState, type Run } from '../src/platform/tmux.js';
import { acquireLock } from '../src/platform/lock.js';
import { recordedRoleHash, roleHash, roleIsStale, ROLE_START_VERSION } from '../src/platform/windowRole.js';
import { projectTranscriptDir, transcriptFile, writeWindowSession } from '../src/platform/windowSession.js';
import { WindowDispatcher } from '../src/scheduler/windowDispatch.js';
import { recycleStaleRoleWindow } from '../src/stack/stale.js';

const REPO = path.resolve(import.meta.dirname, '..');
const SID = '11111111-2222-4333-8444-555555555555';
let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'win-role-'));
  home = mkdtempSync(path.join(tmpdir(), 'win-role-home-'));
  mkdirSync(path.join(root, 'config', 'windows'), { recursive: true });
  copyFileSync(path.join(REPO, 'config', 'manager-windows.json'), path.join(root, 'config', 'manager-windows.json'));
  writeFileSync(path.join(root, 'config', 'windows', 'mail.md'), '# Role of the mail window\nSend one email per item.\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const writeRecord = (hash: string | null): void => {
  mkdirSync(path.join(root, '.jobber', 'window-start'), { recursive: true });
  writeFileSync(path.join(root, '.jobber', 'window-start', 'mail.json'), JSON.stringify(hash === null ? { at: 'x' } : { role_hash: hash }));
};

describe('launcher', () => {
  it('starts claude with the role file as an appended system prompt, and the role files are short', () => {
    const sh = readFileSync(path.join(REPO, 'scripts', 'claude-window.sh'), 'utf8');
    expect(sh).toContain('--append-system-prompt');
    expect(sh).toContain('config/windows/$WINDOW.md');
    for (const w of ['mail', 'linkedin', 'boards', 'sources', 'pipeline', 'apply']) {
      expect(readFileSync(path.join(REPO, 'config', 'windows', `${w}.md`), 'utf8').length).toBeLessThan(4000);
    }
  });
});

describe('role hash', () => {
  it('is stable, changes with the text, is null without a role file', () => {
    const a = roleHash(root, 'mail');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(roleHash(root, 'mail')).toBe(a);
    writeFileSync(path.join(root, 'config', 'windows', 'mail.md'), '# changed\n');
    expect(roleHash(root, 'mail')).not.toBe(a);
    expect(roleHash(root, 'linkedin')).toBeNull();
    expect(ROLE_START_VERSION).toBeGreaterThan(0);
  });

  it('a window is stale when the record has no hash or another hash, current when equal, never stale without a role file', () => {
    writeRecord(null);
    expect(roleIsStale(root, 'mail')).toBe(true);
    writeRecord('0000000000000000');
    expect(roleIsStale(root, 'mail')).toBe(true);
    writeRecord(roleHash(root, 'mail'));
    expect(recordedRoleHash(root, 'mail')).toBe(roleHash(root, 'mail'));
    expect(roleIsStale(root, 'mail')).toBe(false);
    expect(roleIsStale(root, 'linkedin')).toBe(false);
  });
});

describe('setWindowState', () => {
  it('sets the user option and the formats on init, only the option afterwards, and sanitizes the text', async () => {
    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { stdout: '', code: 0 }; };
    expect(await setWindowState(run, 'Jobber', 'mail', 'working: mail_drip;`x`', true)).toBe(true);
    expect(calls[0]).toEqual(['set-option', '-w', '-t', '=Jobber:=mail', '@jobber_state', 'working: mail_dripx']);
    expect(calls.some((c) => c.includes('pane-border-status'))).toBe(true);
    expect(calls.some((c) => c.includes('pane-border-format'))).toBe(true);
    calls.length = 0;
    await setWindowState(run, 'Jobber', 'mail', 'waiting for work', false);
    expect(calls).toHaveLength(1);
  });

  it('is best effort: a failing or throwing tmux returns false and never throws', async () => {
    expect(await setWindowState(async () => ({ stdout: '', code: 1 }), 'Jobber', 'mail', 'x')).toBe(false);
    expect(await setWindowState(async () => { throw new Error('boom'); }, 'Jobber', 'mail', 'x')).toBe(false);
    expect(await setWindowState(async () => ({ stdout: '', code: 0 }), 'Jobber', 'bad.name', 'x')).toBe(false);
  });
});

describe('dispatcher shows the state', () => {
  it('working while an item runs, waiting for work after the clear, and a failing tmux option never fails the item', async () => {
    for (const failOptions of [false, true]) {
      const dir = projectTranscriptDir(root, home);
      mkdirSync(dir, { recursive: true });
      const file = transcriptFile(dir, SID);
      writeFileSync(file, '');
      writeWindowSession(root, 'mail', SID);
      const calls: string[][] = [];
      const run: Run = async (_c, args) => {
        calls.push(args);
        if (args[0] === 'list-windows') return { stdout: '0|mail|0|claude', code: 0 };
        if (args[0] === 'capture-pane') return { stdout: '', code: 0 };
        if (args[0] === 'set-option') return { stdout: '', code: failOptions ? 1 : 0 };
        return { stdout: '', code: 0 };
      };
      let n = 0;
      const d = new WindowDispatcher({
        root, session: 'Jobber', run, db: openDb(':memory:'), killed: () => false, claudeHome: home, pollMs: 1, settleMs: 1,
        sleep: async () => {
          n++;
          if (n === 1) appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } })}\n`);
        },
      });
      const r = await d.dispatch({ window: 'mail', lane: 'mail_drip', trigger: 'mail_drip', item: {}, promptText: 'do it', deadlineMs: 600_000 });
      expect(r.status).toBe('ok');
      await d.finish(r.runId as string);
      const states = calls.filter((c) => c[0] === 'set-option' && c.includes('@jobber_state')).map((c) => c[c.length - 1]);
      expect(states).toEqual(['working: mail_drip', 'waiting for work']);
      // the first state call carries the formats, the second does not
      expect(calls.filter((c) => c.includes('pane-border-format'))).toHaveLength(failOptions ? 2 : 1);
      rmSync(file);
    }
  });
});

describe('stale role restart', () => {
  const cfg = (): ReturnType<typeof loadManagerConfig> => loadManagerConfig(readFileSync(path.join(root, 'config', 'manager-windows.json'), 'utf8'));
  const fake = (activitySecAgo: number) => {
    const calls: string[][] = [];
    const run: Run = async (_c, args) => {
      calls.push(args);
      if (args[0] === 'list-windows') {
        const killed = calls.some((c) => c[0] === 'kill-window') && !calls.some((c) => c[0] === 'new-window');
        return { stdout: killed ? '' : '0|mail|0|claude', code: 0 };
      }
      if (args[0] === 'display-message') {
        if (args[args.length - 1] === '#{window_activity}') return { stdout: String(Math.floor(Date.now() / 1000) - activitySecAgo), code: 0 };
        return { stdout: '', code: 1 };
      }
      return { stdout: '', code: 0 };
    };
    return { run, calls };
  };
  const dep = { get root() { return root; }, killed: () => false, claudeHome: '' };

  it('restarts an idle window whose role hash is old, with a fresh launcher start', async () => {
    writeRecord(null);
    const f = fake(3600);
    const r = await recycleStaleRoleWindow(f.run, cfg(), {}, 'mail', { ...dep, claudeHome: home, startup: { tries: 1, intervalMs: 1, sleep: async () => undefined } });
    expect(r.status).toBe('restarted');
    expect(f.calls.some((c) => c[0] === 'kill-window')).toBe(true);
    expect(f.calls.find((c) => c[0] === 'new-window')?.join(' ')).toContain('claude-window.sh');
  });

  it('never touches a busy window (lock held, or recent activity), a current role, the kill switch or a non-worker', async () => {
    writeRecord(null);
    const lock = acquireLock(path.join(root, '.jobber'), 'win-mail', 'test', undefined, { ttlMs: 600_000 });
    expect((await recycleStaleRoleWindow(fake(3600).run, cfg(), {}, 'mail', { ...dep, claudeHome: home })).status).toBe('skipped');
    lock?.release();
    const recent = fake(10);
    const r2 = await recycleStaleRoleWindow(recent.run, cfg(), {}, 'mail', { ...dep, claudeHome: home });
    expect(r2).toEqual({ status: 'skipped', reason: 'active' });
    expect(recent.calls.some((c) => c[0] === 'kill-window')).toBe(false);
    expect(await recycleStaleRoleWindow(fake(3600).run, cfg(), {}, 'mail', { ...dep, claudeHome: home, killed: () => true })).toEqual({ status: 'skipped', reason: 'killed' });
    writeRecord(roleHash(root, 'mail'));
    expect(await recycleStaleRoleWindow(fake(3600).run, cfg(), {}, 'mail', { ...dep, claudeHome: home })).toEqual({ status: 'skipped', reason: 'role_current' });
    expect((await recycleStaleRoleWindow(fake(3600).run, cfg(), {}, 'scheduler', { ...dep, claudeHome: home })).status).toBe('skipped');
  });
});
