// src/telegram/chatwin/messages.ts
// Ids of the messages in the `chat` topic (bot and owner), kept so /clear can delete them. Ids only, never text.
// Capped at 2000 (the oldest drop out first), file mode 0600.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TelegramApi } from '../api.js';

export const CHAT_MESSAGES_CAP = 2000;
export const chatMessagesPath = (root: string): string => path.join(root, '.jobber', 'telegram-chat-messages.json');

export class ChatMessageLog {
  private ids: number[] | null = null;

  constructor(private readonly root: string, private readonly chatId: string) {}

  private load(): number[] {
    if (this.ids) return this.ids;
    let out: number[] = [];
    try {
      const j = JSON.parse(readFileSync(chatMessagesPath(this.root), 'utf8')) as { chat_id?: unknown; ids?: unknown };
      if (j.chat_id === this.chatId && Array.isArray(j.ids)) out = j.ids.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
    } catch { /* no file yet */ }
    this.ids = out.slice(-CHAT_MESSAGES_CAP);
    return this.ids;
  }

  private save(): void {
    try {
      const p = chatMessagesPath(this.root);
      mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ chat_id: this.chatId, ids: this.load() })}\n`, { mode: 0o600 });
      renameSync(tmp, p);
      chmodSync(p, 0o600);
    } catch { /* best effort: a lost id only means one message is not deleted by /clear */ }
  }

  add(id: number | undefined): void {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return;
    const ids = this.load();
    if (ids[ids.length - 1] === id) return;
    ids.push(id);
    if (ids.length > CHAT_MESSAGES_CAP) ids.splice(0, ids.length - CHAT_MESSAGES_CAP);
    this.save();
  }

  list(): number[] {
    return [...this.load()];
  }

  clear(): void {
    this.ids = [];
    this.save();
  }

  /** Delete every recorded message (newest first), forget them all, and report the counts. Failures are ignored. */
  async deleteAll(api: TelegramApi): Promise<{ deleted: number; failed: number }> {
    const ids = this.list().reverse();
    this.clear();
    let deleted = 0;
    let failed = 0;
    for (const id of ids) {
      const r = await api.call('deleteMessage', { chat_id: this.chatId, message_id: id });
      if (r.ok) deleted++; else failed++;
    }
    return { deleted, failed };
  }
}
