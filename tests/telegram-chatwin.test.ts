import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadManagerConfig } from '../src/platform/manager.js';
import type { Run } from '../src/platform/tmux.js';
import type { ApiResult, TelegramApi } from '../src/telegram/api.js';
import { ensureChatWindow } from '../src/telegram/chatwin/ensure.js';
import { CHAT_MESSAGES_CAP, ChatMessageLog, chatMessagesPath } from '../src/telegram/chatwin/messages.js';
import { chatSessionFile, projectTranscriptDir, readChatSessionRecord, transcriptFile } from '../src/telegram/chatwin/session.js';
import { parseTranscriptLine, toolSummary, TranscriptTailer } from '../src/telegram/chatwin/transcript.js';
import { ChatWindow, NOT_RUNNING_TEXT, STALL_TEXT } from '../src/telegram/chatwin/window.js';
import { protectedWindowNames } from '../src/telegram/windows/bridge.js';
import { writeTopicState } from '../src/telegram/topics.js';

const CHAT = '-100500';
const THREAD = 7;
const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '99999999-2222-4333-8444-555555555555';

interface Call { method: string; payload: Record<string, unknown> }

class FakeTmux {
  windows: { name: string; command: string }[] = [{ name: 'chat', command: 'claude' }];
  calls: string[][] = [];
  run: Run = async (_cmd, args) => {
    this.calls.push(args);
    if (args[0] === 'list-windows') {
      return { stdout: this.windows.map((w, i) => `${i}|${w.name}|0|${w.command}`).join('\n'), code: 0 };
    }
    return { stdout: '', code: 0 };
  };
  sent = (): string[][] => this.calls.filter((c) => c[0] === 'send-keys');
  typed = (): string[] => this.sent().filter((c) => c.includes('-l')).map((c) => c[c.length - 1] as string);
}

function fakeApi(opts: { deleteFails?: Set<number> } = {}): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = [];
  let next = 500;
  const api: TelegramApi = {
    async call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
      calls.push({ method, payload });
      if (method === 'sendMessage') return { ok: true, result: { message_id: next++ } as T };
      if (method === 'deleteMessage' && opts.deleteFails?.has(payload.message_id as number)) return { ok: false, description: 'message can\'t be deleted' };
      return { ok: true, result: {} as T };
    },
  };
  return { api, calls };
}

let root: string;
let home: string;
let dir: string;
let tmux: FakeTmux;
let killed: boolean;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'chatwin-'));
  home = mkdtempSync(path.join(tmpdir(), 'chathome-'));
  dir = projectTranscriptDir(root, home);
  mkdirSync(dir, { recursive: true });
  writeTopicState(root, { chat_id: CHAT, forum: true, topics: { chat: THREAD, alerts: 3 } });
  tmux = new FakeTmux();
  killed = false;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function make(over: { env?: NodeJS.ProcessEnv; api?: TelegramApi; redact?: (s: string) => string; restart?: () => Promise<string> } = {}): { win: ChatWindow; calls: Call[] } {
  const f = fakeApi();
  const win = new ChatWindow({
    api: over.api ?? f.api, run: tmux.run, root, env: over.env ?? {}, chatId: CHAT, tmuxSession: 'Jobber', killed: () => killed,
    redact: over.redact ?? ((s) => s), claudeHome: home, autoTimers: false, stallMs: 60_000, restart: over.restart,
  });
  return { win, calls: f.calls };
}

const msg = (text: string, messageId = 1, threadId: number | undefined = THREAD) => ({ text, chatId: CHAT, threadId, messageId });
const writeRecord = (id = SID): void => {
  mkdirSync(path.dirname(chatSessionFile(root)), { recursive: true });
  writeFileSync(chatSessionFile(root), JSON.stringify({ session_id: id, started_at: 'x' }));
};
const asst = (blocks: unknown[], stop: string | null, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks, stop_reason: stop }, ...extra })}\n`;
const userEntry = (content: unknown): string => `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
const sentTexts = (calls: Call[]): string[] => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text));

describe('window start config', () => {
  it('config/manager-windows.json protects chat, and the live view still treats it as viewable', () => {
    const cfg = loadManagerConfig(readFileSync('config/manager-windows.json', 'utf8'));
    expect(cfg.protected).toContain('chat');
    expect(cfg.windows.chat).toBeUndefined(); // started by ensureChatWindow, never by the manager
    expect(protectedWindowNames(process.cwd())).not.toContain('chat');
  });

  it('ensureChatWindow starts claude through claude-session.sh with --session-id and records it (0600)', async () => {
    const t = new FakeTmux();
    t.windows = [];
    const cfg = loadManagerConfig(readFileSync('config/manager-windows.json', 'utf8'));
    expect(await ensureChatWindow(t.run, cfg, {}, root)).toBe('started');
    const nw = t.calls.find((c) => c[0] === 'new-window') as string[];
    expect(nw).toContain('chat');
    const cmd = nw[nw.length - 1] as string;
    expect(cmd).toMatch(/^'bash' 'scripts\/claude-session\.sh' '--session-id' '[0-9a-f-]{36}'$/);
    expect(cmd).not.toMatch(/skip-permissions|bypass/i);
    const rec = readChatSessionRecord(root);
    expect(cmd).toContain(rec?.session_id as string);
    expect(statSync(chatSessionFile(root)).mode & 0o777).toBe(0o600);
  });

  it('does not start a second chat window, and restart kills then starts', async () => {
    const cfg = loadManagerConfig(readFileSync('config/manager-windows.json', 'utf8'));
    expect(await ensureChatWindow(tmux.run, cfg, {}, root)).toBe('exists');
    expect(tmux.calls.some((c) => c[0] === 'new-window')).toBe(false);
    expect(await ensureChatWindow(tmux.run, cfg, {}, root, { restart: true })).toBe('restarted');
    expect(tmux.calls.some((c) => c[0] === 'kill-window')).toBe(true);
    expect(tmux.calls.some((c) => c[0] === 'new-window')).toBe(true);
  });

  it('claude-session.sh keeps the bot token out of the window and refuses skip flags', () => {
    const sh = readFileSync('scripts/claude-session.sh', 'utf8');
    expect(sh).toContain('unset TELEGRAM_BOT_TOKEN');
    expect(sh).toMatch(/TELEGRAM_BOT_TOKEN\|ALLOWED_USERS\) continue/);
    expect(sh).toContain('refusing to start Claude with a permission-skipping argument');
  });
});

describe('sending', () => {
  it('types the owner text literally into the chat window, then Enter', async () => {
    writeRecord();
    const { win } = make();
    expect(await win.handle(msg('hello <b>there</b>\nsecond line'))).toBe(true);
    expect(tmux.typed()).toEqual(['hello <b>there</b> second line']);
    const sent = tmux.sent();
    expect(sent[0]).toEqual(['send-keys', '-t', '=Jobber:=chat', '-l', '--', 'hello <b>there</b> second line']);
    expect(sent[1]).toEqual(['send-keys', '-t', '=Jobber:=chat', 'Enter']);
  });

  it('a leading ! # & is not passed on as a Claude prefix', async () => {
    writeRecord();
    const { win } = make();
    await win.handle(msg('!rm -rf x'));
    expect(tmux.typed()[0]).toBe('Owner says: !rm -rf x');
  });

  it('refuses over-long text and does not type it', async () => {
    writeRecord();
    const { win, calls } = make();
    await win.handle(msg('a'.repeat(2001)));
    expect(tmux.typed()).toEqual([]);
    expect(sentTexts(calls).join(' ')).toContain('Too long');
  });

  it('the kill switch refuses and nothing is typed', async () => {
    writeRecord();
    killed = true;
    const { win, calls } = make();
    expect(await win.handle(msg('hi'))).toBe(true);
    expect(await win.handle(msg('/clear', 2))).toBe(true);
    expect(tmux.sent()).toEqual([]);
    expect(sentTexts(calls).every((t) => /Kill switch/.test(t))).toBe(true);
  });

  it('a missing chat window gets a plain answer and is never created from here', async () => {
    tmux.windows = [];
    const { win, calls } = make();
    expect(await win.handle(msg('hi'))).toBe(true);
    expect(sentTexts(calls)).toEqual([NOT_RUNNING_TEXT]);
    expect(tmux.calls.some((c) => c[0] === 'new-window' || c[0] === 'send-keys')).toBe(false);
  });

  it('a window that does not run claude is refused', async () => {
    tmux.windows = [{ name: 'chat', command: 'zsh' }];
    const { win, calls } = make();
    await win.handle(msg('hi'));
    expect(tmux.sent()).toEqual([]);
    expect(sentTexts(calls)[0]).toContain('not running claude');
  });

  it('messages in other topics and other typed commands are left to the normal routing', async () => {
    writeRecord();
    const { win } = make();
    expect(await win.handle(msg('hi', 1, 3))).toBe(false); // alerts topic
    expect(await win.handle(msg('/clear', 1, 3))).toBe(false); // unknown there
    expect(await win.handle(msg('/status'))).toBe(false); // other commands keep working in the chat topic
    expect(await win.handle(msg('/limits'))).toBe(false);
    expect(tmux.sent()).toEqual([]);
  });

  it('/compact is passed through and /chat restart uses the restart hook', async () => {
    writeRecord();
    const { win } = make({ restart: async () => 'chat window restarted (new session).' });
    await win.handle(msg('/compact'));
    expect(tmux.typed()).toEqual(['/compact']);
    const f = make({ restart: async () => 'chat window restarted (new session).' });
    await f.win.handle(msg('/chat restart'));
    expect(sentTexts(f.calls)).toEqual(['chat window restarted (new session).']);
  });
});

describe('transcript parsing', () => {
  it('surfaces assistant text only; thinking, tool results, user and system entries are dropped', () => {
    expect(parseTranscriptLine(asst([{ type: 'thinking', thinking: 'secret plan' }], 'tool_use'))).toEqual([]);
    expect(parseTranscriptLine(asst([{ type: 'text', text: 'hi' }], 'tool_use'))).toEqual([{ kind: 'text', text: 'hi' }]);
    expect(parseTranscriptLine(userEntry('typed by owner'))).toEqual([]);
    expect(parseTranscriptLine(userEntry([{ type: 'tool_result', content: 'SECRET OUTPUT' }]))).toEqual([{ kind: 'tool_result' }]);
    expect(parseTranscriptLine('{"type":"system","message":{"content":"x"}}')).toEqual([]);
    expect(parseTranscriptLine(asst([{ type: 'text', text: 'sub' }], 'end_turn', { isSidechain: true }))).toEqual([]);
    expect(parseTranscriptLine('not json')).toEqual([]);
  });

  it('the tool line has the tool name (and a file basename for Read) but no arguments', () => {
    expect(toolSummary('Bash', { command: 'cat ~/.ssh/id_rsa' })).toBe('using Bash');
    expect(toolSummary('Read', { file_path: '/Users/x/secret dir/config.ts' })).toBe('using Read config.ts');
    const ev = parseTranscriptLine(asst([{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }], 'tool_use'));
    expect(JSON.stringify(ev)).not.toContain('rm -rf');
  });

  it('end_turn adds a done event, tool_use does not', () => {
    expect(parseTranscriptLine(asst([{ type: 'text', text: 'a' }], 'end_turn'))).toEqual([{ kind: 'text', text: 'a' }, { kind: 'done' }]);
    expect(parseTranscriptLine(asst([{ type: 'text', text: 'a' }], 'tool_use')).some((e) => e.kind === 'done')).toBe(false);
  });

  it('the tailer reads from an offset and waits for the newline of a partial line', () => {
    const f = path.join(dir, `${SID}.jsonl`);
    writeFileSync(f, 'old line\n');
    const t = TranscriptTailer.atEnd(f);
    expect(t.readLines()).toEqual([]);
    const whole = asst([{ type: 'text', text: 'hello' }], 'end_turn');
    appendFileSync(f, whole.slice(0, 30));
    expect(t.readLines()).toEqual([]); // partial: nothing yet
    appendFileSync(f, whole.slice(30));
    const lines = t.readLines();
    expect(lines).toHaveLength(1);
    expect(parseTranscriptLine(lines[0] as string)[0]).toEqual({ kind: 'text', text: 'hello' });
    expect(t.readLines()).toEqual([]);
  });
});

describe('answers posted to the chat topic', () => {
  it('posts assistant text and a tool line, stops typing at end_turn, ignores everything else', async () => {
    writeRecord();
    const f = transcriptFile(dir, SID);
    writeFileSync(f, asst([{ type: 'text', text: 'OLD ANSWER' }], 'end_turn')); // history is never replayed
    const { win, calls } = make();
    await win.handle(msg('question'));
    expect(calls.filter((c) => c.method === 'sendChatAction').length).toBe(1);
    expect(calls.find((c) => c.method === 'sendChatAction')?.payload).toMatchObject({ chat_id: CHAT, message_thread_id: THREAD, action: 'typing' });
    appendFileSync(f, userEntry('question'));
    appendFileSync(f, asst([{ type: 'thinking', thinking: 'hidden' }], 'tool_use'));
    appendFileSync(f, asst([{ type: 'text', text: 'Looking **now**' }], 'tool_use'));
    appendFileSync(f, asst([{ type: 'tool_use', name: 'Bash', input: { command: 'echo SECRET' } }], 'tool_use'));
    appendFileSync(f, userEntry([{ type: 'tool_result', content: 'SECRET' }]));
    await win.poll();
    await win.typingTick();
    expect(calls.filter((c) => c.method === 'sendChatAction').length).toBe(2); // still working
    appendFileSync(f, asst([{ type: 'text', text: 'Done. <script>alert(1)</script>' }], 'end_turn'));
    await win.poll();
    await win.typingTick();
    expect(calls.filter((c) => c.method === 'sendChatAction').length).toBe(2); // no typing after end_turn
    const all = sentTexts(calls);
    expect(all).toEqual(['Looking <b>now</b>', '<i>using Bash</i>', 'Done. &lt;script&gt;alert(1)&lt;/script&gt;']);
    expect(all.join('')).not.toMatch(/OLD ANSWER|hidden|SECRET|echo/);
    for (const c of calls.filter((x) => x.method === 'sendMessage')) expect(c.payload).toMatchObject({ chat_id: CHAT, message_thread_id: THREAD, parse_mode: 'HTML' });
  });

  it('redacts secrets before posting and chunks long answers under the Telegram limit', async () => {
    writeRecord();
    const f = transcriptFile(dir, SID);
    writeFileSync(f, '');
    const { win, calls } = make({ redact: (s) => s.replace(/TOPSECRET\d+/g, '[redacted]') });
    await win.handle(msg('go'));
    const long = `key TOPSECRET123456\n${'line of text\n'.repeat(900)}`;
    appendFileSync(f, asst([{ type: 'text', text: long }], 'end_turn'));
    await win.poll();
    const texts = sentTexts(calls);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(4096);
    expect(texts.join('')).not.toContain('TOPSECRET');
    expect(texts[0]).toContain('[redacted]');
  });

  it('a partial transcript line is posted only once complete', async () => {
    writeRecord();
    const f = transcriptFile(dir, SID);
    writeFileSync(f, '');
    const { win, calls } = make();
    await win.handle(msg('go'));
    const whole = asst([{ type: 'text', text: 'whole answer' }], 'end_turn');
    appendFileSync(f, whole.slice(0, 40));
    await win.poll();
    expect(sentTexts(calls)).toEqual([]);
    appendFileSync(f, whole.slice(40));
    await win.poll();
    expect(sentTexts(calls)).toEqual(['whole answer']);
  });

  it('posts one waiting-for-permission line when a tool_use stalls for 60 s', async () => {
    writeRecord();
    const f = transcriptFile(dir, SID);
    writeFileSync(f, '');
    let t = 1_000_000;
    const fa = fakeApi();
    const win = new ChatWindow({ api: fa.api, run: tmux.run, root, env: {}, chatId: CHAT, tmuxSession: 'Jobber', killed: () => false, redact: (s) => s, claudeHome: home, autoTimers: false, now: () => t });
    await win.handle(msg('go'));
    appendFileSync(f, asst([{ type: 'tool_use', name: 'Bash', input: {} }], 'tool_use'));
    await win.poll();
    t += 61_000;
    await win.poll();
    await win.poll();
    expect(sentTexts(fa.calls).filter((x) => x === STALL_TEXT)).toHaveLength(1);
  });

  it('without a recorded session id it finds the transcript by the typed text', async () => {
    const { win, calls } = make(); // no .jobber/chat-session.json
    await win.handle(msg('find me please'));
    const other = transcriptFile(dir, SID2);
    writeFileSync(other, `${userEntry('someone else')}${userEntry('find me please')}`);
    appendFileSync(other, asst([{ type: 'text', text: 'found' }], 'end_turn'));
    await win.poll();
    expect(sentTexts(calls)).toEqual(['found']);
    expect(win.tailing).toBe(other);
    expect(readChatSessionRecord(root)?.session_id).toBe(SID2); // remembered for the next message
  });
});

describe('/clear', () => {
  it('types /clear, deletes the recorded messages, counts failures, and re-detects the session afterwards', async () => {
    writeRecord(SID);
    const oldFile = transcriptFile(dir, SID);
    writeFileSync(oldFile, '');
    const fa = fakeApi({ deleteFails: new Set([2]) });
    const { win } = make({ api: fa.api });
    await win.handle(msg('first', 1));
    await win.handle(msg('second', 2)); // its id cannot be deleted (too old)
    appendFileSync(oldFile, asst([{ type: 'text', text: 'answer' }], 'end_turn'));
    await win.poll();
    const before = new ChatMessageLog(root, CHAT).list();
    expect(before).toEqual(expect.arrayContaining([1, 2, 500]));
    await win.handle(msg('/clear', 3));
    expect(tmux.typed().pop()).toBe('/clear');
    const del = fa.calls.filter((c) => c.method === 'deleteMessage').map((c) => c.payload.message_id);
    expect(del).toEqual(expect.arrayContaining([1, 3, 500]));
    expect(del).toContain(2);
    const last = sentTexts(fa.calls).pop() as string;
    expect(last).toContain('Cleared. Context reset.');
    expect(last).toContain('1 message could not be deleted');
    expect(win.tailing).toBeNull();
    // after /clear Claude writes a new transcript file; the next message finds it by its text
    await win.handle(msg('after clear', 10));
    const next = transcriptFile(dir, SID2);
    writeFileSync(next, `${userEntry('after clear')}${asst([{ type: 'text', text: 'fresh' }], 'end_turn')}`);
    await win.poll();
    expect(win.tailing).toBe(next);
    expect(sentTexts(fa.calls).pop()).toBe('fresh');
  });

  it('the message log is capped at 2000 ids, file mode 0600, ids only', () => {
    const log = new ChatMessageLog(root, CHAT);
    for (let i = 1; i <= CHAT_MESSAGES_CAP + 50; i++) log.add(i);
    const ids = new ChatMessageLog(root, CHAT).list();
    expect(ids).toHaveLength(CHAT_MESSAGES_CAP);
    expect(ids[0]).toBe(51);
    expect(statSync(chatMessagesPath(root)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(chatMessagesPath(root), 'utf8')) as object).sort()).toEqual(['chat_id', 'ids']);
  });
});
