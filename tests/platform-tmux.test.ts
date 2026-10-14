// tests/platform-tmux.test.ts
import { describe, it, expect } from 'vitest';
import { assertName, capture, ensureSession, hasSession, listWindows, type Run } from '../src/platform/tmux.js';

function fakeRun(responses: Record<string, { stdout?: string; code?: number }> = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses[args[0]] ?? {};
    return { stdout: r.stdout ?? '', code: r.code ?? 0 };
  };
  return { run, calls };
}

describe('assertName', () => {
  it('accepts normal names and rejects metacharacters and option-like values', () => {
    expect(() => assertName('ccgram-daemon')).not.toThrow();
    for (const bad of ['', '-t', 'a b', 'a;b', 'a$(x)', 'a:b', 'x'.repeat(65)]) {
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

  it('capture clamps the line count and targets session:window', async () => {
    const { run, calls } = fakeRun({ 'capture-pane': { stdout: 'hello' } });
    expect(await capture(run, 'ccgram', 'hunt', 100000)).toBe('hello');
    expect(calls[0].args).toEqual(['capture-pane', '-p', '-t', 'ccgram:hunt', '-S', '-500']);
  });

  it('rejects bad names before running anything', async () => {
    const { run, calls } = fakeRun();
    await expect(capture(run, 'ok', '-t', 10)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
