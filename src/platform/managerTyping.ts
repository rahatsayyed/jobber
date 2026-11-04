// src/platform/managerTyping.ts
// The only place the manager types into a worker window: `send` (one short plain line) and `clear` (/clear). Every path
// goes through guardWorker (configured, non-protected, kind worker), the kill switch, assertClaudePane and the window lock
// (the one the WindowDispatcher holds during an item). The manager skill reaches this only through scripts/manager.ts.
import { guard, sessionName, type ManagerConfig, type TypeDeps } from './manager.js';
import { redactPane } from './redact.js';
import { assertClaudePane, sendText, validateSendText, type Run } from './tmux.js';
import { takeWindowLock } from './windowLock.js';
import {
  claudeHomeDir, findTranscriptByTypedText, markWindowSessionStale, projectTranscriptDir, sessionIdOfFile, writeWindowSession,
} from './windowSession.js';

const SEND_MAX = 500;
// Owner commands and switches are never typed by the manager (the kill switch and the dry run stay with the owner).
const OWNER_CMD_RE = /\bSTOP\b|jobber:control|JOBBER_KILL|JOBBER_DRY_RUN|skip-permissions|bypassPermissions/;
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The text rules of `send`: short, one plain line, no slash command, no owner command, nothing that looks like a secret. */
export function validateManagerText(text: string): void {
  validateSendText(text);
  if (text.length > SEND_MAX) throw new Error(`text too long for a manager instruction (max ${SEND_MAX})`);
  if (text.trimStart().startsWith('/')) throw new Error('text must not start with / (use clear for /clear)');
  if (OWNER_CMD_RE.test(text)) throw new Error('text looks like an owner command');
  if (redactPane(text) !== text) throw new Error('text looks like it holds a secret');
}

function guardWorker(cfg: ManagerConfig, name: string): ManagerConfig['windows'][string] {
  const w = guard(cfg, name);
  if (w.kind !== 'worker') throw new Error(`window ${name} is not a worker window`);
  return w;
}

/** Runs fn while holding the window lock (the one the dispatcher uses); refuses with window_busy when it is held. */
async function withWindowLock<T>(root: string, name: string, owner: string, fn: () => Promise<T>): Promise<T> {
  const lock = takeWindowLock(root, name, owner);
  if (!lock) throw new Error(`window_busy: window ${name} has a dispatcher item running`);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Types ONE line into a configured, non-protected worker window. Refuses on the kill switch, a window that is not claude,
 * a held dispatcher lock (window_busy) and any text that breaks the rules above. The result names only the window and the length.
 */
export async function sendToWindow(
  run: Run, cfg: ManagerConfig, env: NodeJS.ProcessEnv, name: string, text: string, d: TypeDeps,
): Promise<string> {
  guardWorker(cfg, name);
  validateManagerText(text);
  if (d.killed()) throw new Error('kill switch is on');
  const session = sessionName(cfg, env);
  await assertClaudePane(run, session, name);
  await withWindowLock(d.root, name, `manager:send:${name}`, () => sendText(run, session, name, text));
  return `sent to ${name} (${text.length} chars)`;
}

/** Types /clear into a worker window (only when its lock is free) and finds the new transcript again. */
export async function clearWindow(
  run: Run, cfg: ManagerConfig, env: NodeJS.ProcessEnv, name: string, d: TypeDeps,
): Promise<string> {
  guardWorker(cfg, name);
  if (d.killed()) throw new Error('kill switch is on');
  const session = sessionName(cfg, env);
  await assertClaudePane(run, session, name);
  return withWindowLock(d.root, name, `manager:clear:${name}`, async () => {
    const sentAt = Date.now();
    await sendText(run, session, name, '/clear');
    await (d.sleep ?? sleepMs)(d.settleMs ?? 1500);
    // UNVERIFIED: that the new transcript holds the text "/clear". When it is not found the record is marked stale and
    // the next dispatch finds the file by the line it types.
    const hit = findTranscriptByTypedText(projectTranscriptDir(d.root, d.claudeHome ?? claudeHomeDir()), '/clear', sentAt - 5000);
    const id = hit ? sessionIdOfFile(hit.file) : null;
    if (id) {
      writeWindowSession(d.root, name, id);
      return `${name}: cleared, transcript found again`;
    }
    markWindowSessionStale(d.root, name);
    return `${name}: cleared, transcript not found yet (the next work item finds it)`;
  });
}
