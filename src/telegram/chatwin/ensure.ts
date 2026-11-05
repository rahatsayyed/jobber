// src/telegram/chatwin/ensure.ts
// Starts (or restarts) the `chat` window of the Jobber tmux session: the same launcher as hunt and followups
// (scripts/claude-session.sh, never skip-permissions) plus `--session-id <uuid>`, so the bridge knows which
// transcript file the window writes. The id is recorded in .jobber/chat-session.json BEFORE the window starts.
// `chat` is in the protected list of config/manager-windows.json, so the manager cannot stop it; `npm run up`
// and the bridge's `/chat restart` call this function instead.
import { randomUUID } from 'node:crypto';
import { sessionName, type ManagerConfig } from '../../platform/manager.js';
import { killWindow, listWindows, type Run } from '../../platform/tmux.js';
import { writeChatSessionRecord } from './session.js';

export const CHAT_WINDOW = 'chat';

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export async function ensureChatWindow(
  run: Run,
  cfg: Pick<ManagerConfig, 'session'>,
  env: NodeJS.ProcessEnv,
  root: string,
  opts: { restart?: boolean } = {},
): Promise<'started' | 'exists' | 'restarted'> {
  const session = sessionName({ ...cfg, protected: [], hidden_in_telegram: [], windows: {} }, env);
  const exists = (await listWindows(run, session)).some((w) => w.name === CHAT_WINDOW);
  if (exists && !opts.restart) return 'exists';
  if (exists) await killWindow(run, session, CHAT_WINDOW);
  const id = randomUUID();
  writeChatSessionRecord(root, id);
  const command = ['bash', 'scripts/claude-session.sh', '--session-id', id].map(shellQuote).join(' ');
  const r = await run('tmux', ['new-window', '-d', '-t', `=${session}:`, '-n', CHAT_WINDOW, '-c', root, command]);
  if (r.code !== 0) throw new Error(`failed to start window ${CHAT_WINDOW}`);
  return exists ? 'restarted' : 'started';
}
