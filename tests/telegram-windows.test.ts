import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run } from '../src/platform/tmux.js';
import type { ApiResult, TelegramApi } from '../src/telegram/api.js';
import { readTopicState, topicsPath } from '../src/telegram/topics.js';
import { IDLE_PAUSE_MS, MAX_VIEWS, WindowViews, type WindowsDeps } from '../src/telegram/windows/manager.js';
import { ensureWindowTopic, topicKindOf, windowOfThread } from '../src/telegram/windows/topics.js';
import { handleWindowsMessage } from '../src/telegram/windows/bridge.js';
import { cleanTyped, paneLines, renderView, stripAnsi, viewKeyboard } from '../src/telegram/windows/view.js';
import { redactSecrets } from '../src/safety/redact.js';

const OWNER = 42;
const CHAT = '-100500';

interface Call { method: string; payload: Record<string, unknown> }

class FakeTmux {
  windows: Record<string, { name: string; dead?: boolean }[]> = { Jobber: [{ name: 'hunt' }, { name: 'bridge' }, { name: 'wake-1' }, { name: 'drip-mail-2', dead: true }], Secret: [{ name: 'private' }] };
  screen: Record<string, string> = {};
  calls: string[][] = [];
  down = false;
  run: Run = async (_cmd, args) => {
    this.calls.push(args);
    if (this.down) return { stdout: '', code: 1 };
    if (args[0] === 'list-windows') {
      const s = String(args[2]).replace(/^=/, '');
      const w = this.windows[s];
      if (!w) return { stdout: '', code: 1 };
      return { stdout: w.map((x, i) => `${i}|${x.name}|${x.dead ? 1 : 0}`).join('\n'), code: 0 };
    }
    if (args[0] === 'capture-pane') {
      const m = /^=(.+):(\d+)$/.exec(String(args[3]));
      const w = m ? this.windows[m[1]!]?.[Number(m[2])] : undefined;
      if (!w) return { stdout: '', code: 1 };
      return { stdout: this.screen[w.name] ?? '', code: 0 };
    }
    return { stdout: '', code: 0 };
  };
  sendKeys = (): string[][] => this.calls.filter((c) => c[0] === 'send-keys');
}

function fakeApi(): { api: TelegramApi; calls: Call[]; failNext: Array<ApiResult<unknown>>; nextMsg: number } {
  const state = { calls: [] as Call[], failNext: [] as Array<ApiResult<unknown>>, nextMsg: 100 };
  const api: TelegramApi = {
    async call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
      state.calls.push({ method, payload });
      if (method === 'editMessageText' && state.failNext.length) return state.failNext.shift() as ApiResult<T>;
      if (method === 'sendMessage') return { ok: true, result: { message_id: state.nextMsg++ } as T };
      if (method === 'createForumTopic') return { ok: true, result: { message_thread_id: 900 + state.calls.length } as T };
      return { ok: true, result: {} as T };
    },
  };
  return { api, ...state, get failNext() { return state.failNext; }, get calls() { return state.calls; }, get nextMsg() { return state.nextMsg; } } as never;
}

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'tgw-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function build(over: Partial<WindowsDeps> = {}, tmux = new FakeTmux()) {
  const fa = fakeApi();
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const views = new WindowViews({
    api: fa.api, run: tmux.run, root, chatId: CHAT, isOwner: (id) => id === OWNER, sessions: ['Jobber'], inputEnabled: false,
    killed: () => false, redact: (s) => s, protectedWindows: ['bridge', 'manager'], hiddenWindows: [], now: clock.now, autoPoll: false, pollMs: 3000, ...over,
  });
  return { views, tmux, fa, clock };
}

const where = { chatId: CHAT, threadId: 5, messageId: 1 };
const cbq = (data: string, from: number = OWNER) => ({ fromId: from, callbackId: `cb-${data}`, data, chatId: CHAT, threadId: 5 });
const methods = (c: Call[], m: string): Call[] => c.filter((x) => x.method === m);

/** Open the view of a window through /window <name> and return its view id. */
async function open(b: ReturnType<typeof build>, name = 'hunt'): Promise<string> {
  const before = b.views.viewIds();
  await b.views.handleCommand('window', name, where);
  const id = b.views.viewIds().find((x) => !before.includes(x));
  if (!id) throw new Error('view not opened');
  return id;
}

describe('view rendering', () => {
  it('strips ANSI, trims trailing blanks, keeps the last 35 lines, clips long lines', () => {
    const text = `\x1b[31mred\x1b[0m\n${Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')}\n${'x'.repeat(300)}\n\n\n`;
    const ls = paneLines(text);
    expect(ls).toHaveLength(35);
    expect(ls[34]!.length).toBe(100);
    expect(ls[34]!.endsWith('…')).toBe(true);
    expect(stripAnsi('a\x1b]0;title\x07b\x1b[2Jc')).toBe('abc');
  });

  it('escapes HTML and caps the whole message at 3800 characters', () => {
    const h = { window: 'a<b>', session: 'Jobber', running: true, at: new Date(0), mode: 'live' as const, inputEnabled: false, protectedWindow: false };
    const out = renderView(h, '<script>&</script>\n' + Array.from({ length: 35 }, () => '<'.repeat(100)).join('\n'));
    expect(out.length).toBeLessThanOrEqual(3800);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;&lt;&lt;');
    expect(out).toContain('a&lt;b&gt;');
    expect(out).toContain('05:30:00 IST');
    expect(out).toContain('view only');
  });

  it('redaction is applied before the view text is built', async () => {
    const tmux = new FakeTmux();
    tmux.screen.hunt = 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and tok-LITERAL-secret-1';
    const b = build({ redact: (s) => redactSecrets(s, ['tok-LITERAL-secret-1']) }, tmux);
    await open(b);
    const text = String(methods(b.fa.calls, 'sendMessage')[0]!.payload.text);
    expect(text).not.toContain('tok-LITERAL');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).toContain('[redacted]');
  });

  it('keyboards: view only has one row, input adds three, callback_data <= 64 bytes', () => {
    expect(viewKeyboard('v1', 'live', false)).toHaveLength(1);
    const kb = viewKeyboard('v999999', 'paused', true);
    expect(kb).toHaveLength(4);
    expect(kb[0]!.map((b) => b.text)).toEqual(['Refresh', 'Resume', 'Close view']);
    expect(kb[1]!.map((b) => b.text)).toEqual(['Enter', 'Esc', 'Tab', 'Ctrl+C']);
    expect(kb[2]!.map((b) => b.text)).toEqual(['Up', 'Down', 'Left', 'Right']);
    expect(kb[3]!.map((b) => b.text)).toEqual(['y', 'n', '1', '2', '3']);
    for (const row of kb) for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('cleanTyped removes control characters', () => {
    expect(cleanTyped('a\x1b[31m\nb‮c\x00')).toBe('a[31m bc');
  });
});

describe('listing and allowlist', () => {
  it('lists only allowed-session windows, 2 per row, with status dots', async () => {
    const b = build();
    await b.views.handleCommand('windows', '', where);
    const msg = methods(b.fa.calls, 'sendMessage')[0]!;
    const kb = (msg.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    const texts = kb.flat().map((x) => x.text);
    expect(texts).toContain('🟢 hunt');
    expect(texts).toContain('🔴 drip-mail-2');
    expect(texts.join(' ')).not.toContain('private');
    expect(kb[0]).toHaveLength(2);
    for (const x of kb.flat()) expect(Buffer.byteLength(x.callback_data)).toBeLessThanOrEqual(64);
    expect(msg.payload.message_thread_id).toBe(5);
  });

  it('a window of another session is refused', async () => {
    const b = build();
    await b.views.handleCommand('window', 'private', where);
    expect(b.views.viewCount()).toBe(0);
    expect(String(methods(b.fa.calls, 'sendMessage')[0]!.payload.text)).toContain('No window named');
    expect(b.tmux.calls.some((c) => c.join(' ').includes('Secret'))).toBe(false);
  });

  it('tmux down or session absent: clear message', async () => {
    const tmux = new FakeTmux();
    tmux.down = true;
    const b = build({}, tmux);
    await b.views.handleCommand('windows', '', where);
    expect(String(methods(b.fa.calls, 'sendMessage')[0]!.payload.text)).toBe('Jobber tmux session is not running');
  });

  it('other commands are not handled', async () => {
    const b = build();
    expect(await b.views.handleCommand('status', '', where)).toBe(false);
  });

  it('tapping a list button opens a view; a stale list id says expired', async () => {
    const b = build();
    await b.views.handleCommand('windows', '', where);
    const kb = (methods(b.fa.calls, 'sendMessage')[0]!.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    await b.views.handleCallback(cbq(kb[0]![0]!.callback_data));
    expect(b.views.viewCount()).toBe(1);
    await b.views.handleCallback(cbq('w|o|o9999'));
    const answers = methods(b.fa.calls, 'answerCallbackQuery');
    expect(String(answers[answers.length - 1]!.payload.text)).toContain('expired');
  });
});

describe('live view behaviour', () => {
  it('unchanged text makes no edit; a change edits once; throttled within 3 s', async () => {
    const b = build();
    const id = await open(b);
    b.tmux.screen.hunt = 'first';
    b.clock.advance(3000);
    expect(await b.views.pollOnce(id)).toBe('edited');
    b.clock.advance(500);
    expect(await b.views.pollOnce(id)).toBe('same');
    b.tmux.screen.hunt = 'second';
    b.clock.advance(500);
    expect(await b.views.pollOnce(id)).toBe('throttled');
    b.clock.advance(2000);
    expect(await b.views.pollOnce(id)).toBe('edited');
    expect(methods(b.fa.calls, 'editMessageText')).toHaveLength(2);
    const first = methods(b.fa.calls, 'editMessageText')[0]!.payload;
    expect(first.parse_mode).toBe('HTML');
    expect(first.message_id).toBe(100);
  });

  it('honours 429 retry_after', async () => {
    const b = build();
    const id = await open(b);
    b.tmux.screen.hunt = 'x';
    b.clock.advance(3000);
    b.fa.failNext.push({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 20' });
    expect(await b.views.pollOnce(id)).toBe('throttled');
    b.clock.advance(10_000);
    expect(await b.views.pollOnce(id)).toBe('throttled');
    b.clock.advance(11_000);
    expect(await b.views.pollOnce(id)).toBe('edited');
  });

  it('pauses after 10 minutes without a button press and a Refresh resumes it', async () => {
    const b = build();
    const id = await open(b);
    b.clock.advance(IDLE_PAUSE_MS + 1);
    expect(await b.views.pollOnce(id)).toBe('paused');
    expect(b.views.viewMode(id)).toBe('paused');
    const last = methods(b.fa.calls, 'editMessageText').pop()!.payload;
    expect(String(last.text)).toContain('paused, tap Refresh');
    await b.views.handleCallback(cbq(`w|r|${id}`));
    expect(b.views.viewMode(id)).toBe('live');
  });

  it('window closed: edits to "window closed", removes buttons and the view', async () => {
    const b = build();
    const id = await open(b, 'wake-1');
    b.tmux.windows.Jobber = b.tmux.windows.Jobber!.filter((w) => w.name !== 'wake-1');
    expect(await b.views.pollOnce(id)).toBe('closed');
    const last = methods(b.fa.calls, 'editMessageText').pop()!.payload;
    expect(String(last.text)).toContain('window closed');
    expect(last.reply_markup).toEqual({ inline_keyboard: [] });
    expect(b.views.viewCount()).toBe(0);
  });

  it('at most 4 views are live: the oldest pauses', async () => {
    const b = build();
    const ids: string[] = [];
    for (const n of ['hunt', 'bridge', 'wake-1', 'drip-mail-2']) { ids.push(await open(b, n)); b.clock.advance(10); }
    expect(ids).toHaveLength(MAX_VIEWS);
    b.tmux.windows.Jobber!.push({ name: 'followups' });
    ids.push(await open(b, 'followups'));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(b.views.viewMode(ids[0]!)).toBe('paused');
    expect(b.views.viewMode(ids[4]!)).toBe('live');
  });

  it('the same window again replaces the older view message', async () => {
    const b = build();
    await open(b);
    await b.views.handleCommand('window', 'hunt', where);
    expect(b.views.viewCount()).toBe(1);
  });
});

describe('callbacks', () => {
  it('non-owner is ignored silently, owner is always answered', async () => {
    const b = build();
    const id = await open(b);
    await b.views.handleCallback(cbq(`w|r|${id}`, 7));
    expect(methods(b.fa.calls, 'answerCallbackQuery')).toHaveLength(0);
    for (const data of [`w|r|${id}`, `w|p|${id}`, 'w|r|vNOPE', 'garbage', `w|kzz|${id}`, `w|ken|${id}`, `w|c|${id}`]) {
      const before = methods(b.fa.calls, 'answerCallbackQuery').length;
      await b.views.handleCallback(cbq(data));
      expect(methods(b.fa.calls, 'answerCallbackQuery').length).toBe(before + 1);
    }
  });

  it('an unknown view id answers "expired"', async () => {
    const b = build();
    await b.views.handleCallback(cbq('w|r|v77'));
    expect(String(methods(b.fa.calls, 'answerCallbackQuery')[0]!.payload.text)).toContain('expired');
  });

  it('pause then resume toggles the mode; close removes the view', async () => {
    const b = build();
    const id = await open(b);
    await b.views.handleCallback(cbq(`w|p|${id}`));
    expect(b.views.viewMode(id)).toBe('paused');
    await b.views.handleCallback(cbq(`w|p|${id}`));
    expect(b.views.viewMode(id)).toBe('live');
    await b.views.handleCallback(cbq(`w|c|${id}`));
    expect(b.views.viewCount()).toBe(0);
  });
});

describe('input', () => {
  it('is off by default: view only keyboard, buttons and typed text refused', async () => {
    const b = build();
    const id = await open(b);
    const kb = (methods(b.fa.calls, 'sendMessage')[0]!.payload.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(kb).toHaveLength(1);
    await b.views.handleCallback(cbq(`w|ken|${id}`));
    expect(b.tmux.sendKeys()).toHaveLength(0);
    const handled = await b.views.handleText({ text: 'hello', chatId: CHAT, threadId: 5, replyToMessageId: 100 });
    expect(handled).toBe(true);
    expect(b.tmux.sendKeys()).toHaveLength(0);
    expect(String(methods(b.fa.calls, 'sendMessage').pop()!.payload.text)).toContain('input is off');
  });

  it('enabled: buttons and typed replies call send-keys with literal text, then Enter', async () => {
    const b = build({ inputEnabled: true });
    const id = await open(b);
    const kb = (methods(b.fa.calls, 'sendMessage')[0]!.payload.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(kb).toHaveLength(4);
    await b.views.handleCallback(cbq(`w|kky|${id}`));
    await b.views.handleCallback(cbq(`w|kcc|${id}`));
    expect(b.tmux.sendKeys()[0]).toEqual(['send-keys', '-t', '=Jobber:0', '-l', '--', 'y']);
    expect(b.tmux.sendKeys()[1]).toEqual(['send-keys', '-t', '=Jobber:0', 'C-c']);
    await b.views.handleText({ text: 'run it\nnow', chatId: CHAT, replyToMessageId: 100 });
    const keys = b.tmux.sendKeys();
    expect(keys[2]).toEqual(['send-keys', '-t', '=Jobber:=hunt', '-l', '--', 'run it now']);
    expect(keys[3]).toEqual(['send-keys', '-t', '=Jobber:=hunt', 'Enter']);
  });

  it('kill switch refuses buttons and text', async () => {
    let killed = false;
    const b = build({ inputEnabled: true, killed: () => killed });
    const id = await open(b);
    killed = true;
    await b.views.handleCallback(cbq(`w|ken|${id}`));
    await b.views.handleText({ text: 'x', chatId: CHAT, replyToMessageId: 100 });
    expect(b.tmux.sendKeys()).toHaveLength(0);
    expect(String(methods(b.fa.calls, 'sendMessage').pop()!.payload.text)).toContain('Kill switch');
  });

  it('protected windows: view allowed, view-only keyboard, input refused', async () => {
    const b = build({ inputEnabled: true });
    const id = await open(b, 'bridge');
    const kb = (methods(b.fa.calls, 'sendMessage')[0]!.payload.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(kb).toHaveLength(1);
    await b.views.handleCallback(cbq(`w|ken|${id}`));
    await b.views.handleText({ text: 'x', chatId: CHAT, replyToMessageId: 100 });
    expect(b.tmux.sendKeys()).toHaveLength(0);
    expect(String(methods(b.fa.calls, 'sendMessage').pop()!.payload.text)).toContain('protected');
  });

  it('too long and empty text are refused; slash commands pass through', async () => {
    const b = build({ inputEnabled: true });
    await open(b);
    await b.views.handleText({ text: 'a'.repeat(2001), chatId: CHAT, replyToMessageId: 100 });
    await b.views.handleText({ text: '\x01\x02', chatId: CHAT, replyToMessageId: 100 });
    expect(b.tmux.sendKeys()).toHaveLength(0);
    expect(await b.views.handleText({ text: '/status', chatId: CHAT, replyToMessageId: 100 })).toBe(false);
  });

  it('text outside any window topic or view is not handled (normal routing continues)', async () => {
    const b = build({ inputEnabled: true });
    expect(await b.views.handleText({ text: 'hi', chatId: CHAT, threadId: 31 })).toBe(false);
  });

  it('typed text in a window topic goes to that window; never to a window outside the allowlist', async () => {
    const b = build({ inputEnabled: true });
    await b.views.handleCommand('window', 'hunt', { chatId: CHAT, messageId: 1 });
    const tid = readTopicState(root)!.windows!.hunt!;
    await b.views.handleText({ text: 'ls', chatId: CHAT, threadId: tid });
    expect(b.tmux.sendKeys().some((k) => k.join(' ') === 'send-keys -t =Jobber:=hunt -l -- ls')).toBe(true);
    // a stored topic for a window that is only in another session never types (name not in Jobber)
    const st = readTopicState(root)!;
    writeFileSync(topicsPath(root), JSON.stringify({ ...st, windows: { ...st.windows, private: 777 } }));
    await b.views.handleText({ text: 'rm', chatId: CHAT, threadId: 777 });
    expect(b.tmux.sendKeys().some((k) => k.join(' ').includes('private'))).toBe(false);
  });

  it('handleWindowsMessage routes commands and text, and never throws', async () => {
    const b = build();
    expect(await handleWindowsMessage(b.views, { text: '/windows@jobber_bot', chatId: CHAT })).toBe(true);
    expect(await handleWindowsMessage(b.views, { text: '/limits', chatId: CHAT })).toBe(false);
    expect(await handleWindowsMessage(b.views, { text: 'plain', chatId: CHAT })).toBe(false);
  });
});

describe('window topics', () => {
  it('creates a topic per long-lived window, persists it, keeps the fixed topics', async () => {
    mkdirSync(path.join(root, '.jobber'), { recursive: true });
    writeFileSync(topicsPath(root), JSON.stringify({ chat_id: CHAT, forum: true, topics: { alerts: 11, chat: 16 } }));
    const fa = fakeApi();
    const id1 = await ensureWindowTopic(fa.api, root, CHAT, 'hunt', 'own');
    const id2 = await ensureWindowTopic(fa.api, root, CHAT, 'hunt', 'own');
    expect(id1).toBeTypeOf('number');
    expect(id2).toBe(id1);
    expect(methods(fa.calls, 'createForumTopic')).toHaveLength(1);
    const st = readTopicState(root)!;
    expect(st.topics).toEqual({ alerts: 11, chat: 16 });
    expect(st.windows).toEqual({ hunt: id1 });
    expect(windowOfThread(root, id1!)).toBe('hunt');
    expect(windowOfThread(root, 11)).toBeNull();
    expect(existsSync(topicsPath(root))).toBe(true);
    expect(JSON.parse(readFileSync(topicsPath(root), 'utf8')).windows.hunt).toBe(id1);
  });

  it('wake and drip windows use the shared wakes and drips topics', async () => {
    expect(topicKindOf('wake-abc')).toBe('wakes');
    expect(topicKindOf('drip-mail-x')).toBe('drips');
    expect(topicKindOf('scheduler')).toBe('own');
    const fa = fakeApi();
    const w = await ensureWindowTopic(fa.api, root, CHAT, 'wake-1', 'wakes');
    expect(readTopicState(root)!.topics.wakes).toBe(w);
    expect(readTopicState(root)!.windows).toBeUndefined();
  });

  it('a chat without topics gives no thread id', async () => {
    const api: TelegramApi = { call: async () => ({ ok: false, description: 'Bad Request: the chat is not a forum' }) } as never;
    expect(await ensureWindowTopic(api, root, CHAT, 'hunt', 'own')).toBeUndefined();
  });
});

describe('hidden daemons and worker grouping (Phase 4)', () => {
  const labels = {
    mail: { kind: 'worker', description: 'Mail lane: sends ONE email per work item' },
    linkedin: { kind: 'worker', description: 'LinkedIn lane: one action per item' },
  };
  const mk = () => {
    const t = new FakeTmux();
    t.windows.Jobber = [{ name: 'bridge' }, { name: 'scheduler' }, { name: 'web' }, { name: 'chat' }, { name: 'manager' }, { name: 'mail' }, { name: 'linkedin' }, { name: 'wake-1' }];
    t.screen.scheduler = 'SECRET-SCHEDULER-LOG';
    return t;
  };

  it('the list hides the three daemons and shows workers, then manager and chat, with role labels', async () => {
    const b = build({ hiddenWindows: ['bridge', 'scheduler', 'web'], windowLabels: labels }, mk());
    await b.views.handleCommand('windows', '', where);
    const kb = (methods(b.fa.calls, 'sendMessage')[0]!.payload.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard;
    const texts = kb.flat().map((x) => x.text).filter((x) => x !== 'Refresh list');
    expect(texts).toEqual(['🟢 mail · Mail lane', '🟢 linkedin · LinkedIn lane', '🟢 manager · Manager', '🟢 chat · Chat', '🟢 wake-1']);
  });

  it('a hidden daemon asked by name answers "not available" and the pane is never read', async () => {
    const b = build({ hiddenWindows: ['bridge', 'scheduler', 'web'] }, mk());
    for (const n of ['bridge', 'scheduler', 'web']) await b.views.handleCommand('window', n, where);
    const texts = methods(b.fa.calls, 'sendMessage').map((c) => String(c.payload.text));
    expect(texts).toEqual(Array(3).fill('That window is not available in Telegram.'));
    expect(b.views.viewCount()).toBe(0);
    expect(b.tmux.calls.some((c) => c[0] === 'capture-pane')).toBe(false);
    expect(JSON.stringify(b.fa.calls)).not.toContain('SECRET-SCHEDULER-LOG');
  });

  it('defaults hide the three daemons; manager, chat, workers and temporary windows stay openable', async () => {
    const b = build({ hiddenWindows: undefined }, mk());
    await b.views.handleCommand('window', 'scheduler', where);
    expect(b.views.viewCount()).toBe(0);
    for (const n of ['manager', 'chat', 'mail', 'wake-1']) await b.views.handleCommand('window', n, where);
    expect(b.views.viewCount()).toBe(4);
  });

  it('worker windows get their own topic named like the window; wake and drip stay shared', async () => {
    mkdirSync(path.join(root, '.jobber'), { recursive: true });
    writeFileSync(topicsPath(root), JSON.stringify({ chat_id: CHAT, forum: true, topics: { alerts: 11 } }));
    const fa = fakeApi();
    for (const n of ['mail', 'linkedin', 'boards', 'sources', 'pipeline', 'apply']) {
      expect(topicKindOf(n)).toBe('own');
      await ensureWindowTopic(fa.api, root, CHAT, n, 'own');
    }
    const names = methods(fa.calls, 'createForumTopic').map((c) => c.payload.name);
    expect(names).toEqual(['mail', 'linkedin', 'boards', 'sources', 'pipeline', 'apply']);
    expect(topicKindOf('wake-9')).toBe('wakes');
    expect(topicKindOf('drip-linkedin-3')).toBe('drips');
  });
});
