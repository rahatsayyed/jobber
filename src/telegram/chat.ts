// src/telegram/chat.ts
// Free chat for the `chat` topic: one `claude -p` run per owner message, in the project directory under the
// project's normal settings (read_only permission set). No permission bypass flag, ever. The claude session id is
// kept per topic so the conversation continues with --resume. One message at a time (a queue).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SESSION_ID_RE } from '../platform/runner.js';
import { childEnv, type SpawnFn } from './spawn.js';

export const CHAT_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT = 8000;

export const chatSessionPath = (root: string): string => path.join(root, '.jobber', 'telegram-chat-session.json');

export function readChatSessions(root: string): Record<string, string> {
  try {
    const p = chatSessionPath(root);
    if (!existsSync(p)) return {};
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && SESSION_ID_RE.test(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function writeChatSession(root: string, key: string, id: string): void {
  const all = readChatSessions(root);
  all[key] = id;
  const p = chatSessionPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

/** argv for `claude`. The owner text is the prompt, after `--`, so it can never be read as a flag. No bypass flags. */
export function buildChatArgv(prompt: string, resumeId?: string): string[] {
  if (resumeId !== undefined && !SESSION_ID_RE.test(resumeId)) throw new Error('invalid session id for --resume');
  return ['-p', '--output-format', 'json', ...(resumeId !== undefined ? ['--resume', resumeId] : []), '--', prompt.slice(0, MAX_PROMPT)];
}

export function parseChatOutput(stdout: string): { text: string; sessionId: string | null; isError: boolean } {
  try {
    const j = JSON.parse(stdout) as { result?: unknown; session_id?: unknown; is_error?: unknown };
    const sid = typeof j.session_id === 'string' && SESSION_ID_RE.test(j.session_id) ? j.session_id : null;
    return { text: typeof j.result === 'string' ? j.result : '', sessionId: sid, isError: j.is_error === true };
  } catch {
    return { text: stdout.trim(), sessionId: null, isError: false };
  }
}

export const LOGIN_EXPIRED_MESSAGE = 'Claude login expired for the bridge. In a terminal run `claude`, then /login, then send your message again.';

/** True when claude's result or stderr says the login or OAuth token is no longer valid. Only checked on a failed run. */
export function isAuthFailure(text: string): boolean {
  return /Failed to authenticate|OAuth[^\n]{0,40}(expired|revoked|invalid)|(login|session|token)[^\n]{0,20}expired|Please run \/login|authentication_error|invalid[^\n]{0,20}credentials/i.test(text.slice(0, 20000));
}

export interface ChatDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  claudeBin?: string;
}

export interface ChatRunner {
  /** Runs one message; messages are served strictly one after another. Never throws; returns text for the owner. */
  ask(sessionKey: string, text: string): Promise<string>;
}

export function createChatRunner(deps: ChatDeps): ChatRunner {
  let tail: Promise<unknown> = Promise.resolve();
  const one = async (key: string, text: string): Promise<string> => {
    const resume = readChatSessions(deps.root)[key];
    const r = await deps.spawn(deps.claudeBin ?? 'claude', buildChatArgv(text, resume), {
      cwd: deps.root, env: childEnv(deps.env), timeoutMs: CHAT_TIMEOUT_MS,
    });
    if (r.timedOut) return 'The chat run took too long and was stopped. Try a shorter question.';
    const out = parseChatOutput(r.stdout);
    if (out.sessionId) {
      try { writeChatSession(deps.root, key, out.sessionId); } catch { /* the next message starts a new session */ }
    }
    // An expired login is told once, clearly, and never retried in a loop: the owner has to log in again.
    if ((r.code !== 0 || out.isError) && isAuthFailure(`${out.text}\n${r.stderr}`)) return LOGIN_EXPIRED_MESSAGE;
    if (r.code !== 0 && !out.text) return `The chat run failed (exit ${r.code}).`;
    return out.text || '(empty answer)';
  };
  return {
    ask(key, text) {
      const run = tail.then(() => one(key, text), () => one(key, text));
      tail = run.catch(() => undefined);
      return run.catch(() => 'The chat run failed.');
    },
  };
}
