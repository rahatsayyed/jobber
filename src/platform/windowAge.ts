// src/platform/windowAge.ts
// How old a tmux window is and when it last did anything, for the recycle tick.
// Age: the elapsed time of the pane's process (`ps -o etime= -p <pane_pid>`); the pane runs the launcher script for as
// long as the window lives, so this is the window age (works for `manager` too, which has no session record).
// Activity: tmux `#{window_activity}` (epoch seconds of the last output in the window). Both are read-only tmux/ps calls.
import { assertName, type Run } from './tmux.js';

/** ps etime: `[[dd-]hh:]mm:ss` to milliseconds; null when it does not parse. */
export function parseEtime(text: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (!m) return null;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
  return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

export async function windowAgeMs(run: Run, session: string, window: string): Promise<number | null> {
  assertName(session);
  assertName(window);
  const pid = await run('tmux', ['display-message', '-p', '-t', `=${session}:=${window}`, '#{pane_pid}']);
  const n = pid.code === 0 ? pid.stdout.trim() : '';
  if (!/^\d{1,9}$/.test(n)) return null;
  const ps = await run('ps', ['-o', 'etime=', '-p', n]);
  return ps.code === 0 ? parseEtime(ps.stdout) : null;
}

/** Epoch ms of the last output in the window, or null when tmux does not say. */
export async function windowActivityMs(run: Run, session: string, window: string): Promise<number | null> {
  assertName(session);
  assertName(window);
  const r = await run('tmux', ['display-message', '-p', '-t', `=${session}:=${window}`, '#{window_activity}']);
  const n = r.code === 0 ? r.stdout.trim() : '';
  return /^\d{9,12}$/.test(n) ? Number(n) * 1000 : null;
}
