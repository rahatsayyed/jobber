// src/telegram/chatwin/window.ts
// The `chat` topic talks to the long-running interactive claude window `chat` of the Jobber tmux session.
// Owner text is typed into the window (tmux send-keys, literal text then Enter); the answer is read from Claude's
// JSONL transcript (see transcript.ts), not from the screen, and posted to the topic. Message text and transcript
// content are never logged. Only the owner's own typed text ever reaches the window.
import { sendText, listWindows, type Run } from '../../platform/tmux.js';
import type { TelegramApi } from '../api.js';
import { parseCommand } from '../commands.js';
import { htmlEscape, isParseError, markdownToHtmlChunks } from '../format.js';
import { htmlToPlain } from '../send.js';
import { readTopicState } from '../topics.js';
import { cleanTyped } from '../windows/view.js';
import { ChatMessageLog } from './messages.js';
import {
  claudeHomeDir, findTranscriptByTypedText, projectTranscriptDir, readChatSessionRecord, sessionIdOfFile, transcriptFile,
  writeChatSessionRecord,
} from './session.js';
import { parseTranscriptLine, TranscriptTailer, type ChatEvent } from './transcript.js';

export const CHAT_WINDOW_NAME = 'chat';
/** Longest text typed into the window (the limit of the shared tmux sendText helper). */
export const MAX_CHAT_TEXT = 2000;
export const TYPING_MS = 4000;
export const POLL_MS = 1000;
export const STALL_MS = 60_000;
export const TURN_CAP_MS = 15 * 60_000;
const DISCOVER_AFTER_MS = 3000;

export const NOT_RUNNING_TEXT = 'chat window is not running, use npm run up (or /chat restart)';
const KILLED_TEXT = 'Kill switch is on. The chat window gets no input until the owner resumes.';
export const STALL_TEXT = 'Claude is waiting for permission, open /windows chat';

export interface ChatWindowDeps {
  api: TelegramApi;
  run: Run;
  root: string;
  env: NodeJS.ProcessEnv;
  /** Chat that holds the topics (group or the owner's private chat). */
  chatId: string;
  /** tmux session that holds the chat window. */
  tmuxSession: string;
  killed: () => boolean;
  /** Secret redaction applied to every text before it is posted. */
  redact: (text: string) => string;
  /** `/chat restart`: kill and start the window again; returns the text to tell the owner. */
  restart?: () => Promise<string>;
  claudeHome?: string;
  now?: () => number;
  pollMs?: number;
  typingMs?: number;
  stallMs?: number;
  /** Tests turn the timers off and call poll() and typingTick() themselves. */
  autoTimers?: boolean;
}

export interface ChatMessageIn {
  text: string;
  chatId: number | string;
  threadId?: number;
  messageId?: number;
}

const FALLBACK_PRINT = (env: NodeJS.ProcessEnv): boolean => (env.TELEGRAM_CHAT_FALLBACK ?? '').trim() === 'print';

export class ChatWindow {
  private readonly log: ChatMessageLog;
  private readonly now: () => number;
  private readonly dir: string;
  private tailer: TranscriptTailer | null = null;
  /** True after /clear or a restart: the recorded session id is stale until a new transcript is found. */
  private stale = false;
  private pendingTurns = 0;
  private sentAt = 0;
  private pendingText: string | undefined;
  private toolSince: number | null = null;
  private stallNotified = false;
  private polling = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private typingTimer: NodeJS.Timeout | undefined;

  constructor(private readonly d: ChatWindowDeps) {
    this.now = d.now ?? Date.now;
    this.log = new ChatMessageLog(d.root, d.chatId);
    this.dir = projectTranscriptDir(d.root, d.claudeHome ?? claudeHomeDir());
  }

  // ---- routing

  /** True when the message is in the chat topic (or the chat has no topics, so it is the one place to talk). */
  isChatTopic(threadId: number | undefined): boolean {
    const st = readTopicState(this.d.root);
    if (!st || !st.forum) return true;
    return threadId !== undefined && st.topics.chat === threadId;
  }

  private chatThread(): number | undefined {
    const st = readTopicState(this.d.root);
    return st?.forum ? st.topics.chat : undefined;
  }

  /**
   * Handles free text and /clear, /compact, /chat in the chat topic. Returns true when answered here; false lets the
   * normal routing go on (other topics, other typed commands, or the print fallback when the window is missing).
   */
  async handle(m: ChatMessageIn): Promise<boolean> {
    try {
      if (!this.isChatTopic(m.threadId)) return false;
      const cmd = parseCommand(m.text);
      if (cmd && !['clear', 'compact', 'chat'].includes(cmd.name)) return false;
      if (!cmd && m.text.trim() === '') return false;
      this.log.add(m.messageId);
      this.startTimers();
      if (cmd?.name === 'clear') return await this.clear();
      if (cmd?.name === 'compact') return await this.passThrough('/compact', 'Sent /compact to the chat window.');
      if (cmd?.name === 'chat') return await this.chatCommand(cmd.rest);
      return await this.freeText(m.text);
    } catch {
      await this.reply('Something went wrong while handling that message.').catch(() => undefined);
      return true;
    }
  }

  private async windowState(): Promise<'ok' | 'missing' | 'not_claude'> {
    const w = (await listWindows(this.d.run, this.d.tmuxSession)).find((x) => x.name === CHAT_WINDOW_NAME);
    if (!w) return 'missing';
    return /^(claude|node|\d+\.\d+\.\d+.*)$/.test(w.command) ? 'ok' : 'not_claude';
  }

  /** Common checks before anything is typed. Returns a refusal text or null. */
  private async refusal(): Promise<string | null> {
    if (this.d.killed()) return KILLED_TEXT;
    const s = await this.windowState();
    if (s === 'missing') return NOT_RUNNING_TEXT;
    if (s === 'not_claude') return 'chat window is not running claude (it may have exited), use /chat restart';
    return null;
  }

  private async freeText(raw: string): Promise<boolean> {
    let text = cleanTyped(raw).replace(/\s+/g, ' ').trim();
    if (!text) return true;
    if (this.d.killed()) { await this.reply(KILLED_TEXT); return true; }
    if ((await this.windowState()) === 'missing' && FALLBACK_PRINT(this.d.env)) return false; // old `claude -p` path
    const why = await this.refusal();
    if (why) { await this.reply(why); return true; }
    if (text.length > MAX_CHAT_TEXT) { await this.reply(`Too long (max ${MAX_CHAT_TEXT} characters).`); return true; }
    if (/^[!#&]/.test(text)) text = `Owner says: ${text}`; // a leading ! # & would be read by Claude as a shell or memory prefix
    await this.beginTurn(text);
    try {
      await sendText(this.d.run, this.d.tmuxSession, CHAT_WINDOW_NAME, text);
    } catch (e) {
      this.pendingTurns = Math.max(0, this.pendingTurns - 1);
      await this.reply(`Not sent: ${e instanceof Error ? e.message.replace(/[\r\n]+/g, ' ').slice(0, 100) : 'error'}`);
    }
    return true;
  }

  private async passThrough(command: string, okText: string): Promise<boolean> {
    const why = await this.refusal();
    if (why) { await this.reply(why); return true; }
    try {
      await sendText(this.d.run, this.d.tmuxSession, CHAT_WINDOW_NAME, command);
    } catch {
      await this.reply('Not sent (tmux error).');
      return true;
    }
    await this.reply(okText);
    return true;
  }

  private async clear(): Promise<boolean> {
    const why = await this.refusal();
    if (why) { await this.reply(why); return true; }
    try {
      await sendText(this.d.run, this.d.tmuxSession, CHAT_WINDOW_NAME, '/clear');
    } catch {
      await this.reply('Not sent (tmux error).');
      return true;
    }
    // Claude starts a new transcript segment: find it again with the next message.
    this.tailer = null;
    this.stale = true;
    this.pendingTurns = 0;
    this.pendingText = undefined;
    this.toolSince = null;
    this.stopTyping();
    const { failed } = await this.log.deleteAll(this.d.api);
    await this.reply(failed > 0 ? `Cleared. Context reset. ${failed} message${failed === 1 ? '' : 's'} could not be deleted (older than 48 h).` : 'Cleared. Context reset.');
    return true;
  }

  private async chatCommand(rest: string): Promise<boolean> {
    if (rest.trim().toLowerCase() === 'restart') {
      if (this.d.killed()) { await this.reply(KILLED_TEXT); return true; }
      if (!this.d.restart) { await this.reply('Restart is not available here, use npm run up.'); return true; }
      let msg: string;
      try { msg = await this.d.restart(); } catch { msg = 'Could not restart the chat window.'; }
      this.tailer = null;
      this.stale = false;
      this.pendingTurns = 0;
      this.stopTyping();
      await this.reply(msg);
      return true;
    }
    const s = await this.windowState();
    await this.reply(`chat window: ${s === 'ok' ? 'running' : s === 'missing' ? 'not running' : 'not running claude'}. Commands: /clear /compact /chat restart`);
    return true;
  }

  // ---- turns, typing, polling

  /** Called right BEFORE the text is typed: the tailer starts at the current end of the transcript. */
  private async beginTurn(text: string): Promise<void> {
    this.prepareTailer();
    this.pendingTurns++;
    this.sentAt = this.now();
    this.pendingText = text;
    this.toolSince = null;
    this.stallNotified = false;
    await this.typingTick();
    this.startTimers();
  }

  private prepareTailer(): void {
    if (this.tailer || this.stale) return;
    const rec = readChatSessionRecord(this.d.root);
    if (rec) this.tailer = TranscriptTailer.atEnd(transcriptFile(this.dir, rec.session_id));
  }

  private startTimers(): void {
    if (this.d.autoTimers === false) return;
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.poll(); }, this.d.pollMs ?? POLL_MS);
      this.pollTimer.unref?.();
    }
    if (this.pendingTurns > 0 && !this.typingTimer) {
      this.typingTimer = setInterval(() => { void this.typingTick(); }, this.d.typingMs ?? TYPING_MS);
      this.typingTimer.unref?.();
    }
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = undefined;
  }

  stop(): void {
    this.stopTyping();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Telegram "typing" while at least one turn is open. */
  async typingTick(): Promise<void> {
    if (this.pendingTurns <= 0) { this.stopTyping(); return; }
    const thread = this.chatThread();
    await this.d.api.call('sendChatAction', { chat_id: this.d.chatId, action: 'typing', ...(thread !== undefined ? { message_thread_id: thread } : {}) });
  }

  private discover(): void {
    if (!this.pendingText) return;
    const hit = findTranscriptByTypedText(this.dir, this.pendingText, this.sentAt - 5000);
    if (!hit || (this.tailer && hit.file === this.tailer.file)) return;
    this.tailer = new TranscriptTailer(hit.file, hit.offset);
    this.stale = false;
    const id = sessionIdOfFile(hit.file);
    if (id) { try { writeChatSessionRecord(this.d.root, id); } catch { /* the next message finds it again */ } }
  }

  /** One poll step: read new transcript lines, post the assistant's text and tool lines, close finished turns. Never throws. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const t = this.now();
      if (this.pendingTurns > 0 && t - this.sentAt > TURN_CAP_MS) { this.pendingTurns = 0; this.stopTyping(); }
      if (!this.tailer) this.discover();
      else if (this.pendingText && t - this.sentAt >= DISCOVER_AFTER_MS && this.tailer.size() <= this.tailer.offset) this.discover();
      const tailer = this.tailer;
      if (tailer) {
        const events: ChatEvent[] = [];
        for (const line of tailer.readLines()) events.push(...parseTranscriptLine(line));
        if (events.length > 0) { this.pendingText = undefined; await this.emit(events); }
      }
      if (this.pendingTurns > 0 && this.toolSince !== null && !this.stallNotified && t - this.toolSince >= (this.d.stallMs ?? STALL_MS)) {
        this.stallNotified = true;
        await this.reply(STALL_TEXT);
      }
    } catch {
      // a failed poll is tried again in a second
    } finally {
      this.polling = false;
    }
  }

  private async emit(events: ChatEvent[]): Promise<void> {
    let tools: string[] = [];
    const flushTools = async (): Promise<void> => {
      if (tools.length === 0) return;
      const html = tools.map((s) => `<i>${htmlEscape(this.d.redact(s))}</i>`).join('\n');
      tools = [];
      await this.post([html]);
    };
    for (const e of events) {
      if (e.kind === 'tool') { tools.push(e.summary); this.toolSince = this.now(); this.stallNotified = false; continue; }
      await flushTools();
      if (e.kind === 'text') {
        this.toolSince = null;
        await this.post(markdownToHtmlChunks(this.d.redact(e.text)));
      } else if (e.kind === 'tool_result') {
        this.toolSince = null;
        this.stallNotified = false;
      } else {
        this.pendingTurns = Math.max(0, this.pendingTurns - 1);
        this.toolSince = null;
        if (this.pendingTurns === 0) this.stopTyping();
      }
    }
    await flushTools();
  }

  // ---- posting (every id is recorded for /clear)

  private async reply(text: string): Promise<void> {
    await this.post([htmlEscape(text)]);
  }

  private async post(htmlChunks: string[]): Promise<void> {
    const thread = this.chatThread();
    for (const html of htmlChunks) {
      if (html === '') continue;
      const base = (): Record<string, unknown> => ({
        chat_id: this.d.chatId,
        ...(thread !== undefined ? { message_thread_id: thread } : {}),
        link_preview_options: { is_disabled: true },
      });
      let r = await this.d.api.call<{ message_id?: number }>('sendMessage', { ...base(), text: html, parse_mode: 'HTML' });
      if (!r.ok && isParseError(r.description)) r = await this.d.api.call<{ message_id?: number }>('sendMessage', { ...base(), text: htmlToPlain(html) });
      if (r.ok) this.log.add(r.result?.message_id);
    }
  }

  /** The transcript file being tailed (null until known). */
  get tailing(): string | null {
    return this.tailer?.file ?? null;
  }
}
