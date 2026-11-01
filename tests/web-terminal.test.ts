import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../src/platform/tmux.js';
import { allowedTerminalSessions, keysToTmux, matchTerminalTarget, pickTerminalWindow, terminalKilled, terminalWindowTarget } from '../src/web/terminalRoutes.js';
import { clockTime, paneLooksCleared, stripAnsi, windowLabel } from '../apps/dashboard/src/lib/view-models.js';
import { makeHarness, type Harness } from './helpers/webHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

describe('terminal allowlist', () => {
  it('lists the chat session, ccgram, ccgram-daemon and the stack session once each', () => {
    expect(allowedTerminalSessions({}, 'ccgram')).toEqual(['ccgram', 'ccgram-daemon', 'jobber-stack']);
    expect(allowedTerminalSessions({ STACK_TMUX_SESSION: 'mystack' }, 'work')).toEqual(['work', 'ccgram', 'ccgram-daemon', 'mystack']);
  });
  it('drops invalid names', () => {
    expect(allowedTerminalSessions({ STACK_TMUX_SESSION: 'bad name;rm' }, 'ccgram')).toEqual(['ccgram', 'ccgram-daemon']);
  });
  it('matches only allowlisted sessions and valid window names', () => {
    const allow = ['ccgram', 'jobber-stack'];
    expect(matchTerminalTarget(allow, 'ccgram', 'hunt')).toEqual({ session: 'ccgram', window: 'hunt' });
    expect(matchTerminalTarget(allow, 'personal', 'hunt')).toBeNull();
    expect(matchTerminalTarget(allow, 'ccgram', '-x')).toBeNull();
    expect(matchTerminalTarget(allow, 'ccgram', 'a;b')).toBeNull();
    expect(matchTerminalTarget(allow, 'ccgram', 'a.b')).toBeNull();
    expect(matchTerminalTarget(allow, 'ccgram:', 'hunt')).toBeNull();
    expect(matchTerminalTarget(allow, 5, 'hunt')).toBeNull();
    expect(matchTerminalTarget(allow, 'ccgram', undefined)).toBeNull();
  });
  it('reads the kill switch from env and the STOP file', () => {
    const root = mkdtempSync(join(tmpdir(), 'term-kill-'));
    expect(terminalKilled(root, {})).toBe(false);
    expect(terminalKilled(root, { JOBBER_KILL: '1' })).toBe(true);
    mkdirSync(join(root, '.jobber'));
    writeFileSync(join(root, '.jobber', 'STOP'), '');
    expect(terminalKilled(root, {})).toBe(true);
  });
});

describe('window pick and pane hint helpers', () => {
  const wins = [{ name: 'zsh', index: 0 }, { name: 'zsh', index: 1 }, { name: 'hunt', index: 2 }];
  it('picks by index, by unique name, and refuses a stale or missing one', () => {
    expect(pickTerminalWindow(wins, 'zsh', '1')?.index).toBe(1);
    expect(pickTerminalWindow(wins, 'zsh', 0)?.index).toBe(0);
    expect(pickTerminalWindow(wins, 'hunt', null)?.index).toBe(2);
    expect(pickTerminalWindow(wins, 'zsh', null)?.index).toBe(0);
    expect(pickTerminalWindow(wins, 'hunt', '1')).toBeNull();
    expect(pickTerminalWindow(wins, 'zsh', '9')).toBeNull();
    expect(pickTerminalWindow(wins, 'zsh', 'x1')).toBeNull() ;
    expect(pickTerminalWindow(wins, 'nope', null)).toBeNull();
    expect(terminalWindowTarget('jb', 3)).toBe('=jb:3');
  });
  it('labels windows and formats the clock', () => {
    expect(windowLabel('jobber-stack', 0, 'zsh')).toBe('jobber-stack:0 zsh');
    expect(clockTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('03:04:05');
  });
  it('detects a cleared or idle pane but not real content', () => {
    expect(stripAnsi('\x1b[32mhi\x1b[0m')).toBe('hi');
    expect(paneLooksCleared('\n\n   \n')).toBe(true);
    expect(paneLooksCleared('\x1b[32m~/proj %\x1b[0m \n\n')).toBe(true);
    expect(paneLooksCleared('a\n~/proj %\n')).toBe(true);
    expect(paneLooksCleared('one\ntwo\nthree\n')).toBe(false);
    expect(paneLooksCleared(`${'x'.repeat(120)}\n`)).toBe(false);
  });
});

describe('keysToTmux', () => {
  it('sends printable text literally in one call', () => {
    expect(keysToTmux('ls -la')).toEqual([['-l', '--', 'ls -la']]);
  });
  it('maps control keys and arrows', () => {
    expect(keysToTmux('a\rb')).toEqual([['-l', '--', 'a'], ['Enter'], ['-l', '--', 'b']]);
    expect(keysToTmux('\x7f')).toEqual([['BSpace']]);
    expect(keysToTmux('\x03')).toEqual([['C-c']]);
    expect(keysToTmux('\x1b[A\x1b[D')).toEqual([['Up'], ['Left']]);
    expect(keysToTmux('\x1b[3~')).toEqual([['DC']]);
    expect(keysToTmux('\x1b')).toEqual([['Escape']]);
  });
  it('drops unknown control bytes and bidi marks, and caps the length', () => {
    expect(keysToTmux('a\x00b‮C')).toEqual([['-l', '--', 'abC']]);
    expect(keysToTmux('x'.repeat(1000))[0][2].length).toBe(256);
  });
});

function terminalRun(calls: string[][]): Run {
  return async (_cmd, args) => {
    calls.push(args);
    if (args[0] === '-V') return { stdout: 'tmux 3.4', code: 0 };
    if (args[0] === 'list-windows') return { stdout: '0|hunt|1|claude\n1|web|0|node\n', code: 0 };
    if (args[0] === 'capture-pane') return { stdout: '\x1b[32mhello\x1b[0m\nworld\n', code: 0 };
    if (args[0] === 'display-message') return { stdout: '80 24 5 1\n', code: 0 };
    if (args[0] === 'send-keys') return { stdout: '', code: 0 };
    return { stdout: '', code: 1 };
  };
}

async function authed(over: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness(over);
  const { cookie } = await h.login();
  const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
  return { h, cookie, csrf: s.csrf };
}

describe('terminal routes', () => {
  it('require the signed session cookie', async () => {
    h = await makeHarness();
    for (const [m, p] of [['GET', '/api/terminal/sessions'], ['GET', '/api/terminal/stream?session=ccgram&window=hunt'], ['POST', '/api/terminal/input']] as const) {
      const r = await h.call(m, p);
      expect(r.status, p).toBe(401);
    }
  });

  it('lists only allowlisted sessions', async () => {
    const calls: string[][] = [];
    const { h: hh, cookie } = await authed({ run: terminalRun(calls), terminal: { sessions: ['ccgram'], inputEnabled: false, killed: () => false } });
    const r = await hh.call('GET', '/api/terminal/sessions', { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.inputEnabled).toBe(false);
    expect(body.sessions.map((s: { session: string }) => s.session)).toEqual(['ccgram']);
    expect(body.sessions[0].windows.map((w: { name: string }) => w.name)).toEqual(['hunt', 'web']);
    // no other tmux session was ever queried
    expect(calls.filter((a) => a[0] === 'list-windows').every((a) => a.includes('=ccgram'))).toBe(true);
  });

  it('reports tmux as missing', async () => {
    const { h: hh, cookie } = await authed({ run: async () => ({ stdout: '', code: 1 }) });
    const body = JSON.parse((await hh.call('GET', '/api/terminal/sessions', { headers: { cookie } })).body);
    expect(body.tmux).toBe(false);
    const stream = await hh.call('GET', '/api/terminal/stream?session=ccgram&window=hunt', { headers: { cookie } });
    expect(stream.status).toBe(503);
  });

  it('refuses a session outside the allowlist or a window that does not exist', async () => {
    const calls: string[][] = [];
    const { h: hh, cookie } = await authed({ run: terminalRun(calls), terminal: { sessions: ['ccgram'], inputEnabled: false, killed: () => false } });
    const other = await hh.call('GET', '/api/terminal/stream?session=personal&window=hunt', { headers: { cookie } });
    expect(other.status).toBe(404);
    const gone = await hh.call('GET', '/api/terminal/stream?session=ccgram&window=nowindow', { headers: { cookie } });
    expect(gone.status).toBe(404);
    expect(calls.some((a) => a.includes('=personal') || a.includes('=personal:=hunt'))).toBe(false);
  });

  it('streams a frame with redacted pane text and never audits content', async () => {
    const run: Run = async (_c, args) => (args[0] === 'capture-pane' ? { stdout: 'token SECRET-XYZ-1234567890\n', code: 0 } : terminalRun([])(_c, args));
    const { h: hh, cookie } = await authed({ run, secrets: ['SECRET-XYZ-1234567890'], terminal: { sessions: ['ccgram'], inputEnabled: false, killed: () => false } });
    const text = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: hh.port, path: '/api/terminal/stream?session=ccgram&window=hunt', headers: { host: `127.0.0.1:${hh.port}`, cookie } }, (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        let buf = '';
        res.on('data', (c) => { buf += String(c); if (buf.includes('event: frame')) { req.destroy(); resolve(buf); } });
      });
      req.on('error', (e) => { if (!String(e).includes('socket hang up') && !String(e).includes('aborted')) reject(e); });
      setTimeout(() => { req.destroy(); reject(new Error('no frame')); }, 4000);
    });
    expect(text).toContain('event: hello');
    expect(text).toContain('"cols":80');
    expect(text).not.toContain('SECRET-XYZ');
    const kinds = hh.auth.prepare("SELECT kind, note FROM audit_log WHERE kind LIKE 'terminal%'").all() as { kind: string; note: string }[];
    expect(kinds).toEqual([{ kind: 'terminal_open', note: 'ccgram:0 hunt' }]);
    expect(text).toContain('"history":');
  });

  it('serves a redacted one-shot history for an allowlisted window and 404s otherwise', async () => {
    const calls: string[][] = [];
    const base = terminalRun(calls);
    const run: Run = async (c, args) => (args[0] === 'capture-pane' ? (calls.push(args), { stdout: 'old SECRET-XYZ-1234567890\nline2\n\n', code: 0 }) : base(c, args));
    const { h: hh, cookie } = await authed({ run, secrets: ['SECRET-XYZ-1234567890'], terminal: { sessions: ['ccgram'], inputEnabled: false, killed: () => false } });
    const noCookie = await hh.call('GET', '/api/terminal/history?session=ccgram&window=hunt');
    expect(noCookie.status).toBe(401);
    const ok = await hh.call('GET', '/api/terminal/history?session=ccgram&window=hunt', { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain('SECRET-XYZ');
    const got = JSON.parse(ok.body) as { text: string; lines: number };
    expect(got.lines).toBe(2);
    expect(got.text.startsWith('old ') && got.text.endsWith('\nline2')).toBe(true);
    expect(calls.find((a) => a[0] === 'capture-pane')).toEqual(['capture-pane', '-p', '-e', '-S', '-500', '-t', '=ccgram:0']);
    const other = await hh.call('GET', '/api/terminal/history?session=personal&window=hunt', { headers: { cookie } });
    expect(other.status).toBe(404);
    expect(calls.some((a) => a.includes('=personal:0'))).toBe(false);
    const stale = await hh.call('GET', '/api/terminal/history?session=ccgram&window=hunt&index=1', { headers: { cookie } });
    expect(stale.status).toBe(404);
    const audits = hh.auth.prepare("SELECT kind FROM audit_log WHERE kind LIKE 'terminal%'").all();
    expect(audits).toEqual([]);
  });

  it('reaches two windows with the same name by index', async () => {
    const calls: string[][] = [];
    const run: Run = async (c, args) => {
      if (args[0] === 'list-windows') return { stdout: '0|zsh|1|zsh\n1|zsh|0|zsh\n', code: 0 };
      return terminalRun(calls)(c, args);
    };
    const { h: hh, cookie, csrf } = await authed({ run, terminal: { sessions: ['ccgram'], inputEnabled: true, killed: () => false } });
    const headers = { cookie, origin: `http://127.0.0.1:${hh.port}`, 'content-type': 'application/json', 'x-csrf-token': csrf };
    for (const index of [0, 1]) {
      const r = await hh.call('POST', '/api/terminal/input', { headers, body: JSON.stringify({ session: 'ccgram', window: 'zsh', index, keys: 'a' }) });
      expect(r.status).toBe(200);
    }
    const noIndex = await hh.call('POST', '/api/terminal/input', { headers, body: JSON.stringify({ session: 'ccgram', window: 'zsh', keys: 'b' }) });
    expect(noIndex.status).toBe(200);
    const miss = await hh.call('POST', '/api/terminal/input', { headers, body: JSON.stringify({ session: 'ccgram', window: 'zsh', index: 5, keys: 'c' }) });
    expect(miss.status).toBe(404);
    expect(calls.filter((a) => a[0] === 'send-keys').map((a) => a[2])).toEqual(['=ccgram:0', '=ccgram:1', '=ccgram:0']);
  });

  it('lists windows with their index and pane size', async () => {
    const run: Run = async (c, args) => (args[0] === 'list-windows' && String(args[4]).includes('pane_width') ? { stdout: '0|120|30\n1|80|24\n', code: 0 } : terminalRun([])(c, args));
    const { h: hh, cookie } = await authed({ run, terminal: { sessions: ['ccgram'], inputEnabled: false, killed: () => false } });
    const body = JSON.parse((await hh.call('GET', '/api/terminal/sessions', { headers: { cookie } })).body);
    expect(body.sessions[0].windows.map((w: { index: number; cols: number; rows: number }) => [w.index, w.cols, w.rows])).toEqual([[0, 120, 30], [1, 80, 24]]);
  });

  it('input is refused while WEB_TERMINAL_INPUT is off', async () => {
    const calls: string[][] = [];
    const { h: hh, cookie, csrf } = await authed({ run: terminalRun(calls), terminal: { sessions: ['ccgram'], inputEnabled: false, killed: () => false } });
    const r = await hh.call('POST', '/api/terminal/input', {
      headers: { cookie, 'x-csrf-token': csrf, origin: `http://127.0.0.1:${hh.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'ccgram', window: 'hunt', keys: 'ls\r' }),
    });
    expect(r.status).toBe(403);
    expect(calls.some((a) => a[0] === 'send-keys')).toBe(false);
  });

  it('input needs CSRF, is limited to the allowlist and stops on the kill switch', async () => {
    const calls: string[][] = [];
    let killed = false;
    const { h: hh, cookie, csrf } = await authed({ run: terminalRun(calls), terminal: { sessions: ['ccgram'], inputEnabled: true, killed: () => killed } });
    const headers = { cookie, origin: `http://127.0.0.1:${hh.port}`, 'content-type': 'application/json' };
    const noCsrf = await hh.call('POST', '/api/terminal/input', { headers, body: JSON.stringify({ session: 'ccgram', window: 'hunt', keys: 'x' }) });
    expect(noCsrf.status).toBe(403);
    const bad = await hh.call('POST', '/api/terminal/input', { headers: { ...headers, 'x-csrf-token': csrf }, body: JSON.stringify({ session: 'personal', window: 'hunt', keys: 'x' }) });
    expect(bad.status).toBe(404);
    const ok = await hh.call('POST', '/api/terminal/input', { headers: { ...headers, 'x-csrf-token': csrf }, body: JSON.stringify({ session: 'ccgram', window: 'hunt', keys: 'ls\r' }) });
    expect(ok.status).toBe(200);
    expect(calls.filter((a) => a[0] === 'send-keys').map((a) => a.slice(1))).toEqual([['-t', '=ccgram:0', '-l', '--', 'ls'], ['-t', '=ccgram:0', 'Enter']]);
    killed = true;
    const dead = await hh.call('POST', '/api/terminal/input', { headers: { ...headers, 'x-csrf-token': csrf }, body: JSON.stringify({ session: 'ccgram', window: 'hunt', keys: 'x' }) });
    expect(dead.status).toBe(423);
    const audits = hh.auth.prepare("SELECT kind, note FROM audit_log WHERE kind = 'terminal_input'").all() as { note: string }[];
    expect(JSON.stringify(audits)).not.toContain('ls');
  });
});
