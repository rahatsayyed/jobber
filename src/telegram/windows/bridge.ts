// src/telegram/windows/bridge.ts
// Wiring of the live window views into the bridge: builds the WindowViews from the environment and routes owner
// messages and callback queries to it. Kept apart from src/telegram/bridge.ts so that file only gets two small hooks.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stopActive } from '../../../scripts/killSwitch.js';
import { DEFAULT_HIDDEN_IN_TELEGRAM, loadManagerConfig } from '../../platform/manager.js';
import { defaultRun, JOBBER_TMUX_SESSION, type Run } from '../../platform/tmux.js';
import { redactSecrets } from '../../safety/redact.js';
import { allowedTerminalSessions } from '../../web/terminalRoutes.js';
import type { TelegramApi } from '../api.js';
import { parseCommand } from '../commands.js';
import { isOwnerId, type TelegramConfig } from '../config.js';
import { WindowViews } from './manager.js';

export interface WindowsSetup {
  cfg: TelegramConfig;
  env: NodeJS.ProcessEnv;
  root: string;
  api: TelegramApi;
  run?: Run;
}

/** Windows that are viewable but never typed into: bridge and manager always, plus the protected list of the config. */
export function protectedWindowNames(root: string): string[] {
  const out = ['bridge', 'manager'];
  try {
    const cfg = loadManagerConfig(readFileSync(path.join(root, 'config', 'manager-windows.json'), 'utf8'));
    // `chat` is protected from the manager, not from the live view: its permission prompts are answered there (input stays behind TELEGRAM_WINDOW_INPUT).
    for (const p of cfg.protected) if (p !== 'chat' && !out.includes(p)) out.push(p);
  } catch { /* keep the built-in two */ }
  return out;
}

export interface TelegramWindowConfig {
  hidden: string[];
  labels: Record<string, { kind?: string; description: string }>;
}

// Hidden window names and role labels from config/manager-windows.json (defaults when it cannot be read).
export function telegramWindowConfig(root: string): TelegramWindowConfig {
  try {
    const cfg = loadManagerConfig(readFileSync(path.join(root, 'config', 'manager-windows.json'), 'utf8'));
    const labels: TelegramWindowConfig['labels'] = {};
    for (const [n, w] of Object.entries(cfg.windows)) labels[n] = { kind: w.kind, description: w.description };
    return { hidden: cfg.hidden_in_telegram, labels };
  } catch {
    return { hidden: [...DEFAULT_HIDDEN_IN_TELEGRAM], labels: {} };
  }
}

export function createWindowViews(s: WindowsSetup): WindowViews {
  const tg = telegramWindowConfig(s.root);
  const session = (s.env.WEB_TMUX_SESSION ?? '').trim() || JOBBER_TMUX_SESSION;
  return new WindowViews({
    hiddenWindows: tg.hidden,
    windowLabels: tg.labels,
    api: s.api,
    run: s.run ?? defaultRun,
    root: s.root,
    chatId: s.cfg.chatId,
    isOwner: (id) => isOwnerId(s.cfg, id),
    sessions: allowedTerminalSessions(s.env as Record<string, string | undefined>, session),
    inputEnabled: s.env.TELEGRAM_WINDOW_INPUT === 'true',
    killed: () => stopActive(s.root, s.env).stopped,
    redact: (text) => redactSecrets(text, [s.cfg.token], { tokenLines: false }),
    protectedWindows: protectedWindowNames(s.root),
  });
}

export interface WindowsMessage {
  text: string;
  chatId: number | string;
  threadId?: number;
  messageId?: number;
  replyToMessageId?: number;
}

/** True when the windows feature answered the message (so the normal routing must not run). Never throws. */
export async function handleWindowsMessage(views: WindowViews, m: WindowsMessage): Promise<boolean> {
  try {
    const cmd = parseCommand(m.text);
    if (cmd) return await views.handleCommand(cmd.name, cmd.rest, { chatId: m.chatId, threadId: m.threadId, messageId: m.messageId });
    return await views.handleText({ text: m.text, chatId: m.chatId, threadId: m.threadId, replyToMessageId: m.replyToMessageId });
  } catch {
    return false;
  }
}
