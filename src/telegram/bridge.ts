// src/telegram/bridge.ts
// The Telegram bridge daemon: grammY long polling. It ignores every update that does not come from an owner id
// (silently: no reply, no log of the content). Owner messages go to the typed commands or the free-chat runner.
import { Api, Bot, InputFile } from 'grammy';
import BetterSqlite3 from 'better-sqlite3';
import { stopActive } from '../../scripts/killSwitch.js';
import { openDb } from '../db.js';
import { dbPath } from '../dbPath.js';
import { fetchApi, scrub, type ApiResult, type TelegramApi } from './api.js';
import { createChatRunner, type ChatRunner } from './chat.js';
import { handleOwnerMessage, type BridgeDeps } from './commands.js';
import { isOwnerId, loadTelegramConfig, PROJECT_ROOT, type TelegramConfig } from './config.js';
import { DripController, type Button, type DripIo } from './drip.js';
import { htmlToPlain, chunksFor, postChunks } from './send.js';
import { isParseError, markdownToHtmlChunks } from './format.js';
import { runProcess, type SpawnFn } from './spawn.js';
import { ensureTopics } from './topics.js';
import { createWindowViews, handleWindowsMessage } from './windows/bridge.js';
import type { WindowViews } from './windows/manager.js';

/** A TelegramApi over a grammY Api object. Errors become results; the token is scrubbed from every message. */
export function grammyApi(api: Api, token: string): TelegramApi {
  return {
    async call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
      try {
        const raw = api.raw as unknown as Record<string, (p: Record<string, unknown>) => Promise<unknown>>;
        const fn = raw[method];
        if (typeof fn !== 'function') return { ok: false, description: `unknown method ${method}` };
        return { ok: true, result: (await fn.call(api.raw, payload)) as T };
      } catch (e) {
        const err = e as { error_code?: unknown; description?: unknown; name?: unknown };
        return {
          ok: false,
          error_code: typeof err.error_code === 'number' ? err.error_code : undefined,
          description: scrub(typeof err.description === 'string' ? err.description : `telegram request failed (${String(err.name ?? 'error')})`, token),
        };
      }
    },
  };
}

export interface BridgeOptions {
  env: NodeJS.ProcessEnv;
  root?: string;
  spawn?: SpawnFn;
  chat?: ChatRunner;
  killed?: BridgeDeps['killed'];
  openDb?: () => BetterSqlite3.Database;
  /** Test seam: a Bot built by the caller (for example with a fake api transformer). */
  bot?: Bot;
  /** Test seam: the live window views (default: built from the environment). */
  windowViews?: WindowViews;
}

export function createBridgeBot(cfg: TelegramConfig, opts: BridgeOptions): Bot {
  const root = opts.root ?? PROJECT_ROOT;
  const spawn = opts.spawn ?? runProcess;
  const chat = opts.chat ?? createChatRunner({ root, env: opts.env, spawn });
  const bot = opts.bot ?? new Bot(cfg.token);

  // 1. Owner filter by numeric user id, before anything else. Everything else is dropped without a trace.
  bot.use(async (ctx, next) => {
    if (!isOwnerId(cfg, ctx.from?.id)) return;
    await next();
  });

  const drip = new DripController();
  // Inline-button sender for /drip: HTML from format.ts (escaped), plain text when Telegram rejects the markup.
  const buttonSender = (api: TelegramApi, chatId: string, threadId: number | undefined) =>
    async (markdown: string, rows: Button[][]): Promise<void> => {
      const html = markdownToHtmlChunks(markdown)[0] ?? '';
      const base = {
        chat_id: chatId,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        reply_markup: { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) },
        link_preview_options: { is_disabled: true },
      };
      let r = await api.call('sendMessage', { ...base, text: html, parse_mode: 'HTML' });
      if (!r.ok && isParseError(r.description)) r = await api.call('sendMessage', { ...base, text: htmlToPlain(html) });
      if (!r.ok) console.error(`[telegram-bridge] button message failed: ${r.description ?? 'error'}`);
    };

  // /drip buttons. Only `dr:` data is taken here; any other callback data falls through to other handlers.
  bot.callbackQuery(/^dr:/, async (ctx) => {
    if (!isOwnerId(cfg, ctx.from?.id)) return; // silently ignored (the owner filter above already dropped it)
    try {
      await ctx.answerCallbackQuery(); // at once, so the button stops spinning
    } catch {
      // the query may be too old; the action below still runs once
    }
    const data = ctx.callbackQuery.data ?? '';
    const msg = ctx.callbackQuery.message;
    if (!msg) return;
    const threadId = 'message_thread_id' in msg && typeof msg.message_thread_id === 'number' && 'is_topic_message' in msg && msg.is_topic_message ? msg.message_thread_id : undefined;
    const api = grammyApi(ctx.api, cfg.token);
    const chatId = String(msg.chat.id);
    const send = buttonSender(api, chatId, threadId);
    const io: DripIo = {
      env: opts.env,
      openDb: opts.openDb ?? (() => openDb(dbPath())),
      now: () => new Date(),
      killed: opts.killed ?? (() => stopActive(root, opts.env)),
      reply: async (markdown) => {
        const r = await postChunks(api, { chatId, threadId }, chunksFor(markdown, false));
        if (!r.ok) console.error(`[telegram-bridge] reply failed: ${r.detail}`);
      },
      sendButtons: send,
    };
    try {
      await drip.callback(data, io, ctx.from?.id);
    } catch {
      await io.reply('Something went wrong while handling that button.').catch(() => undefined);
    }
  });

  // --- windows: live tmux window views (src/telegram/windows/). Buttons here; /windows and typed text in the message hook below.
  // Registered AFTER the /drip handler on purpose: this one takes every callback, so `dr:` data must be handled first.
  const windowViews = opts.windowViews ?? createWindowViews({ cfg, env: opts.env, root, api: grammyApi(bot.api, cfg.token) });
  bot.on('callback_query:data', async (ctx) => {
    const q = ctx.callbackQuery;
    await windowViews.handleCallback({
      fromId: ctx.from?.id, callbackId: q.id, data: q.data, chatId: q.message?.chat.id,
      threadId: q.message && 'is_topic_message' in q.message && q.message.is_topic_message ? q.message.message_thread_id : undefined,
    });
  });
  // --- end windows

  bot.on('message:text', async (ctx) => {
    const m = ctx.message;
    const threadId = m.is_topic_message ? m.message_thread_id : undefined;
    const api = grammyApi(ctx.api, cfg.token);
    // windows hook: /windows, /window <name> and typed text in a window topic
    if (await handleWindowsMessage(windowViews, { text: m.text, chatId: m.chat.id, threadId, messageId: m.message_id, replyToMessageId: m.reply_to_message?.message_id })) return;
    const deps: BridgeDeps = {
      root,
      env: opts.env,
      spawn,
      chat,
      killed: opts.killed ?? (() => stopActive(root, opts.env)),
      openDb: opts.openDb ?? (() => openDb(dbPath())),
      reply: async (markdown) => {
        const r = await postChunks(api, { chatId: String(m.chat.id), threadId, replyTo: m.message_id }, chunksFor(markdown, false));
        if (!r.ok) console.error(`[telegram-bridge] reply failed: ${r.detail}`);
      },
      drip,
      fromId: ctx.from?.id,
      sendButtons: buttonSender(api, String(m.chat.id), threadId),
      typing: async () => {
        await ctx.api.sendChatAction(m.chat.id, 'typing', threadId !== undefined ? { message_thread_id: threadId } : undefined);
      },
      sendDocument: async (absPath, caption) => {
        await ctx.api.sendDocument(m.chat.id, new InputFile(absPath), { caption, ...(threadId !== undefined ? { message_thread_id: threadId } : {}) });
      },
    };
    await handleOwnerMessage({ text: m.text, threadId }, deps);
  });

  // Never log the error object: a transport error can carry the request url, which holds the token.
  bot.catch((err) => {
    const name = err.error instanceof Error ? err.error.name : 'error';
    console.error(`[telegram-bridge] handler error (${name})`);
  });
  return bot;
}

/** Start the daemon: topics first (group chats only), then long polling. Resolves when polling stops. */
export async function runBridge(env: NodeJS.ProcessEnv, root: string = PROJECT_ROOT): Promise<number> {
  const cfg = loadTelegramConfig(env);
  if (!cfg) {
    console.error('[telegram-bridge] TELEGRAM_BOT_TOKEN and a chat (TELEGRAM_CHAT_ID or ALLOWED_USERS) are required');
    return 1;
  }
  if (cfg.owners.length === 0) {
    console.error('[telegram-bridge] ALLOWED_USERS has no numeric user id: nobody could command the bridge');
    return 1;
  }
  if (cfg.chatId) {
    // Works for the bot's own private-chat topics (BotFather "Threaded Mode") and for a forum group alike.
    const st = await ensureTopics(fetchApi(cfg.token), root, cfg.chatId);
    console.log(`[telegram-bridge] topics: ${st.forum ? Object.keys(st.topics).join(', ') || 'none created' : 'chat has no topics enabled, sending without topics'}`);
  }
  const bot = createBridgeBot(cfg, { env, root });
  const stop = (): void => { void bot.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`[telegram-bridge] polling as owner ids: ${cfg.owners.length}`);
  try {
    await bot.start({ drop_pending_updates: false });
  } catch (e) {
    console.error(`[telegram-bridge] stopped (${e instanceof Error ? e.name : 'error'})`);
    return 1;
  }
  return 0;
}
