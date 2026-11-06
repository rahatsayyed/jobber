// src/telegram/windows/topics.ts
// Topic routing for window views: a long-lived window gets its own topic (created on demand, id stored under
// `windows` in .jobber/telegram-topics.json); wake-* windows share the wakes topic; the lane windows `mail` and `linkedin` and their
// drip-* runs share ONE topic per lane (`mail`, `linkedin`); any other drip-* window uses the old `drips` topic.
import type { TelegramApi } from '../api.js';
import { ensureTopics, readTopicState, writeTopicState, type TopicState } from '../topics.js';

export type WindowTopicKind = 'own' | 'wakes' | 'mail' | 'linkedin' | 'drips';

export function topicKindOf(window: string): WindowTopicKind {
  if (window.startsWith('wake-')) return 'wakes';
  if (window === 'mail' || window.startsWith('drip-mail')) return 'mail';
  if (window === 'linkedin' || window.startsWith('drip-linkedin')) return 'linkedin';
  if (window.startsWith('drip-')) return 'drips';
  return 'own';
}

/** Thread id for a window view, or undefined when the chat has no topics or the topic could not be made. Never throws. */
export async function ensureWindowTopic(api: TelegramApi, root: string, chatId: string, window: string, kind: WindowTopicKind): Promise<number | undefined> {
  try {
    if (kind !== 'own') {
      const st = await ensureTopics(api, root, chatId, [kind]);
      return st.forum ? st.topics[kind] : undefined;
    }
    if (window === 'chat') {
      // The chat window's live view lives in the chat topic itself (no second topic with the same name).
      const cst = await ensureTopics(api, root, chatId, ['chat']);
      return cst.forum ? cst.topics.chat : undefined;
    }
    let st: TopicState | null = readTopicState(root);
    if (!st || st.chat_id !== chatId) st = await ensureTopics(api, root, chatId, []);
    if (!st.forum) return undefined;
    const known = st.windows?.[window];
    if (known !== undefined) return known;
    const r = await api.call<{ message_thread_id: number }>('createForumTopic', { chat_id: chatId, name: window });
    const id = r.result?.message_thread_id;
    if (!r.ok || typeof id !== 'number') return undefined;
    const fresh: TopicState = { ...st, windows: { ...(st.windows ?? {}), [window]: id } };
    try { writeTopicState(root, fresh); } catch { /* the topic exists; it is looked up again next time */ }
    return id;
  } catch {
    return undefined;
  }
}

/** Drop a stored topic id that Telegram says is gone, so the next view creates it again. */
export function forgetWindowTopic(root: string, window: string, kind: WindowTopicKind, id: number): void {
  try {
    const st = readTopicState(root);
    if (!st) return;
    if (kind === 'own') {
      if (st.windows?.[window] === id) delete st.windows[window];
    } else if (st.topics[kind] === id) {
      delete st.topics[kind];
    }
    writeTopicState(root, st);
  } catch { /* best effort */ }
}

/** Window name whose own topic has this thread id (from the stored map), or null. */
export function windowOfThread(root: string, threadId: number): string | null {
  const st = readTopicState(root);
  if (!st || !st.forum) return null;
  // The lane topics belong to the worker windows of the same name (typed text there goes to that window).
  if (st.topics.mail === threadId) return 'mail';
  if (st.topics.linkedin === threadId) return 'linkedin';
  if (!st.windows) return null;
  for (const [name, id] of Object.entries(st.windows)) if (id === threadId) return name;
  return null;
}
