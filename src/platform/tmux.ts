// src/platform/tmux.ts
import { execFile } from 'node:child_process';

export type Run = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<{ stdout: string; code: number; stderr?: string }>;

export const defaultRun: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
        timeout: opts?.timeoutMs ?? 10_000,
        maxBuffer: opts?.timeoutMs ? 10_000_000 : 1_000_000,
      },
      (err, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ''), code: err ? 1 : 0, stderr: String(stderr ?? '') });
      },
    );
    if (opts?.input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.input);
    }
  });

// The one tmux session every Jobber process (scheduler, web, bridge, run windows) lives in. Each env key below defaults to it.
export const JOBBER_TMUX_SESSION = 'Jobber';

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
  const head = text.trimStart()[0];
  if (head === '!' || head === '#' || head === '&') throw new Error(`text must not start with ${head}`);
}

const CLAUDE_COMMAND_RE = /^(claude|node|\d+\.\d+\.\d+.*)$/;

/** Fail closed unless the named window is running Claude (never type into a shell). */
export async function assertClaudePane(run: Run, session: string, window: string): Promise<void> {
  assertName(session);
  assertName(window);
  const w = (await listWindows(run, session)).find((x) => x.name === window);
  if (!w) throw new Error('tmux window not found');
  if (!CLAUDE_COMMAND_RE.test(w.command)) throw new Error('tmux window is not running claude');
}

const nap = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
/** Real delays outside the tests (the unit tests drive a fake tmux and must not wait). */
const ENTER_DELAY_MS = process.env.VITEST !== undefined ? 0 : 250;
const VERIFY_WAIT_MS = process.env.VITEST !== undefined ? 0 : 1000;
const RULE_RE = /^[\s]*[─━-]{20,}\s*$/;

/**
 * True when `needle` is still sitting in the input box of a claude pane: the box is the area between the LAST two horizontal rules
 * (a submitted prompt is echoed higher up with the same "❯" mark, so the mark alone proves nothing). Pane unreadable or no box: false.
 */
export function textStillInInputBox(pane: string, needle: string): boolean {
  const n = needle.trim().slice(0, 40);
  if (n === '') return false;
  const lines = pane.split('\n');
  const rules: number[] = [];
  lines.forEach((l, i) => { if (RULE_RE.test(l)) rules.push(i); });
  if (rules.length < 2) return false;
  const box = lines.slice((rules[rules.length - 2] as number) + 1, rules[rules.length - 1] as number).join('\n');
  return box.includes(n);
}

export async function sendText(run: Run, session: string, window: string, text: string): Promise<void> {
  assertName(session);
  assertName(window);
  validateSendText(text);
  const target = `=${session}:=${window}`;
  const lit = await run('tmux', ['send-keys', '-t', target, '-l', '--', text]);
  if (lit.code !== 0) throw new Error('tmux send-keys failed');
  // Enter as its own key a moment after the text, so the TUI has taken the text in before it is asked to submit.
  await nap(ENTER_DELAY_MS);
  const enter = await run('tmux', ['send-keys', '-t', target, 'Enter']);
  if (enter.code !== 0) throw new Error('tmux send-keys Enter failed');
  // Verify: a line that is still in the input box was not submitted (a swallowed Enter, an autocomplete menu). Press Enter again, up to 3 times.
  for (let k = 0; k < 3; k++) {
    await nap(VERIFY_WAIT_MS);
    let pane = '';
    try {
      const cap = await run('tmux', ['capture-pane', '-p', '-J', '-t', target, '-S', '-15']);
      pane = cap.code === 0 ? cap.stdout : '';
    } catch { pane = ''; }
    if (!textStillInInputBox(pane, text)) return;
    const again = await run('tmux', ['send-keys', '-t', target, 'Enter']);
    if (again.code !== 0) return;
  }
}

function assertArgv(argv: string[]): void {
  if (argv.length === 0) throw new Error('empty argv');
  for (const a of argv) {
    if (typeof a !== 'string' || a.includes('\n') || a.includes('\r') || a.includes('\0')) {
      throw new Error('argv element contains newline or NUL');
    }
  }
}

/** Create a detached window running argv directly (tmux 3.2+ executes argv without a shell). */
export async function newWindow(run: Run, session: string, window: string, argv: string[], cwd: string): Promise<void> {
  assertName(session);
  assertName(window);
  assertArgv(argv);
  const r = await run('tmux', ['new-window', '-d', '-t', `=${session}:`, '-n', window, '-c', cwd, '--', ...argv]);
  if (r.code !== 0) throw new Error(`failed to create tmux window ${window}`);
}

export async function windowExists(run: Run, session: string, window: string): Promise<boolean> {
  assertName(session);
  assertName(window);
  return (await listWindows(run, session)).some((w) => w.name === window);
}

/** Best-effort: a missing window is a no-op. */
export async function killWindow(run: Run, session: string, window: string): Promise<void> {
  assertName(session);
  assertName(window);
  if (!(await windowExists(run, session, window))) return;
  await run('tmux', ['kill-window', '-t', `=${session}:=${window}`]);
}
