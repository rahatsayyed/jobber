// src/platform/windowSession.ts
// The session record of a worker window: `.jobber/sessions/<window>.json` (0600, atomic write, ids only). Same idea as
// the chat window's `.jobber/chat-session.json` (src/telegram/chatwin/session.ts, which stays as it is), generalised to
// any window name. The launcher starts claude with `--session-id <uuid>` and the id is recorded BEFORE the window starts;
// Claude Code writes the transcript to <claude home>/projects/<encoded project dir>/<id>.jsonl. After `/clear` the id is
// stale and the file is found again from the text that was typed (findTranscriptByTypedText).
// The `--session-id` flag and the first-positional-prompt behaviour are UNVERIFIED against the installed claude, so the
// startup line is TYPED with sendText by default (typeStartupLine); a positional prompt works too if a caller passes one.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  claudeHomeDir, findTranscriptByTypedText, projectTranscriptDir, sessionIdOfFile, transcriptFile,
} from '../telegram/chatwin/session.js';
import { startupLine } from './handoff.js';
import { SESSION_ID_RE } from './runner.js';
import { assertClaudePane, assertName, sendText, type Run } from './tmux.js';
import { WORKER_LAUNCHER } from './windowConfig.js';

export { claudeHomeDir, findTranscriptByTypedText, projectTranscriptDir, sessionIdOfFile, transcriptFile };

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const windowSessionFile = (root: string, window: string): string => {
  assertName(window);
  return path.join(root, '.jobber', 'sessions', `${window}.json`);
};

export interface WindowSessionRecord {
  session_id: string;
  started_at: string;
  /** Set by the manager `clear` command when it could not find the new transcript: the next dispatch finds it by the typed text. */
  stale?: boolean;
}

export function readWindowSession(root: string, window: string): WindowSessionRecord | null {
  try {
    const j = JSON.parse(readFileSync(windowSessionFile(root, window), 'utf8')) as Partial<WindowSessionRecord>;
    if (typeof j.session_id !== 'string' || !SESSION_ID_RE.test(j.session_id)) return null;
    return {
      session_id: j.session_id,
      started_at: typeof j.started_at === 'string' ? j.started_at : '',
      ...(j.stale === true ? { stale: true } : {}),
    };
  } catch {
    return null;
  }
}

export function writeWindowSession(root: string, window: string, sessionId: string, now: Date = new Date(), stale = false): void {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid session id');
  const p = windowSessionFile(root, window);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ session_id: sessionId, started_at: now.toISOString(), ...(stale ? { stale: true } : {}) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

/** Marks the recorded transcript stale (after /clear) without changing the id or the start time. No record: nothing to mark. */
export function markWindowSessionStale(root: string, window: string): void {
  const rec = readWindowSession(root, window);
  if (!rec) return;
  writeWindowSession(root, window, rec.session_id, rec.started_at ? new Date(rec.started_at) : new Date(), true);
}

/** The transcript file of the recorded session of a window (null when there is no record). */
export function windowTranscript(root: string, window: string, claudeHome: string = claudeHomeDir()): string | null {
  const rec = readWindowSession(root, window);
  return rec ? transcriptFile(projectTranscriptDir(root, claudeHome), rec.session_id) : null;
}

/** Starts the worker window: records a fresh session id, then runs the launcher with `--session-id`. */
export async function startWorkerWindow(
  run: Run,
  o: { session: string; window: string; root: string },
): Promise<'started'> {
  assertName(o.session);
  assertName(o.window);
  const id = randomUUID();
  writeWindowSession(o.root, o.window, id);
  const argv = ['bash', WORKER_LAUNCHER, o.window, '--session-id', id];
  const command = argv.map(shellQuote).join(' ');
  const r = await run('tmux', ['new-window', '-d', '-t', `=${o.session}:`, '-n', o.window, '-c', o.root, command]);
  if (r.code !== 0) throw new Error(`failed to start window ${o.window}`);
  return 'started';
}

/**
 * Fallback for the unverified positional prompt: waits until the window runs claude, then types the one-line startup
 * prompt (read the handoff file and the role file). Returns 'not_ready' when claude did not show up in time.
 */
export async function typeStartupLine(
  run: Run,
  session: string,
  window: string,
  opts: { tries?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<'typed' | 'not_ready'> {
  const tries = opts.tries ?? 20;
  const interval = opts.intervalMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    let ready = true;
    try { await assertClaudePane(run, session, window); } catch { ready = false; }
    if (ready) {
      try { await sendText(run, session, window, startupLine(window)); return 'typed'; } catch { return 'not_ready'; }
    }
    await sleep(interval);
  }
  return 'not_ready';
}
