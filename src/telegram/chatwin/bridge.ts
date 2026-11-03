// src/telegram/chatwin/bridge.ts
// Wiring of the chat window into the bridge: builds the ChatWindow from the environment. Kept apart from
// src/telegram/bridge.ts so that file only gets one small hook.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stopActive } from '../../../scripts/killSwitch.js';
import { loadManagerConfig, sessionName } from '../../platform/manager.js';
import { defaultRun, JOBBER_TMUX_SESSION, type Run } from '../../platform/tmux.js';
import { redactSecrets } from '../../safety/redact.js';
import type { TelegramApi } from '../api.js';
import type { TelegramConfig } from '../config.js';
import { ensureChatWindow } from './ensure.js';
import { ChatWindow } from './window.js';

export interface ChatWindowSetup {
  cfg: TelegramConfig;
  env: NodeJS.ProcessEnv;
  root: string;
  api: TelegramApi;
  run?: Run;
  claudeHome?: string;
}

/** The tmux session of the manager windows (config/manager-windows.json, MANAGER_TMUX_SESSION), else Jobber. */
export function chatTmuxSession(root: string, env: NodeJS.ProcessEnv): string {
  try {
    return sessionName(loadManagerConfig(readFileSync(path.join(root, 'config', 'manager-windows.json'), 'utf8')), env);
  } catch {
    return JOBBER_TMUX_SESSION;
  }
}

export function createChatWindow(s: ChatWindowSetup): ChatWindow {
  const run = s.run ?? defaultRun;
  return new ChatWindow({
    api: s.api,
    run,
    root: s.root,
    env: s.env,
    chatId: s.cfg.chatId ?? '',
    tmuxSession: chatTmuxSession(s.root, s.env),
    killed: () => stopActive(s.root, s.env).stopped,
    redact: (text) => redactSecrets(text, [s.cfg.token], { tokenLines: false }),
    claudeHome: s.claudeHome,
    restart: async () => {
      const cfg = loadManagerConfig(readFileSync(path.join(s.root, 'config', 'manager-windows.json'), 'utf8'));
      const r = await ensureChatWindow(run, cfg, s.env, s.root, { restart: true });
      return r === 'restarted' ? 'chat window restarted (new session).' : 'chat window started.';
    },
  });
}
