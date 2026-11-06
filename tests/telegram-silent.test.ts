import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApiResult, TelegramApi } from '../src/telegram/api.js';
import { sendToTopic, postChunks } from '../src/telegram/send.js';
import { telegramNotifier } from '../src/platform/notify.js';
import { resolveSilent, silentTopicsFromEnv, noticeUrgency, DEFAULT_SILENT_TOPICS } from '../src/telegram/silent.js';
import { fileNotifier } from '../src/scheduler/notify.js';
import { TOPIC_NAMES } from '../src/telegram/topics.js';

const TOKEN = '123456:SECRET-token_abc';
const baseEnv = { TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv;
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'tg-silent-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

interface Call { method: string; payload: Record<string, unknown> }

function fakeApi(opts: { rejectHtml?: boolean } = {}): { api: TelegramApi; sent: Call[] } {
  const sent: Call[] = [];
  let id = 100;
  const api: TelegramApi = {
    async call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
      if (method === 'createForumTopic') return { ok: true, result: { message_thread_id: id++ } as T };
      if (method !== 'sendMessage') return { ok: true, result: {} as T };
      sent.push({ method, payload });
      if (opts.rejectHtml && payload.parse_mode === 'HTML') return { ok: false, error_code: 400, description: "Bad Request: can't parse entities" };
      return { ok: true, result: {} as T };
    },
  };
  return { api, sent };
}

const send = async (topic: Parameters<typeof sendToTopic>[0], o: Partial<Parameters<typeof sendToTopic>[2]> = {}, text = 'hello', api?: TelegramApi) => {
  const f = fakeApi();
  const r = await sendToTopic(topic, text, { env: baseEnv, api: api ?? f.api, root, ...o });
  return { r, sent: f.sent };
};

describe('topic defaults', () => {
  it('drips and wakes are silent; alerts, assist, inbox, chat are loud', async () => {
    const table: Record<string, boolean> = {};
    for (const t of TOPIC_NAMES) {
      const { sent } = await send(t);
      expect(sent.length).toBe(1);
      table[t] = sent[0].payload.disable_notification === true;
      // loud means the key is absent (never an explicit false the client could misread)
      if (!table[t]) expect('disable_notification' in sent[0].payload).toBe(false);
    }
    expect(table).toEqual({ alerts: false, wakes: true, drips: true, inbox: false, assist: false, chat: false });
    expect([...DEFAULT_SILENT_TOPICS].sort()).toEqual(['drips', 'wakes']);
  });

  it('no topic (plain chat, resolveSilent) is loud', () => {
    expect(resolveSilent(undefined, undefined, {})).toBe(false);
  });
});

describe('overrides', () => {
  it('silent: false forces a notification on a silent topic, silent: true forces silence on a loud one', async () => {
    expect((await send('drips', { silent: false })).sent[0].payload.disable_notification).toBeUndefined();
    expect((await send('alerts', { silent: true })).sent[0].payload.disable_notification).toBe(true);
  });

  it('works through the Notifier, with html and with the markdown path', async () => {
    const f = fakeApi();
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (String(url).includes('sendMessage')) calls.push({ body });
      return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 7 } }), { status: 200 });
    }) as unknown as typeof fetch;
    void f;
    const n = telegramNotifier(baseEnv, fetchFn, root);
    await n.send('<b>x</b>', { topic: 'wakes', html: true });
    await n.send('x', { topic: 'wakes', silent: false });
    await n.send('x', { topic: 'alerts', silent: true });
    await n.send('x');
    expect(calls.map((c) => c.body.disable_notification)).toEqual([true, undefined, true, undefined]);
  });
});

describe('every chunk and the plain fallback', () => {
  it('a long text is split and every chunk is silent', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `line number ${i} with some words`).join('\n');
    const { sent } = await send('drips', {}, long);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((c) => c.payload.disable_notification === true)).toBe(true);
  });

  it('the plain-text resend after a parse error stays silent', async () => {
    const f = fakeApi({ rejectHtml: true });
    await sendToTopic('wakes', 'hello', { env: baseEnv, api: f.api, root });
    expect(f.sent.length).toBe(2);
    expect(f.sent[0].payload.parse_mode).toBe('HTML');
    expect(f.sent[1].payload.parse_mode).toBeUndefined();
    expect(f.sent.every((c) => c.payload.disable_notification === true)).toBe(true);
  });

  it('the plain fallback of a loud notice stays loud', async () => {
    const f = fakeApi({ rejectHtml: true });
    await sendToTopic('alerts', 'hello', { env: baseEnv, api: f.api, root });
    expect(f.sent.every((c) => !('disable_notification' in c.payload))).toBe(true);
  });
});

describe('TELEGRAM_SILENT_TOPICS', () => {
  it('overrides the default set', async () => {
    const env = { ...baseEnv, TELEGRAM_SILENT_TOPICS: 'alerts, inbox' } as NodeJS.ProcessEnv;
    const f = fakeApi();
    for (const t of ['alerts', 'inbox', 'drips'] as const) await sendToTopic(t, 'x', { env, api: f.api, root });
    expect(f.sent.map((c) => c.payload.disable_notification)).toEqual([true, true, undefined]);
  });

  it('blank is the default, none silences nothing, unknown names are ignored with a warning', () => {
    expect([...silentTopicsFromEnv({ TELEGRAM_SILENT_TOPICS: '  ' } as NodeJS.ProcessEnv).topics].sort()).toEqual(['drips', 'wakes']);
    expect(silentTopicsFromEnv({ TELEGRAM_SILENT_TOPICS: 'none' } as NodeJS.ProcessEnv).topics.size).toBe(0);
    const r = silentTopicsFromEnv({ TELEGRAM_SILENT_TOPICS: 'wakes,bogus' } as NodeJS.ProcessEnv);
    expect([...r.topics]).toEqual(['wakes']);
    expect(r.warnings.join(' ')).toContain('bogus');
    const allBad = silentTopicsFromEnv({ TELEGRAM_SILENT_TOPICS: 'x,y' } as NodeJS.ProcessEnv);
    expect([...allBad.topics].sort()).toEqual(['drips', 'wakes']);
    expect(allBad.warnings.length).toBe(3);
  });

  it('an explicit per-call value still beats the env', () => {
    const env = { TELEGRAM_SILENT_TOPICS: 'alerts' } as NodeJS.ProcessEnv;
    expect(resolveSilent('alerts', false, env)).toBe(false);
    expect(resolveSilent('drips', true, env)).toBe(true);
    expect(resolveSilent('drips', undefined, env)).toBe(false);
  });
});

describe('replies to the owner stay loud', () => {
  it('postChunks without silent (the bridge reply path) sends no disable_notification, also with replyTo', async () => {
    const f = fakeApi();
    await postChunks(f.api, { chatId: '42', threadId: 5, replyTo: 9 }, ['<b>ok</b>']);
    expect(f.sent[0].payload.disable_notification).toBeUndefined();
    expect(f.sent[0].payload.reply_parameters).toBeTruthy();
  });

  it('the bridge source never passes silent to postChunks', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'telegram', 'bridge.ts'), 'utf8');
    expect(src).not.toMatch(/\bsilent\b\s*[:,}]|disable_notification/);
  });
});

describe('noticeUrgency and the notify log', () => {
  it('loud for owner, failure or halt; no override otherwise', () => {
    expect(noticeUrgency({ needsOwner: true })).toBe(false);
    expect(noticeUrgency({ failed: true })).toBe(false);
    expect(noticeUrgency({ halted: true })).toBe(false);
    expect(noticeUrgency({})).toBeUndefined();
  });

  it('the notify.jsonl record gets a boolean silent field and no secret', async () => {
    const p = path.join(root, 'notify.jsonl');
    const n = fileNotifier(p, () => new Date('2026-11-06T00:00:00Z'));
    await n.notify({ level: 'info', title: 'a', silent: true });
    await n.notify({ level: 'info', title: 'b' });
    const rows = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows[0].silent).toBe(true);
    expect('silent' in rows[1]).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });
});
