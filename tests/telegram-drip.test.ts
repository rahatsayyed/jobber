// /drip in the bridge (src/telegram/drip.ts): status text, confirm flow, owner-only callbacks, callback data size, and the chat login message.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bot } from 'grammy';
import { openDb } from '../src/db.js';
import { createBridgeBot } from '../src/telegram/bridge.js';
import { handleOwnerMessage, type BridgeDeps } from '../src/telegram/commands.js';
import { ConfirmStore, DripController, MAX_CALLBACK_BYTES, renderDripStatus, STATUS_BUTTONS, CONFIRM_TTL_MS, type Button, type DripIo } from '../src/telegram/drip.js';
import { loadTelegramConfig } from '../src/telegram/config.js';
import type { ProcResult, SpawnFn } from '../src/telegram/spawn.js';
import { readFreshRequest, recordRefusal } from '../src/scheduler/dripRequest.js';
import { setState } from '../src/scheduler/runLog.js';
import { STATE_NEXT_AT } from '../src/scheduler/mailDrip.js';

const TOKEN = '123456:SECRET-token_abc';
const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
let root: string;
let dbFile: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tgdrip-'));
  dbFile = path.join(root, 'jobs.db');
  openDb(dbFile).close(); // create the schema once
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function io(over: Partial<DripIo> = {}) {
  const replies: string[] = [];
  const buttons: Array<{ md: string; rows: Button[][] }> = [];
  const value: DripIo = {
    env: {}, openDb: () => openDb(dbFile), now: () => NOW, killed: () => ({ stopped: false, reason: '' }),
    reply: async (m) => void replies.push(m),
    sendButtons: async (md, rows) => void buttons.push({ md, rows }),
    ...over,
  };
  return { io: value, replies, buttons };
}
const pendingRequest = (lane: 'mail' | 'linkedin', at: Date = NOW) => { const db = openDb(dbFile); try { return readFreshRequest(db, lane, at); } finally { db.close(); } };
const tokenOf = (b: { rows: Button[][] }): string => (b.rows[0]?.[0]?.data ?? '').split(':')[2] ?? '';

describe('status text', () => {
  it('shows both lanes: enabled, next tick, last send, today count and cap, last refusal', () => {
    const db = openDb(dbFile);
    setState(db, STATE_NEXT_AT, new Date(NOW.getTime() + 6 * 60_000).toISOString(), NOW);
    recordRefusal(db, 'mail', 'quiet_hours', new Date(NOW.getTime() - 5 * 60_000), 'abc');
    const text = renderDripStatus(db, { EMAIL_MAX_PER_DAY: '20' }, NOW);
    db.close();
    expect(text).toContain('**Mail**: on');
    expect(text).toContain('**next tick:** not before 13:36 IST (in 6 min)');
    expect(text).toContain('**last send:** none yet');
    expect(text).toContain('**today:** **0** sent, cap 20');
    expect(text).toContain('**last refusal:** quiet_hours at 13:25 IST (5 min ago)');
    expect(text).toContain('**LinkedIn**: on');
    expect(text).toMatch(/invites \*\*0\/\d+\*\*, messages \*\*0\/\d+\*\*/);
  });
  it('shows OFF reasons, dry run and a waiting request', () => {
    const db = openDb(dbFile);
    const text = renderDripStatus(db, { LINKEDIN_DRIP: 'false', EMAIL_DRIP_MIN_BATCH: 'x', JOBBER_DRY_RUN: '1' }, NOW);
    db.close();
    expect(text).toContain('Dry run is ON');
    expect(text).toContain('⏸ **Mail**');
    expect(text).toMatch(/\*\*Mail\*\*: OFF \(bad config/);
    expect(text).toContain('**LinkedIn**: OFF (LINKEDIN_DRIP=false)');
  });
  it('/drip sends the status with the three buttons', async () => {
    const t = io();
    await new DripController().command('', t.io);
    expect(t.buttons).toHaveLength(1);
    expect(t.buttons[0]?.rows).toEqual(STATUS_BUTTONS);
    expect(STATUS_BUTTONS.flat().map((b) => b.text)).toEqual(['Mail now', 'LinkedIn now', 'Status']);
  });
});

describe('confirm flow', () => {
  it('a "now" press only asks; nothing is written until Confirm, and the token is single use', async () => {
    const c = new DripController();
    const t = io();
    await c.callback('dr:m', t.io, 42);
    expect(t.buttons[0]?.md).toMatch(/real email/);
    expect(t.buttons[0]?.rows[0]?.map((b) => b.text)).toEqual(['Confirm', 'Cancel']);
    expect(pendingRequest('mail')).toBeNull();
    const token = tokenOf(t.buttons[0]!);
    await c.callback(`dr:y:${token}`, t.io, 42);
    expect(pendingRequest('mail')).not.toBeNull();
    expect(t.replies.at(-1)).toMatch(/requested.*within 30 s.*mail or linkedin topic/);
    // second use of the same token is refused and writes nothing new
    const before = t.replies.length;
    await c.callback(`dr:y:${token}`, t.io, 42);
    expect(t.replies[before]).toMatch(/expired or was already used/);
  });

  it('typed /drip linkedin now goes through the same confirm step', async () => {
    const c = new DripController();
    const t = io();
    await c.command('linkedin now', t.io, 42);
    expect(t.buttons[0]?.md).toMatch(/real LinkedIn action/);
    expect(pendingRequest('linkedin')).toBeNull();
    await c.callback(`dr:y:${tokenOf(t.buttons[0]!)}`, t.io, 42);
    expect(pendingRequest('linkedin')).not.toBeNull();
    expect(pendingRequest('mail')).toBeNull();
    await c.command('bogus now', t.io, 42);
    expect(t.replies.at(-1)).toMatch(/^usage:/);
  });

  it('cancel writes nothing and burns the token', async () => {
    const c = new DripController();
    const t = io();
    await c.callback('dr:l', t.io, 42);
    const token = tokenOf(t.buttons[0]!);
    await c.callback(`dr:n:${token}`, t.io, 42);
    expect(t.replies.at(-1)).toMatch(/Cancelled/);
    await c.callback(`dr:y:${token}`, t.io, 42);
    expect(pendingRequest('linkedin')).toBeNull();
  });

  it('a token expires after two minutes', () => {
    let ms = 1_000_000;
    const store = new ConfirmStore(() => ms);
    const a = store.issue('mail');
    ms += CONFIRM_TTL_MS - 1;
    expect(store.consume(a)).toBe('mail');
    const b = store.issue('mail');
    ms += CONFIRM_TTL_MS + 1;
    expect(store.consume(b)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('a token is bound to the user who asked, and an unknown token is refused', () => {
    const store = new ConfirmStore();
    const a = store.issue('mail', 42);
    expect(store.consume(a, 43)).toBeNull();
    expect(store.consume(a, 42)).toBeNull(); // burned by the refused try
    expect(store.consume('deadbeef', 42)).toBeNull();
  });

  it('refuses while the kill switch is on, at ask time and at confirm time', async () => {
    const c = new DripController();
    const t = io({ killed: () => ({ stopped: true, reason: 'STOP file' }) });
    await c.callback('dr:m', t.io, 42);
    expect(t.replies.at(-1)).toMatch(/Kill switch is on/);
    expect(t.buttons).toHaveLength(0);
    const live = io();
    await c.callback('dr:m', live.io, 42);
    const token = tokenOf(live.buttons[0]!);
    const stopped = io({ killed: () => ({ stopped: true, reason: 'JOBBER_KILL' }) });
    await c.callback(`dr:y:${token}`, stopped.io, 42);
    expect(stopped.replies.at(-1)).toMatch(/Kill switch is on/);
    expect(pendingRequest('mail')).toBeNull();
  });

  it('callback data stays within 64 bytes and an oversized or foreign payload is ignored', async () => {
    const t = io();
    const c = new DripController();
    await c.callback('dr:m', t.io, 42);
    const all = [...STATUS_BUTTONS.flat(), ...t.buttons[0]!.rows.flat()];
    for (const b of all) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
    const before = t.replies.length + t.buttons.length;
    await c.callback(`dr:y:${'a'.repeat(80)}`, t.io, 42);
    await c.callback('other:y:abcd', t.io, 42);
    expect(t.replies.length + t.buttons.length).toBe(before);
  });
});

describe('bridge wiring (real grammY Bot, fake api)', () => {
  function build() {
    const cfg = loadTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv)!;
    const bot = new Bot(TOKEN, {
      botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'jobber_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never,
    });
    const api: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      api.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: true } as never;
    });
    createBridgeBot(cfg, {
      env: { TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv, root, spawn: (async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })) as SpawnFn,
      killed: () => ({ stopped: false, reason: '' }), openDb: () => openDb(dbFile), bot,
    });
    return { bot, api };
  }
  const message = (id: number, text: string) => ({
    update_id: 1,
    message: { message_id: 7, date: 1, chat: { id: 42, type: 'private' }, from: { id, is_bot: false, first_name: 'x' }, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] },
  });
  const press = (id: number, data: string) => ({
    update_id: 2,
    callback_query: {
      id: 'cb1', chat_instance: 'ci', from: { id, is_bot: false, first_name: 'x' }, data,
      message: { message_id: 8, date: 1, chat: { id: 42, type: 'private' }, text: 'status' },
    },
  });

  it('/drip sends a status message with an inline keyboard', async () => {
    const { bot, api } = build();
    await bot.handleUpdate(message(42, '/drip') as never);
    const sent = api.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    const kb = (sent[0]!.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(kb.flat().map((b) => b.callback_data)).toEqual(['dr:m', 'dr:l', 'dr:s']);
    expect(String(sent[0]!.payload.text)).toContain('<b>Drip lanes</b>');
  });

  it('an owner button press is answered at once; Confirm writes the request after the confirm message', async () => {
    const { bot, api } = build();
    await bot.handleUpdate(press(42, 'dr:m') as never);
    expect(api.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    const ask = api.filter((c) => c.method === 'sendMessage').at(-1)!;
    const confirmData = (ask.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
    expect(Buffer.byteLength(confirmData)).toBeLessThanOrEqual(64);
    expect(pendingRequest('mail')).toBeNull();
    await bot.handleUpdate(press(42, confirmData) as never);
    expect(pendingRequest('mail', new Date())).not.toBeNull(); // the bridge stamps the request with the real clock
  });

  it('a button press from a non-owner is ignored without any api call', async () => {
    const { bot, api } = build();
    await bot.handleUpdate(press(99, 'dr:m') as never);
    await bot.handleUpdate(press(99, 'dr:y:deadbeef') as never);
    expect(api).toHaveLength(0);
    expect(pendingRequest('mail')).toBeNull();
  });

  it('typed /drip commands go through handleOwnerMessage with the shared controller', async () => {
    const replies: string[] = [];
    const btns: string[] = [];
    const deps = {
      root, env: {}, spawn: (async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })) as SpawnFn,
      chat: { ask: async () => '' }, killed: () => ({ stopped: true, reason: 'STOP' }), openDb: () => openDb(dbFile),
      reply: async (m: string) => void replies.push(m), typing: async () => undefined, sendDocument: async () => undefined,
      sendButtons: async (m: string) => void btns.push(m), drip: new DripController(), fromId: 42,
    } as unknown as BridgeDeps;
    await handleOwnerMessage({ text: '/drip' }, deps); // status answers under the kill switch
    expect(btns).toHaveLength(1);
    await handleOwnerMessage({ text: '/drip mail now' }, deps); // a request does not
    expect(replies.at(-1)).toMatch(/Kill switch is on/);
  });
});
