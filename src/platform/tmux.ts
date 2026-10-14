// src/platform/tmux.ts
import { execFile } from 'node:child_process';

export type Run = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; code: number }>;

export const defaultRun: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, timeout: 10_000, maxBuffer: 1_000_000 }, (err, stdout) => {
      resolve({ stdout: String(stdout ?? ''), code: err ? 1 : 0 });
    });
  });

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function assertName(name: string): void {
  if (!NAME_RE.test(name) || name.startsWith('-') || name.includes('.')) throw new Error(`invalid tmux name: ${JSON.stringify(name)}`);
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  command: string;
}

export async function hasSession(run: Run, session: string): Promise<boolean> {
  assertName(session);
  return (await run('tmux', ['has-session', '-t', `=${session}`])).code === 0;
}

export async function listWindows(run: Run, session: string): Promise<TmuxWindow[]> {
  assertName(session);
  const r = await run('tmux', [
    'list-windows',
    '-t',
    `=${session}`,
    '-F',
    '#{window_index}|#{window_name}|#{window_active}|#{pane_current_command}',
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [index, name, active, command] = line.split('|');
      return { index: Number(index), name, active: active === '1', command: command ?? '' };
    });
}

export async function ensureSession(run: Run, session: string, cwd: string): Promise<boolean> {
  assertName(session);
  if (await hasSession(run, session)) return false;
  const r = await run('tmux', ['new-session', '-d', '-s', session, '-c', cwd]);
  if (r.code !== 0) throw new Error(`failed to create tmux session ${session}`);
  return true;
}

export async function capture(run: Run, session: string, window: string, lines = 40): Promise<string> {
  assertName(session);
  assertName(window);
  if (!Number.isInteger(lines) || lines < 1 || lines > 500) {
    throw new Error(`invalid capture line count: ${String(lines)}`);
  }
  const r = await run('tmux', ['capture-pane', '-p', '-J', '-t', `=${session}:=${window}`, '-S', `-${lines}`]);
  return r.stdout;
}

export function validateSendText(text: string): void {
  if (text.trim().length === 0) throw new Error('empty text');
  if (text.length > 2000) throw new Error('text too long');
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    const bad =
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff;
    if (bad) throw new Error('text contains control characters');
  }
  if (text.trimStart().startsWith('!')) throw new Error('text must not start with !');
}

export async function sendText(run: Run, session: string, window: string, text: string): Promise<void> {
  assertName(session);
  assertName(window);
  validateSendText(text);
  const target = `=${session}:=${window}`;
  const lit = await run('tmux', ['send-keys', '-t', target, '-l', '--', text]);
  if (lit.code !== 0) throw new Error('tmux send-keys failed');
  const enter = await run('tmux', ['send-keys', '-t', target, 'Enter']);
  if (enter.code !== 0) throw new Error('tmux send-keys Enter failed');
}
