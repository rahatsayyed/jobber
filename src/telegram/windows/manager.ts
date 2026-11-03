// src/telegram/windows/manager.ts
// Live views of the Jobber tmux windows in Telegram. One message per view, edited in place; the poll runs only while a
// view is open. Views live in memory (a bridge restart expires them). Only sessions of the allowlist are ever listed,
// captured or typed into. Pane text and typed text are never logged.
import { sendText, assertName, type Run } from '../../platform/tmux.js';
import { isThreadGoneError } from '../topics.js';
import type { TelegramApi } from '../api.js';
import { htmlEscape } from '../format.js';
import { ensureWindowTopic, forgetWindowTopic, topicKindOf, windowOfThread } from './topics.js';
import { cb, cleanTyped, INPUT_KEYS, renderView, viewKeyboard, type HeaderInfo, type Keyboard, type ViewMode } from './view.js';

export const POLL_MS = 3000;
export const IDLE_PAUSE_MS = 10 * 60_000;
export const MAX_VIEWS = 4;
export const MAX_TYPED = 2000;
const MAX_LIST_BUTTONS = 60;
const MAX_LIST_MAP = 200;

export interface WindowsDeps {
  api: TelegramApi;
  run: Run;
  root: string;
  /** Chat that holds the topics and the views (the group, or the owner's private chat). */
  chatId: string | null;
  isOwner: (id: unknown) => boolean;
  /** Allowed tmux sessions (same allowlist as the dashboard terminal). The first one is the primary session. */
  sessions: readonly string[];
  /** True only when TELEGRAM_WINDOW_INPUT is exactly "true". */
  inputEnabled: boolean;
  killed: () => boolean;
  redact: (text: string) => string;
  /** Windows that may be viewed but never typed into. */
  protectedWindows: readonly string[];
  now?: () => number;
  pollMs?: number;
  /** Tests turn the timers off and call pollOnce themselves. */
  autoPoll?: boolean;
}

interface WinInfo { name: string; index: number; dead: boolean }

interface View {
  id: string;
  session: string;
  window: string;
  chatId: string;
  threadId?: number;
  messageId: number;
  mode: ViewMode;
  lastBody: string;
  lastEditAt: number;
  lastPressAt: number;
  openedAt: number;
  backoffUntil: number;
  busy: boolean;
  timer?: NodeJS.Timeout;
}

export interface CallbackInput {
  fromId: unknown;
  callbackId: string;
  data: string;
  chatId?: number | string;
  threadId?: number;
}

export interface TextInput {
  text: string;
  chatId: number | string;
  threadId?: number;
  replyToMessageId?: number;
}

const NOT_RUNNING = 'Jobber tmux session is not running';

export class WindowViews {
  private views = new Map<string, View>();
  private listMap = new Map<string, { session: string; window: string }>();
  private seq = 0;
  private listSeq = 0;
  private readonly now: () => number;
  private readonly pollMs: number;

  constructor(private readonly d: WindowsDeps) {
    this.now = d.now ?? Date.now;
    this.pollMs = d.pollMs ?? POLL_MS;
  }

  // ---- tmux helpers (names validated, session in the allowlist, exact match with =)

  private allowed(session: string): boolean {
    return this.d.sessions.includes(session);
  }

  private async list(session: string): Promise<WinInfo[] | null> {
    if (!this.allowed(session)) return null;
    try { assertName(session); } catch { return null; }
    const r = await this.d.run('tmux', ['list-windows', '-t', `=${session}`, '-F', '#{window_index}|#{window_name}|#{pane_dead}']);
    if (r.code !== 0) return null;
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const [i, n, dead] = l.split('|');
      return { index: Number(i), name: n ?? '', dead: dead === '1' };
    }).filter((w) => Number.isInteger(w.index) && /^[A-Za-z0-9_.-]{1,64}$/.test(w.name));
  }

  /** Every window of every allowed session. null: tmux missing or no allowed session running. */
  private async listAll(): Promise<{ session: string; wins: WinInfo[] }[] | null> {
    const out: { session: string; wins: WinInfo[] }[] = [];
    for (const s of this.d.sessions) {
      const wins = await this.list(s);
      if (wins && wins.length > 0) out.push({ session: s, wins });
    }
    return out.length > 0 ? out : null;
  }

  private primary(): string {
    return this.d.sessions[0] ?? 'Jobber';
  }

  // ---- Telegram helpers

  private async sendPlain(chatId: string | number, threadId: number | undefined, text: string, replyTo?: number, keyboard?: Keyboard): Promise<void> {
    await this.d.api.call('sendMessage', {
      chat_id: chatId,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  private async answer(callbackId: string, text?: string): Promise<void> {
    await this.d.api.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 190) } : {}) });
  }

  // ---- /windows and /window <name>

  /** Handles `/windows` and `/window <name>`. Returns false for any other message. Never throws. */
  async handleCommand(name: string, rest: string, where: { chatId: number | string; threadId?: number; messageId?: number }): Promise<boolean> {
    if (name !== 'windows' && name !== 'window') return false;
    try {
      const all = await this.listAll();
      if (!all) {
        await this.sendPlain(where.chatId, where.threadId, NOT_RUNNING, where.messageId);
        return true;
      }
      if (name === 'windows') {
        await this.sendList(all, where);
        return true;
      }
      const wanted = rest.trim();
      const hits = all.flatMap((s) => s.wins.filter((w) => w.name === wanted).map((w) => ({ session: s.session, window: w.name })));
      const hit = hits[0];
      if (!hit) {
        await this.sendPlain(where.chatId, where.threadId, wanted ? `No window named ${wanted.slice(0, 64)}. Use /windows.` : 'usage: /window <name>, or use /windows', where.messageId);
        return true;
      }
      await this.openView(hit.session, hit.window, where.threadId);
    } catch {
      await this.sendPlain(where.chatId, where.threadId, 'Could not read the tmux windows.', where.messageId).catch(() => undefined);
    }
    return true;
  }

  private listKeyboard(all: { session: string; wins: WinInfo[] }[]): Keyboard {
    this.listMap.clear();
    const buttons: { text: string; callback_data: string }[] = [];
    for (const s of all) {
      for (const w of s.wins) {
        if (buttons.length >= MAX_LIST_BUTTONS) break;
        const id = `o${++this.listSeq}`;
        if (this.listMap.size >= MAX_LIST_MAP) break;
        this.listMap.set(id, { session: s.session, window: w.name });
        const label = s.session === this.primary() ? w.name : `${s.session}/${w.name}`;
        buttons.push({ text: `${w.dead ? '🔴' : '🟢'} ${label}`.slice(0, 40), callback_data: cb('o', id) });
      }
    }
    const kb: Keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) kb.push(buttons.slice(i, i + 2));
    kb.push([{ text: 'Refresh list', callback_data: cb('L', '0') }]);
    return kb;
  }

  private async sendList(all: { session: string; wins: WinInfo[] }[], where: { chatId: number | string; threadId?: number; messageId?: number }): Promise<void> {
    await this.sendPlain(where.chatId, where.threadId, 'tmux windows (green: running, red: exited). Tap one for a live view.', undefined, this.listKeyboard(all));
  }

  // ---- views

  private header(v: { session: string; window: string }, w: WinInfo | undefined, mode: ViewMode): HeaderInfo {
    const prot = this.isProtected(v.window);
    return { window: v.window, session: v.session, running: w ? !w.dead : false, at: new Date(this.now()), mode, inputEnabled: this.d.inputEnabled, protectedWindow: prot };
  }

  private isProtected(window: string): boolean {
    return this.d.protectedWindows.includes(window);
  }

  private showInput(window: string): boolean {
    return this.d.inputEnabled && !this.isProtected(window);
  }

  /** Capture a window: info plus redacted text, or null when it no longer exists. */
  private async snapshot(session: string, window: string): Promise<{ info: WinInfo; text: string } | null> {
    const wins = await this.list(session);
    const info = wins?.find((w) => w.name === window);
    if (!info) return null;
    const r = await this.d.run('tmux', ['capture-pane', '-p', '-t', `=${session}:${info.index}`]);
    if (r.code !== 0) return null;
    return { info, text: this.d.redact(r.stdout.slice(-200_000)) };
  }

  /** Where the view of a window goes: its own topic (long-lived), the wakes or drips topic, or no topic. */
  private async targetThread(window: string, fallback: number | undefined): Promise<number | undefined> {
    const chatId = this.d.chatId;
    if (!chatId) return fallback;
    const kind = topicKindOf(window);
    const id = await ensureWindowTopic(this.d.api, this.d.root, chatId, window, kind);
    return id === undefined ? fallback : id;
  }

  private async openView(session: string, window: string, fallbackThread: number | undefined): Promise<void> {
    const chatId = this.d.chatId;
    if (!chatId) return;
    const snap = await this.snapshot(session, window);
    if (!snap) {
      await this.sendPlain(chatId, fallbackThread, `Window ${window} is not there any more.`);
      return;
    }
    // one view per window: the older message is closed
    for (const old of [...this.views.values()]) if (old.session === session && old.window === window) await this.closeView(old, 'view moved to a newer message');
    let threadId = await this.targetThread(window, fallbackThread);
    const id = `v${++this.seq}`;
    const now = this.now();
    const text = renderView(this.header({ session, window }, snap.info, 'live'), snap.text);
    const kb = viewKeyboard(id, 'live', this.showInput(window));
    const payload = (): Record<string, unknown> => ({
      chat_id: chatId, ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: kb },
    });
    let r = await this.d.api.call<{ message_id: number }>('sendMessage', payload());
    if (!r.ok && isThreadGoneError(r.description) && threadId !== undefined) {
      forgetWindowTopic(this.d.root, window, topicKindOf(window), threadId);
      threadId = await this.targetThread(window, fallbackThread);
      r = await this.d.api.call<{ message_id: number }>('sendMessage', payload());
    }
    const messageId = r.result?.message_id;
    if (!r.ok || typeof messageId !== 'number') {
      await this.sendPlain(chatId, fallbackThread, 'Could not open the view (telegram send failed).');
      return;
    }
    const v: View = {
      id, session, window, chatId: String(chatId), threadId, messageId, mode: 'live', lastBody: this.bodyKey('live', snap), lastEditAt: now,
      lastPressAt: now, openedAt: now, backoffUntil: 0, busy: false,
    };
    this.views.set(id, v);
    this.enforceMax(v);
    this.schedule(v);
  }

  private bodyKey(mode: ViewMode, snap: { info: WinInfo; text: string }): string {
    return `${mode}|${snap.info.dead ? 'x' : 'r'}|${snap.text}`;
  }

  private enforceMax(keep: View): void {
    const live = [...this.views.values()].filter((v) => v.mode === 'live');
    while (live.length > MAX_VIEWS) {
      live.sort((a, b) => a.openedAt - b.openedAt);
      const oldest = live.shift();
      if (!oldest || oldest === keep) break;
      void this.pause(oldest).catch(() => undefined);
    }
  }

  private schedule(v: View): void {
    if (this.d.autoPoll === false) return;
    if (v.timer) clearTimeout(v.timer);
    if (v.mode !== 'live' || !this.views.has(v.id)) return;
    v.timer = setTimeout(() => { void this.pollOnce(v.id).finally(() => this.schedule(v)); }, this.pollMs);
    v.timer.unref?.();
  }

  private stopTimer(v: View): void {
    if (v.timer) clearTimeout(v.timer);
    v.timer = undefined;
  }

  /** Edit the view message. Returns "ok", "gone" (message or topic gone), or "backoff". */
  private async edit(v: View, text: string, kb: Keyboard): Promise<'ok' | 'gone' | 'backoff'> {
    const r = await this.d.api.call('editMessageText', {
      chat_id: v.chatId, message_id: v.messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: kb },
    });
    const now = this.now();
    if (r.ok) { v.lastEditAt = now; return 'ok'; }
    const desc = r.description ?? '';
    if (r.error_code === 429 || /too many requests|retry after/i.test(desc)) {
      const m = /retry after (\d+)/i.exec(desc);
      v.backoffUntil = now + (m ? Number(m[1]) : 5) * 1000 + 500;
      return 'backoff';
    }
    if (/not modified/i.test(desc)) { v.lastEditAt = now; return 'ok'; }
    if (/message to edit not found|message can't be edited|message_id_invalid|chat not found|thread not found/i.test(desc)) return 'gone';
    return 'backoff';
  }

  private async closeView(v: View, note: string): Promise<void> {
    this.stopTimer(v);
    this.views.delete(v.id);
    await this.d.api.call('editMessageText', {
      chat_id: v.chatId, message_id: v.messageId, parse_mode: 'HTML',
      text: `<b>${htmlEscape(v.window)}</b> (${htmlEscape(v.session)}): ${htmlEscape(note)}`, reply_markup: { inline_keyboard: [] },
    });
  }

  private async pause(v: View): Promise<void> {
    v.mode = 'paused';
    this.stopTimer(v);
    const snap = await this.snapshot(v.session, v.window);
    if (!snap) return this.closeView(v, 'window closed');
    await this.edit(v, renderView(this.header(v, snap.info, 'paused'), snap.text), viewKeyboard(v.id, 'paused', this.showInput(v.window)));
    v.lastBody = this.bodyKey('paused', snap);
  }

  /** One poll step of one view (the timer calls it every pollMs while the view is live). Never throws. */
  async pollOnce(id: string, opts: { force?: boolean } = {}): Promise<'edited' | 'same' | 'throttled' | 'paused' | 'closed' | 'skipped'> {
    const v = this.views.get(id);
    if (!v || v.busy) return 'skipped';
    v.busy = true;
    try {
      const now = this.now();
      if (v.mode === 'live' && !opts.force && now - v.lastPressAt >= IDLE_PAUSE_MS) {
        await this.pause(v);
        return 'paused';
      }
      const snap = await this.snapshot(v.session, v.window);
      if (!snap) {
        await this.closeView(v, 'window closed');
        return 'closed';
      }
      const body = this.bodyKey(v.mode, snap);
      if (body === v.lastBody) return 'same';
      if (now < v.backoffUntil || (!opts.force && now - v.lastEditAt < this.pollMs)) return 'throttled';
      const res = await this.edit(v, renderView(this.header(v, snap.info, v.mode), snap.text), viewKeyboard(v.id, v.mode, this.showInput(v.window)));
      if (res === 'ok') { v.lastBody = body; return 'edited'; }
      if (res === 'gone') { this.stopTimer(v); this.views.delete(v.id); return 'closed'; }
      return 'throttled';
    } catch {
      return 'skipped';
    } finally {
      v.busy = false;
    }
  }

  // ---- callbacks

  /** Handles one callback_query. Non-owners are ignored silently; owners always get an answer. Never throws. */
  async handleCallback(c: CallbackInput): Promise<void> {
    if (!this.d.isOwner(c.fromId)) return;
    try {
      const parts = c.data.split('|');
      if (parts[0] !== 'w' || parts.length !== 3) return void (await this.answer(c.callbackId));
      const act = parts[1] ?? '';
      const arg = parts[2] ?? '';
      if (act === 'L') {
        await this.answer(c.callbackId);
        const all = await this.listAll();
        if (!all) return void (await this.sendPlain(c.chatId ?? this.d.chatId ?? '', c.threadId, NOT_RUNNING));
        return await this.sendList(all, { chatId: c.chatId ?? this.d.chatId ?? '', threadId: c.threadId });
      }
      if (act === 'o') {
        const t = this.listMap.get(arg);
        if (!t) return void (await this.answer(c.callbackId, 'List expired, use /windows'));
        await this.answer(c.callbackId, 'Opening view');
        return await this.openView(t.session, t.window, c.threadId);
      }
      const v = this.views.get(arg);
      if (!v) return void (await this.answer(c.callbackId, 'View expired, use /windows'));
      v.lastPressAt = this.now();
      if (act === 'r') {
        // Refresh: respects the one-edit-per-3s rule; a paused view goes live again.
        const wasPaused = v.mode === 'paused';
        if (!wasPaused && this.now() - v.lastEditAt < this.pollMs) return void (await this.answer(c.callbackId, 'Just updated'));
        await this.answer(c.callbackId);
        v.mode = 'live';
        v.lastBody = wasPaused ? '' : v.lastBody;
        await this.pollOnce(v.id, { force: true });
        this.schedule(v);
        return;
      }
      if (act === 'p') {
        await this.answer(c.callbackId);
        if (v.mode === 'live') return await this.pause(v);
        v.mode = 'live';
        v.lastBody = '';
        await this.pollOnce(v.id, { force: true });
        this.schedule(v);
        return;
      }
      if (act === 'c') {
        await this.answer(c.callbackId);
        return await this.closeView(v, 'view closed');
      }
      if (act.startsWith('k')) {
        const key = INPUT_KEYS[act.slice(1)];
        if (!key) return void (await this.answer(c.callbackId));
        const refusal = await this.inputRefusal(v.session, v.window);
        if (refusal) return void (await this.answer(c.callbackId, refusal));
        await this.answer(c.callbackId);
        const r = await this.d.run('tmux', ['send-keys', '-t', await this.targetOf(v.session, v.window), ...key.args]);
        if (r.code !== 0) await this.sendPlain(v.chatId, v.threadId, 'Key not sent (tmux error).');
        return;
      }
      await this.answer(c.callbackId);
    } catch {
      await this.answer(c.callbackId, 'Something went wrong').catch(() => undefined);
    }
  }

  private async targetOf(session: string, window: string): Promise<string> {
    const info = (await this.list(session))?.find((w) => w.name === window);
    return info ? `=${session}:${info.index}` : `=${session}:=${window}`;
  }

  /** Reason text when input must be refused, otherwise null. */
  private async inputRefusal(session: string, window: string): Promise<string | null> {
    if (!this.d.inputEnabled) return 'Window input is off (TELEGRAM_WINDOW_INPUT)';
    if (!this.allowed(session)) return 'Window not allowed';
    if (this.isProtected(window)) return `Window ${window} is protected: view only`;
    if (this.d.killed()) return 'Kill switch is on: input refused';
    const wins = await this.list(session);
    if (!wins?.some((w) => w.name === window)) return 'Window is gone';
    return null;
  }

  // ---- typed text

  /**
   * Owner text in a window topic (or as a reply to a live view) is typed into that window, followed by Enter.
   * Returns true when the message belonged to the windows feature (answered here), false to let normal routing go on.
   */
  async handleText(t: TextInput): Promise<boolean> {
    try {
      if (t.text.trim().startsWith('/')) return false;
      let target: { session: string; window: string } | null = null;
      if (t.replyToMessageId !== undefined) {
        for (const v of this.views.values()) if (v.messageId === t.replyToMessageId && v.chatId === String(t.chatId)) target = { session: v.session, window: v.window };
      }
      if (!target && t.threadId !== undefined) {
        const w = windowOfThread(this.d.root, t.threadId);
        if (w) target = { session: this.primary(), window: w };
      }
      if (!target) return false;
      const reply = (text: string): Promise<void> => this.sendPlain(t.chatId, t.threadId, text, undefined);
      const refusal = await this.inputRefusal(target.session, target.window);
      if (refusal) return await reply(refusal), true;
      const text = cleanTyped(t.text).trim();
      if (!text) return await reply('Nothing to type.'), true;
      if (text.length > MAX_TYPED) return await reply(`Too long (max ${MAX_TYPED} characters).`), true;
      try {
        // sendText writes the text literally and then presses Enter (tmux send-keys -l, then Enter).
        await sendText(this.d.run, target.session, target.window, text);
      } catch (e) {
        const why = e instanceof Error ? e.message.replace(/[\r\n]+/g, ' ').slice(0, 100) : 'error';
        return await reply(`Not sent: ${why}`), true;
      }
      return await reply(`Sent to ${target.window}`), true;
    } catch {
      return false;
    }
  }

  // ---- test and shutdown helpers

  viewCount(): number { return this.views.size; }
  viewIds(): string[] { return [...this.views.keys()]; }
  viewMode(id: string): ViewMode | undefined { return this.views.get(id)?.mode; }

  stopAll(): void {
    for (const v of this.views.values()) this.stopTimer(v);
    this.views.clear();
  }
}
