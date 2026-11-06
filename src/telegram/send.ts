// src/telegram/send.ts
// One send path for the bridge daemon AND for code-sent notifications. It needs only the token and fetch: no
// bridge daemon, no model. Text is converted by format.ts (always HTML-escaped first) and chunked; if Telegram
// rejects the HTML the chunk is resent as plain text.
import { fetchApi, type TelegramApi } from './api.js';
import { loadTelegramConfig, PROJECT_ROOT } from './config.js';
import { htmlEscape, isParseError, markdownToHtmlChunks, plainChunks } from './format.js';
import { htmlToPlain, splitHtml } from '../platform/tgHtml.js';
import { ensureTopics, isThreadGoneError, readTopicState, writeTopicState, type TopicName } from './topics.js';

export interface SendResult {
  ok: boolean;
  detail: string;
}

export interface SendOpts {
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** Project root that holds .jobber/telegram-topics.json. */
  root?: string;
  /** Test seam: a ready Bot API caller instead of the fetch one. */
  api?: TelegramApi;
  /** Send the text as given (escaped only, no markdown conversion). */
  plain?: boolean;
  /** The text is already safe Telegram HTML built by src/platform/tgHtml.ts: split on line boundaries only, no markdown conversion. */
  html?: boolean;
  silent?: boolean;
}

export { htmlToPlain };

/** Send already-converted HTML chunks to one chat and thread. Per chunk: HTML first, plain text when Telegram rejects the markup. */
export async function postChunks(
  api: TelegramApi,
  target: { chatId: string; threadId?: number; replyTo?: number; silent?: boolean },
  htmlChunks: string[],
  onThreadGone?: () => Promise<number | undefined>,
): Promise<SendResult> {
  let threadId = target.threadId;
  for (const html of htmlChunks) {
    const base = (): Record<string, unknown> => ({
      chat_id: target.chatId,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      ...(target.replyTo !== undefined ? { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } } : {}),
      ...(target.silent ? { disable_notification: true } : {}),
      link_preview_options: { is_disabled: true },
    });
    let r = await api.call('sendMessage', { ...base(), text: html, parse_mode: 'HTML' });
    if (!r.ok && isParseError(r.description)) r = await api.call('sendMessage', { ...base(), text: htmlToPlain(html) });
    if (!r.ok && isThreadGoneError(r.description) && onThreadGone) {
      threadId = await onThreadGone();
      r = await api.call('sendMessage', { ...base(), text: html, parse_mode: 'HTML' });
      if (!r.ok && isParseError(r.description)) r = await api.call('sendMessage', { ...base(), text: htmlToPlain(html) });
    }
    if (!r.ok) return { ok: false, detail: `telegram send failed (${r.error_code ?? 'error'}: ${(r.description ?? '').slice(0, 120)})` };
  }
  return { ok: true, detail: 'sent' };
}

export function chunksFor(text: string, plain: boolean | undefined, html?: boolean): string[] {
  if (html) return splitHtml(text);
  // Plain: characters as typed, escaped only. 800 raw characters escape to at most 4000.
  return plain ? plainChunks(text, 800).map(htmlEscape) : markdownToHtmlChunks(text);
}

/** Post markdown text to a named topic of the Jobber chat (or to the owner's private chat when no group is set). Never throws. */
export async function sendToTopic(topic: TopicName, markdown: string, opts: SendOpts): Promise<SendResult> {
  try {
    const cfg = loadTelegramConfig(opts.env);
    if (!cfg || !cfg.chatId) return { ok: false, detail: 'telegram not configured' };
    const api = opts.api ?? fetchApi(cfg.token, opts.fetchFn);
    const root = opts.root ?? PROJECT_ROOT;
    const chatId = cfg.chatId;
    let threadId: number | undefined;
    const resolve = async (force: boolean): Promise<number | undefined> => {
      let st = readTopicState(root);
      if (force && st && st.chat_id === chatId) {
        delete st.topics[topic];
        try { writeTopicState(root, st); } catch { /* retried below */ }
      }
      if (!st || st.chat_id !== chatId || (st.forum && st.topics[topic] === undefined)) st = await ensureTopics(api, root, chatId, [topic]);
      return st.forum ? st.topics[topic] : undefined;
    };
    threadId = await resolve(false);
    const chunks = chunksFor(markdown, opts.plain, opts.html);
    return await postChunks(api, { chatId, threadId, silent: opts.silent }, chunks, () => resolve(true));
  } catch (e) {
    return { ok: false, detail: `telegram send failed (${e instanceof Error ? e.name : 'error'})` };
  }
}
