// tests/platform-tmux.test.ts
import { describe, it, expect } from 'vitest';
import { assertClaudePane, assertName, capture, ensureSession, hasSession, killWindow, listWindows, newWindow, windowExists, sendText, validateSendText, type Run } from '../src/platform/tmux.js';

function fakeRun(responses: Record<string, { stdout?: string; code?: number }> = {}, callCodes: number[] = []) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    const idx = calls.length - 1;
    if (callCodes[idx] !== undefined) return { stdout: '', code: callCodes[idx] };
    const r = responses[args[0]] ?? {};
    return { stdout: r.stdout ?? '', code: r.code ?? 0 };
  };
  return { run, calls };
}

describe('assertName', () => {
  it('accepts normal names and rejects metacharacters and option-like values', () => {
    expect(() => assertName('ccgram-daemon')).not.toThrow();
    expect(() => assertName('hunt_1')).not.toThrow();
    for (const bad of ['', '-t', 'a b', 'a;b', 'a$(x)', 'a:b', 'x'.repeat(65), 'a.b', '.', '..']) {
      expect(() => assertName(bad)).toThrow();
    }
  });
});

describe('tmux helper', () => {
  it('hasSession reflects the exit code', async () => {
    expect(await hasSession(fakeRun({ 'has-session': { code: 0 } }).run, 's')).toBe(true);
    expect(await hasSession(fakeRun({ 'has-session': { code: 1 } }).run, 's')).toBe(false);
  });

  it('listWindows parses the format string', async () => {
    const { run, calls } = fakeRun({ 'list-windows': { stdout: '0|bot|1|python\n1|hunt|0|claude\n' } });
    const windows = await listWindows(run, 'ccgram');
    expect(windows).toEqual([
      { index: 0, name: 'bot', active: true, command: 'python' },
      { index: 1, name: 'hunt', active: false, command: 'claude' },
    ]);
    expect(calls[0].args).toContain('#{window_index}|#{window_name}|#{window_active}|#{pane_current_command}');
  });

  it('listWindows returns an empty list when the session is missing', async () => {
    expect(await listWindows(fakeRun({ 'list-windows': { code: 1 } }).run, 'nope')).toEqual([]);
  });

  it('ensureSession creates only when missing', async () => {
    const missing = fakeRun({ 'has-session': { code: 1 } });
    expect(await ensureSession(missing.run, 's', '/tmp/x')).toBe(true);
    expect(missing.calls.map((c) => c.args[0])).toEqual(['has-session', 'new-session']);
    const present = fakeRun({ 'has-session': { code: 0 } });
    expect(await ensureSession(present.run, 's', '/tmp/x')).toBe(false);
    expect(present.calls).toHaveLength(1);
  });

  it('capture uses exact-match targets and a valid line count', async () => {
    const { run, calls } = fakeRun({ 'capture-pane': { stdout: 'hello' } });
    expect(await capture(run, 'ccgram', 'hunt', 500)).toBe('hello');
    expect(calls[0].args).toEqual(['capture-pane', '-p', '-J', '-t', '=ccgram:=hunt', '-S', '-500']);
  });

  it('capture rejects invalid line counts without running', async () => {
    const { run, calls } = fakeRun();
    for (const bad of [NaN, 0, -1, 1.5, 501]) {
      await expect(capture(run, 's', 'w', bad)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it('uses exact-match session targets', async () => {
    const a = fakeRun();
    await hasSession(a.run, 'ccgram');
    expect(a.calls[0].args).toEqual(['has-session', '-t', '=ccgram']);
    const b = fakeRun();
    await listWindows(b.run, 'ccgram');
    expect(b.calls[0].args.slice(0, 3)).toEqual(['list-windows', '-t', '=ccgram']);
  });

  it('ensureSession throws when creation fails', async () => {
    const f = fakeRun({ 'has-session': { code: 1 }, 'new-session': { code: 1 } });
    await expect(ensureSession(f.run, 'sess', 'work')).rejects.toThrow('sess');
  });

  it('rejects bad names before running anything', async () => {
    const { run, calls } = fakeRun();
    await expect(capture(run, 'ok', '-t', 10)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('sendText', () => {
  it('sends literal text then Enter with exact argv', async () => {
    const { run, calls } = fakeRun();
    await sendText(run, 'ccgram', 'hunt', 'hello world');
    expect(calls).toEqual([
      { cmd: 'tmux', args: ['send-keys', '-t', '=ccgram:=hunt', '-l', '--', 'hello world'] },
      { cmd: 'tmux', args: ['send-keys', '-t', '=ccgram:=hunt', 'Enter'] },
    ]);
  });

  it('passes shell metacharacters as one literal argv element', async () => {
    for (const text of ['; rm -rf ~', '$(x)']) {
      const { run, calls } = fakeRun();
      await sendText(run, 's', 'w', text);
      expect(calls[0].args).toEqual(['send-keys', '-t', '=s:=w', '-l', '--', text]);
    }
  });

  it('rejects invalid text and names without running', async () => {
    const { run, calls } = fakeRun();
    for (const bad of ['', '   ', 'x'.repeat(2001), 'a\nb', 'a\x1bb', 'a\tb', '!ls']) {
      await expect(sendText(run, 's', 'w', bad)).rejects.toThrow();
    }
    await expect(sendText(run, 'bad name', 'w', 'hi')).rejects.toThrow();
    await expect(sendText(run, 's', '-t', 'hi')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects C1, separators, zero-width, bidi and whitespace-prefixed bang', async () => {
    const { run, calls } = fakeRun();
    const bads = ['a\x7fb', 'a\u0085b', 'a\u2028b', ' !ls', '\u00a0!ls', 'a\u200bb', 'a\u202eb', '\ufeff!x'];
    for (const bad of bads) {
      await expect(sendText(run, 's', 'w', bad)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it('validateSendText is exported and allows ordinary leading space', () => {
    expect(() => validateSendText(' hello')).not.toThrow();
    expect(() => validateSendText('')).toThrow();
    expect(() => validateSendText('  !ls')).toThrow();
    expect(() => validateSendText('  #note')).toThrow();
    expect(() => validateSendText('&bg')).toThrow();
    expect(() => validateSendText('a # b & c')).not.toThrow();
  });

  it('accepts exactly 2000 characters', async () => {
    const { run } = fakeRun();
    await expect(sendText(run, 's', 'w', 'x'.repeat(2000))).resolves.toBeUndefined();
  });

  it('throws without sending Enter when the literal call fails', async () => {
    const { run, calls } = fakeRun({}, [1]);
    await expect(sendText(run, 's', 'w', 'hi')).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('throws when the Enter call fails', async () => {
    const { run, calls } = fakeRun({}, [0, 1]);
    await expect(sendText(run, 's', 'w', 'hi')).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});

describe('assertClaudePane', () => {
  const list = (cmd: string) => fakeRun({ 'list-windows': { stdout: `0|hunt|1|${cmd}\n` } }).run;
  it('accepts claude, node and version-string commands', async () => {
    for (const c of ['claude', 'node', '2.1.9', '2.1.9-beta']) {
      await expect(assertClaudePane(list(c), 's', 'hunt')).resolves.toBeUndefined();
    }
  });
  it('rejects shells and a missing window', async () => {
    for (const c of ['bash', 'zsh', 'fish', '']) {
      await expect(assertClaudePane(list(c), 's', 'hunt')).rejects.toThrow();
    }
    await expect(assertClaudePane(list('claude'), 's', 'other')).rejects.toThrow('not found');
    await expect(assertClaudePane(fakeRun({ 'list-windows': { code: 1 } }).run, 's', 'hunt')).rejects.toThrow();
  });
});

describe('window helpers', () => {
  it('newWindow runs exact argv', async () => {
    const { run, calls } = fakeRun();
    await newWindow(run, 's', 'wake-abc', ['echo', 'hi there'], '/root');
    expect(calls).toEqual([
      { cmd: 'tmux', args: ['new-window', '-d', '-t', '=s:', '-n', 'wake-abc', '-c', '/root', '--', 'echo', 'hi there'] },
    ]);
  });
  it('newWindow rejects bad names and newline/NUL argv before any call', async () => {
    const { run, calls } = fakeRun();
    await expect(newWindow(run, 's', '-t', ['a'], '/r')).rejects.toThrow();
    await expect(newWindow(run, 'a b', 'w', ['a'], '/r')).rejects.toThrow();
    await expect(newWindow(run, 's', 'w', ['a\nb'], '/r')).rejects.toThrow();
    await expect(newWindow(run, 's', 'w', ['a\0b'], '/r')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('windowExists uses listWindows', async () => {
    const run = fakeRun({ 'list-windows': { stdout: '0|wake-abc|1|sh\n' } }).run;
    expect(await windowExists(run, 's', 'wake-abc')).toBe(true);
    expect(await windowExists(run, 's', 'other')).toBe(false);
  });
  it('killWindow is a no-op for a missing window and kills an existing one', async () => {
    const miss = fakeRun({ 'list-windows': { stdout: '' } });
    await killWindow(miss.run, 's', 'w');
    expect(miss.calls.map((c) => c.args[0])).toEqual(['list-windows']);
    const hit = fakeRun({ 'list-windows': { stdout: '0|w|1|sh\n' } });
    await killWindow(hit.run, 's', 'w');
    expect(hit.calls[1].args).toEqual(['kill-window', '-t', '=s:=w']);
  });
});
