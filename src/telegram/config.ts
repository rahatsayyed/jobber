// src/telegram/config.ts
// Telegram settings from the environment. The token is read here and nowhere else in src/telegram; it is never
// logged, never put in an error and never passed to a child process or a model.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TelegramConfig {
  token: string;
  /** Numeric Telegram user ids that may command the bridge. Never usernames. */
  owners: number[];
  /** Where code-sent messages go: the forum supergroup (TELEGRAM_CHAT_ID) or the first owner's private chat. */
  chatId: string | null;
  /** True when TELEGRAM_CHAT_ID is set (a group that may be a forum). False: private chat, no topics. */
  grouped: boolean;
}

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseOwnerIds(raw: string | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{1,15}$/.test(s))
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** null when there is no token or nowhere to send to. */
export function loadTelegramConfig(env: NodeJS.ProcessEnv): TelegramConfig | null {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return null;
  const owners = parseOwnerIds(env.ALLOWED_USERS);
  const group = (env.TELEGRAM_CHAT_ID ?? '').trim();
  const chat = /^-?\d{1,20}$/.test(group) ? group : '';
  const chatId = chat || (owners[0] !== undefined ? String(owners[0]) : null);
  if (!chatId) return null;
  return { token, owners, chatId, grouped: chat !== '' };
}

/** Owner check by numeric user id only. A username, a missing id or a non-owner id is never an owner. */
export function isOwnerId(cfg: Pick<TelegramConfig, 'owners'>, id: unknown): boolean {
  return typeof id === 'number' && Number.isSafeInteger(id) && cfg.owners.includes(id);
}
