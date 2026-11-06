import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApiResult, TelegramApi } from '../src/telegram/api.js';
import { loadTelegramConfig, isOwnerId } from '../src/telegram/config.js';
import { ensureTopics, readTopicState, topicsPath, TOPIC_NAMES, CREATED_TOPIC_NAMES } from '../src/telegram/topics.js';
import { sendToTopic } from '../src/telegram/send.js';
import { telegramNotifier } from '../src/platform/notify.js';

const TOKEN = '123456:SECRET-token_abc';
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'tg-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

interface Call { method: string; payload: Record<string, unknown> }

function fakeApi(handler?: (c: Call) => ApiResult | undefined): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = [];
  let nextId = 100;
  const api: TelegramApi = {
    async call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
      const c = { method, payload };
      calls.push(c);
      const custom = handler?.(c);
      if (custom) return custom as ApiResult<T>;
      if (method === 'createForumTopic') return { ok: true, result: { message_thread_id: nextId++ } as T };
      return { ok: true, result: {} as T };
    },
  };
  return { api, calls };
}

describe('config', () => {
  it('owners are numeric ids only, never usernames', () => {
    const cfg = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42, @bob, 99, abc' } as NodeJS.ProcessEnv);
    expect(cfg?.owners).toEqual([42, 99]);
    expect(isOwnerId(cfg!, 42)).toBe(true);
    expect(isOwnerId(cfg!, 7)).toBe(false);
    expect(isOwnerId(cfg!, 'bob')).toBe(false);
    expect(isOwnerId(cfg!, undefined)).toBe(false);
  });
  it('without TELEGRAM_CHAT_ID the owner private chat is used and no topics', () => {
    const cfg = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ chatId: '42', grouped: false });
    const g = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42', TELEGRAM_CHAT_ID: '-100123' } as NodeJS.ProcessEnv);
    expect(g).toMatchObject({ chatId: '-100123', grouped: true });
  });
});

describe('topics', () => {
  it('creates every topic once, stores ids 0600 and is idempotent', async () => {
    const { api, calls } = fakeApi();
    const st = await ensureTopics(api, root, '-100123');
    expect(Object.keys(st.topics).sort()).toEqual([...CREATED_TOPIC_NAMES].sort());
    expect(calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(CREATED_TOPIC_NAMES.length);
    expect(statSync(topicsPath(root)).mode & 0o777).toBe(0o600);
    const again = fakeApi();
    await ensureTopics(again.api, root, '-100123');
    expect(again.calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(0);
  });

  it('recreates a deleted topic', async () => {
    await ensureTopics(fakeApi().api, root, '-100123');
    const old = readTopicState(root)!.topics.inbox!;
    const { api, calls } = fakeApi((c) =>
      c.method === 'editForumTopic' && c.payload.message_thread_id === old ? { ok: false, error_code: 400, description: 'Bad Request: message thread not found' } : undefined);
    const st = await ensureTopics(api, root, '-100123');
    expect(calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1);
    expect(st.topics.inbox).not.toBe(old);
    expect(readTopicState(root)!.topics.inbox).toBe(st.topics.inbox);
  });

  it('falls back to no thread id when the chat is not a forum', async () => {
    const { api } = fakeApi((c) => (c.method === 'createForumTopic' ? { ok: false, error_code: 400, description: 'Bad Request: the chat is not a forum' } : undefined));
    const st = await ensureTopics(api, root, '-100123');
    expect(st.forum).toBe(false);
    const sent = fakeApi();
    const r = await sendToTopic('alerts', 'hi', { env: { TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '1', TELEGRAM_CHAT_ID: '-100123' } as NodeJS.ProcessEnv, root, api: sent.api });
    expect(r.ok).toBe(true);
    expect(sent.calls[0]!.payload.message_thread_id).toBeUndefined();
  });
});

describe('sendToTopic and notifier routing', () => {
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42', TELEGRAM_CHAT_ID: '-100123' } as NodeJS.ProcessEnv;

  it('posts HTML to the message_thread_id of the topic; text-only goes to alerts', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let id = 10;
    const f = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (String(url).endsWith('createForumTopic')) return new Response(JSON.stringify({ ok: true, result: { message_thread_id: id++ } }), { status: 200 });
      if (String(url).endsWith('sendMessage')) bodies.push(body);
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }) as unknown as typeof fetch;
    const n = telegramNotifier(env, f, root);
    expect((await n.send('plain text')).ok).toBe(true);
    expect((await n.send('**digest**', { topic: 'inbox' })).ok).toBe(true);
    const st = readTopicState(root)!;
    expect(bodies[0]).toMatchObject({ chat_id: '-100123', message_thread_id: st.topics.alerts, parse_mode: 'HTML' });
    expect(bodies[1]).toMatchObject({ message_thread_id: st.topics.inbox, text: '<b>digest</b>' });
    expect(st.topics.alerts).not.toBe(st.topics.inbox);
  });

  it("private chat with the bot's own topics: creates the topic in the private chat and sends into it", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const isCreate = String(url).includes('createForumTopic');
      return new Response(JSON.stringify({ ok: true, result: isCreate ? { message_thread_id: 7 } : {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await telegramNotifier({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv, f, root).send('x', { topic: 'wakes' });
    const create = calls.find((c) => c.url.includes('createForumTopic'))!;
    expect(create.body).toMatchObject({ chat_id: '42', name: 'wakes' });
    const send = calls.find((c) => c.url.includes('sendMessage'))!;
    expect(send.body).toMatchObject({ chat_id: '42', message_thread_id: 7 });
  });

  it('private chat without topics enabled: sends without a thread id and does not retry creating', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (String(url).includes('createForumTopic')) {
        return new Response('{"ok":false,"error_code":400,"description":"Bad Request: the chat is not a forum"}', { status: 400 });
      }
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }) as unknown as typeof fetch;
    const n = telegramNotifier({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv, f, root);
    await n.send('x', { topic: 'wakes' });
    await n.send('y', { topic: 'alerts' });
    const sends = calls.filter((c) => c.url.includes('sendMessage'));
    expect(sends).toHaveLength(2);
    expect(sends.every((c) => c.body.message_thread_id === undefined && c.body.chat_id === '42')).toBe(true);
    expect(calls.filter((c) => c.url.includes('createForumTopic'))).toHaveLength(1);
  });

  it('falls back to plain text when Telegram rejects the HTML', async () => {
    const texts: Array<{ text: string; pm: unknown }> = [];
    const { api } = fakeApi((c) => {
      if (c.method !== 'sendMessage') return undefined;
      texts.push({ text: String(c.payload.text), pm: c.payload.parse_mode });
      return c.payload.parse_mode === 'HTML' ? { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } : { ok: true };
    });
    const r = await sendToTopic('alerts', 'a **b** <c>', { env: { TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv, root, api });
    expect(r.ok).toBe(true);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toEqual({ text: 'a b <c>', pm: undefined });
  });

  it('recreates the topic and retries when the thread was deleted', async () => {
    mkdirSync(path.join(root, '.jobber'), { recursive: true });
    writeFileSync(topicsPath(root), JSON.stringify({ chat_id: '-100123', forum: true, topics: { alerts: 5 } }));
    let n = 0;
    const { api, calls } = fakeApi((c) => {
      if (c.method === 'sendMessage' && c.payload.message_thread_id === 5) { n++; return { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }; }
      return undefined;
    });
    const r = await sendToTopic('alerts', 'hello', { env, root, api });
    expect(r.ok).toBe(true);
    expect(n).toBe(1);
    expect(calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1);
    expect(JSON.parse(readFileSync(topicsPath(root), 'utf8')).topics.alerts).not.toBe(5);
  });

  it('never leaks the token in a failure detail', async () => {
    const f = (async () => { throw new Error(`boom https://api.telegram.org/bot${TOKEN}/sendMessage`); }) as unknown as typeof fetch;
    const r = await telegramNotifier({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv, f, root).send('x');
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(TOKEN);
  });
});
