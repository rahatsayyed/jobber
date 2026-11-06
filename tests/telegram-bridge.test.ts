import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bot } from 'grammy';
import { createBridgeBot } from '../src/telegram/bridge.js';
import { applyArgv, commandArgv, handleOwnerMessage, instructionArgv, parseCommand, type BridgeDeps } from '../src/telegram/commands.js';
import { buildChatArgv, createChatRunner, readChatSessions } from '../src/telegram/chat.js';
import { childEnv, type ProcResult, type SpawnFn } from '../src/telegram/spawn.js';
import { loadTelegramConfig } from '../src/telegram/config.js';
import { topicsPath } from '../src/telegram/topics.js';

const TOKEN = '123456:SECRET-token_abc';
const SID = '11111111-2222-3333-4444-555555555555';
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'tgb-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const ok = (stdout: string): ProcResult => ({ code: 0, stdout, stderr: '', timedOut: false });

describe('owner filter (real grammY Bot, fake api)', () => {
  function build(spawnCalls: Array<{ cmd: string; args: string[] }>) {
    const cfg = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv)!;
    const bot = new Bot(TOKEN, {
      botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'jobber_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never,
    });
    const api: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      api.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: {} } as never;
    });
    const spawn: SpawnFn = async (cmd, args) => { spawnCalls.push({ cmd, args }); return ok('limits output'); };
    createBridgeBot(cfg, { env: { TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv, root, spawn, killed: () => ({ stopped: false, reason: '' }), bot });
    return { bot, api };
  }
  const update = (id: number, username: string, text: string) => ({
    update_id: 1,
    message: { message_id: 7, date: 1, chat: { id: 42, type: 'private' }, from: { id, is_bot: false, first_name: 'x', username }, text, entities: [{ type: 'bot_command', offset: 0, length: text.length }] },
  });

  it('answers an owner command with a code block', async () => {
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const { bot, api } = build(spawned);
    await bot.handleUpdate(update(42, 'owner', '/limits') as never);
    expect(spawned).toEqual([{ cmd: 'npx', args: ['tsx', 'scripts/status.ts', 'limits'] }]);
    const sends = api.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(String(sends[0]!.payload.text)).toBe('<b>📏 Limits</b>\n<pre>limits output</pre>');
    expect(api.some((c) => c.method === 'sendChatAction')).toBe(true);
  });

  it('ignores other ids silently, also when the username looks like the owner', async () => {
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const { bot, api } = build(spawned);
    await bot.handleUpdate(update(99, 'owner', '/limits') as never);
    await bot.handleUpdate(update(43, '42', '/apply https://example.com') as never);
    expect(spawned).toHaveLength(0);
    expect(api).toHaveLength(0);
  });
});

describe('command argv', () => {
  it('parses commands with bot suffix', () => {
    expect(parseCommand('/apply@jobber_bot https://x.io/a')).toEqual({ name: 'apply', rest: 'https://x.io/a' });
    expect(parseCommand('hello')).toBeNull();
  });

  it('apply: url is one argv item, no shell involved, --force passed on', () => {
    const a = applyArgv('https://example.com/job?a=1&b=2;rm -rf x --force');
    expect('error' in a).toBe(true); // a space inside would make two items
    const b = applyArgv('https://example.com/job?a=1&b=2;$(x) --force');
    expect(b).toMatchObject({ cmd: 'npm', args: ['run', 'apply:request', '--', 'https://example.com/job?a=1&b=2;$(x)', '--force'] });
    expect('error' in applyArgv('http://example.com')).toBe(true);
    expect('error' in applyArgv('--force')).toBe(true);
    expect('error' in applyArgv('https://a.io https://b.io')).toBe(true);
  });

  it('status commands, runhunt, instruction', () => {
    expect(commandArgv('health', '')).toMatchObject({ cmd: 'npx', args: ['tsx', 'scripts/status.ts', 'health'] });
    expect(commandArgv('runhunt', '')).toMatchObject({ cmd: 'npm', args: ['run', 'scheduler', '--', '--once', '--now'] });
    expect(instructionArgv('add call Acme --job 5')).toMatchObject({ args: ['run', 'instructions', '--', 'add', 'call', 'Acme', '--job', '5'] });
    expect(instructionArgv('done 3 sent it')).toMatchObject({ args: ['run', 'instructions', '--', 'done', '3', 'sent it'] });
    expect('error' in (instructionArgv('done x') as object)).toBe(true);
    expect(commandArgv('nope', '')).toBeNull();
  });

  it('child env has no bot token', () => {
    const e = childEnv({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '1', HOME: '/h', PATH: '/p', GMAIL_APP_PASSWORD: 'x' } as NodeJS.ProcessEnv);
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(e).toEqual({ HOME: '/h', PATH: '/p' });
  });
});

describe('kill switch and free chat', () => {
  function deps(over: Partial<BridgeDeps> = {}): { d: BridgeDeps; replies: string[]; spawned: string[][] } {
    const replies: string[] = [];
    const spawned: string[][] = [];
    const spawn: SpawnFn = async (cmd, args) => { spawned.push([cmd, ...args]); return ok('{"result":"chat answer","session_id":"' + SID + '"}'); };
    const d: BridgeDeps = {
      root, env: { TELEGRAM_BOT_TOKEN: TOKEN, HOME: '/h' } as NodeJS.ProcessEnv, spawn,
      chat: createChatRunner({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, HOME: '/h' } as NodeJS.ProcessEnv, spawn }),
      killed: () => ({ stopped: false, reason: '' }),
      openDb: () => { throw new Error('no db'); },
      reply: async (t) => { replies.push(t); },
      typing: async () => {},
      sendDocument: async () => {},
      ...over,
    };
    return { d, replies, spawned };
  }

  it('kill switch: only read-only commands answer; others and free chat are refused but still answered', async () => {
    const { d, replies, spawned } = deps({ killed: () => ({ stopped: true, reason: 'STOP file' }) });
    await handleOwnerMessage({ text: '/runhunt' }, d);
    await handleOwnerMessage({ text: '/apply https://example.com/j' }, d);
    await handleOwnerMessage({ text: 'hello there' }, d);
    expect(spawned).toHaveLength(0);
    expect(replies).toHaveLength(3);
    for (const r of replies) expect(r).toContain('Kill switch');
    await handleOwnerMessage({ text: '/limits' }, d);
    expect(spawned).toEqual([['npx', 'tsx', 'scripts/status.ts', 'limits']]);
  });

  it('free chat spawns claude with no token, no bypass flag, prompt after --, and keeps the session id', async () => {
    const { d, replies, spawned } = deps();
    await handleOwnerMessage({ text: 'what is up' }, d); // private chat (no topics file)
    expect(replies).toEqual(['chat answer']);
    const argv = spawned[0]!;
    expect(argv[0]).toBe('claude');
    expect(argv).toEqual(['claude', '-p', '--output-format', 'json', '--', 'what is up']);
    expect(argv.join(' ')).not.toMatch(/dangerously|bypass/i);
    expect(readChatSessions(root).private).toBe(SID);
    await handleOwnerMessage({ text: 'and now' }, d);
    expect(spawned[1]).toEqual(['claude', '-p', '--output-format', 'json', '--resume', SID, '--', 'and now']);
  });

  it('free chat env is a small allowlist without the token', async () => {
    let seen: Record<string, string> = {};
    const spawn: SpawnFn = async (_c, _a, o) => { seen = o.env; return ok('{"result":"x"}'); };
    const r = createChatRunner({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, HOME: '/h', PATH: '/p', SECRET: 's' } as NodeJS.ProcessEnv, spawn });
    await r.ask('private', 'hi');
    expect(Object.keys(seen).sort()).toEqual(['HOME', 'PATH']);
    expect(() => buildChatArgv('x', 'not-a-uuid')).toThrow();
  });

  it('free text outside the chat topic is refused; inside it is answered', async () => {
    mkdirSync(path.join(root, '.jobber'), { recursive: true });
    writeFileSync(topicsPath(root), JSON.stringify({ chat_id: '-100', forum: true, topics: { chat: 11, alerts: 12 } }));
    const { d, replies, spawned } = deps();
    await handleOwnerMessage({ text: 'hi', threadId: 12 }, d);
    expect(replies[0]).toContain('chat');
    expect(spawned).toHaveLength(0);
    await handleOwnerMessage({ text: 'hi', threadId: 11 }, d);
    expect(spawned).toHaveLength(1);
    expect(readChatSessions(root)['topic:11']).toBe(SID);
  });
});

describe('callback routing (drip buttons vs window buttons)', () => {
  function build() {
    const cfg = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv)!;
    const bot = new Bot(TOKEN, {
      botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'jobber_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never,
    });
    const api: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      api.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: {} } as never;
    });
    const windowCalls: string[] = [];
    const windowViews = { handleCallback: async (a: { data?: string }) => { windowCalls.push(String(a.data)); } } as never;
    createBridgeBot(cfg, {
      env: { TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv, root, bot, windowViews,
      killed: () => ({ stopped: false, reason: '' }),
    });
    return { bot, api, windowCalls };
  }
  const cb = (fromId: number, data: string) => ({
    update_id: 2,
    callback_query: {
      id: 'cq1', chat_instance: 'ci', data,
      from: { id: fromId, is_bot: false, first_name: 'x' },
      message: { message_id: 9, date: 1, chat: { id: 42, type: 'private' } },
    },
  });

  it('a drip button (dr:) is handled by the drip handler and never reaches the window handler', async () => {
    const { bot, api, windowCalls } = build();
    await bot.handleUpdate(cb(42, 'dr:nonsense') as never);
    expect(windowCalls).toEqual([]);
    expect(api.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(1);
  });

  it('a window button (w|) reaches the window handler and not the drip handler', async () => {
    const { bot, api, windowCalls } = build();
    await bot.handleUpdate(cb(42, 'w|r|abc') as never);
    expect(windowCalls).toEqual(['w|r|abc']);
    // The fake window handler answers nothing, so the drip handler must not have answered either.
    expect(api.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(0);
  });

  it('callbacks from a non-owner id reach neither handler', async () => {
    const { bot, api, windowCalls } = build();
    await bot.handleUpdate(cb(99, 'dr:status') as never);
    await bot.handleUpdate(cb(99, 'w|r|abc') as never);
    expect(windowCalls).toEqual([]);
    expect(api).toHaveLength(0);
  });
});
