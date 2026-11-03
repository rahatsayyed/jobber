// src/telegram/topics.ts
// The forum topics of the Jobber supergroup. Created once with createForumTopic, ids kept in
// .jobber/telegram-topics.json (0600). Idempotent: a stored id that no longer exists is recreated.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TelegramApi } from './api.js';

export const TOPIC_NAMES = ['alerts', 'wakes', 'drips', 'inbox', 'assist', 'chat'] as const;
export type TopicName = (typeof TOPIC_NAMES)[number];

export interface TopicState {
  chat_id: string;
  /** false when the chat is not a forum: every send then goes without a thread id. */
  forum: boolean;
  topics: Partial<Record<TopicName, number>>;
  /** Topics of long-lived tmux windows (window name -> thread id), created on demand by the windows feature. */
  windows?: Record<string, number>;
}

export const topicsPath = (root: string): string => path.join(root, '.jobber', 'telegram-topics.json');

export function readTopicState(root: string): TopicState | null {
  try {
    const p = topicsPath(root);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8')) as Partial<TopicState>;
    if (typeof j.chat_id !== 'string' || typeof j.forum !== 'boolean' || typeof j.topics !== 'object' || j.topics === null) return null;
    const topics: Partial<Record<TopicName, number>> = {};
    for (const n of TOPIC_NAMES) {
      const v = (j.topics as Record<string, unknown>)[n];
      if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) topics[n] = v;
    }
    const windows: Record<string, number> = {};
    const rawWin = (j as { windows?: unknown }).windows;
    if (typeof rawWin === 'object' && rawWin !== null && !Array.isArray(rawWin)) {
      for (const [k, v] of Object.entries(rawWin as Record<string, unknown>)) {
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(k) && typeof v === 'number' && Number.isSafeInteger(v) && v > 0) windows[k] = v;
      }
    }
    return { chat_id: j.chat_id, forum: j.forum, topics, ...(Object.keys(windows).length > 0 ? { windows } : {}) };
  } catch {
    return null;
  }
}

export function writeTopicState(root: string, st: TopicState): void {
  const p = topicsPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

const isNotForum = (d: string | undefined): boolean =>
  /not a forum|forum.*(disabled|not enabled)|topics?.*(disabled|not enabled)|threaded mode/i.test(d ?? '');

export function isThreadGoneError(description: string | undefined): boolean {
  return /thread not found|TOPIC_ID_INVALID|TOPIC_DELETED|topic.*(deleted|closed)/i.test(description ?? '');
}

async function topicExists(api: TelegramApi, chatId: string, id: number, name: TopicName): Promise<boolean> {
  // The Bot API has no getForumTopic. Renaming a topic to its own name is a harmless probe: an existing topic
  // answers TOPIC_NOT_MODIFIED, a deleted one answers "message thread not found".
  const r = await api.call('editForumTopic', { chat_id: chatId, message_thread_id: id, name });
  if (r.ok) return true;
  return !isThreadGoneError(r.description);
}

/**
 * Make sure the topics exist (all, or only the ones named). Only for a group chat. Returns the stored state;
 * `forum: false` means the chat is not a forum and no thread id is used. Never throws.
 */
export async function ensureTopics(
  api: TelegramApi, root: string, chatId: string, only?: readonly TopicName[],
): Promise<TopicState> {
  let st = readTopicState(root);
  if (!st || st.chat_id !== chatId) st = { chat_id: chatId, forum: true, topics: {} };
  let changed = false;
  for (const name of only ?? TOPIC_NAMES) {
    if (!st.forum) break;
    const id = st.topics[name];
    if (id !== undefined) {
      if (await topicExists(api, chatId, id, name)) continue;
      delete st.topics[name];
      changed = true;
    }
    const r = await api.call<{ message_thread_id: number }>('createForumTopic', { chat_id: chatId, name });
    const newId = r.result?.message_thread_id;
    if (r.ok && typeof newId === 'number') {
      st.topics[name] = newId;
      changed = true;
    } else if (isNotForum(r.description)) {
      st = { chat_id: chatId, forum: false, topics: {} };
      changed = true;
      break;
    }
    // any other failure (no rights, network): the topic stays unset and the send falls back to no thread id
  }
  if (changed) {
    try {
      writeTopicState(root, st);
    } catch {
      // state not writable: topics are looked up again next time
    }
  }
  return st;
}
