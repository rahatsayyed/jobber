// src/telegram/commands.ts
// Typed owner commands, in code (no model). Each command builds an argv array for a child process (never a shell)
// or reads the database directly. Every owner message gets an answer. Output of the child processes can contain
// third-party text, so it is always sent as a code block through format.ts (escaped).
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { calibrate } from '../calibrate.js';
import { getCalibrationRows, recordOutcomeChecked, unexcludeJob, type Outcome } from '../db.js';
import { funnelStats } from '../funnel.js';
import { patternStats } from '../patterns.js';
import { requestWake } from '../scheduler/wakeRequest.js';
import { childEnv, type SpawnFn } from './spawn.js';
import { readTopicState, type TopicName } from './topics.js';
import { DripController, type Button, type DripIo } from './drip.js';
import { matchThresholdFromEnv } from '../matchRubric.js';

export const STATUS_SCRIPT_COMMANDS = ['limits', 'working', 'health', 'sources', 'escalations'] as const;
/** Commands that only read: they still answer while the kill switch is on. */
export const READ_ONLY_COMMANDS: readonly string[] = [...STATUS_SCRIPT_COMMANDS, 'status', 'calibrate', 'patterns', 'report', 'help', 'start'];
const OUTCOMES: readonly Outcome[] = ['replied', 'interview', 'offer', 'hired', 'rejected', 'no_response'];

export interface Argv {
  cmd: string;
  args: string[];
  timeoutMs: number;
}

export function parseCommand(text: string): { name: string; rest: string } | null {
  const m = /^\/([A-Za-z_]{1,32})(?:@[A-Za-z0-9_]{3,64})?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: (m[1] ?? '').toLowerCase(), rest: (m[2] ?? '').trim() };
}

const MAX_URL = 500;

/** `/apply <url> [--force]` -> argv. The URL is ONE argv item. Code (src/manual/url.ts) validates it again. */
export function applyArgv(rest: string): Argv | { error: string } {
  const toks = rest.split(/\s+/).filter(Boolean);
  const force = toks.filter((t) => t === '--force').length > 0;
  const others = toks.filter((t) => t !== '--force');
  if (others.length !== 1) return { error: 'usage: /apply <https url> [--force]' };
  const url = others[0] ?? '';
  if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > MAX_URL) return { error: 'the url must start with https:// and be at most 500 characters' };
  return { cmd: 'npm', args: ['run', 'apply:request', '--', url, ...(force ? ['--force'] : [])], timeoutMs: 60_000 };
}

/** `/instruction add <text> | list [--all] | done <id> [note] | reject <id> [note]` -> argv for `npm run instructions`. */
export function instructionArgv(rest: string): Argv | { error: string } {
  const usage = 'usage: /instruction add <text> [--job N] [--company key] | list [--all] | done <id> <note> | reject <id> [note]';
  const toks = rest.split(/\s+/).filter(Boolean);
  const sub = toks[0];
  if (sub === 'add') {
    if (toks.length < 2) return { error: usage };
    return { cmd: 'npm', args: ['run', 'instructions', '--', ...toks], timeoutMs: 30_000 };
  }
  if (sub === 'list') return { cmd: 'npm', args: ['run', 'instructions', '--', 'list', ...(toks.includes('--all') ? ['--all'] : [])], timeoutMs: 30_000 };
  if ((sub === 'done' || sub === 'reject') && /^\d{1,9}$/.test(toks[1] ?? '')) {
    return { cmd: 'npm', args: ['run', 'instructions', '--', sub, toks[1] ?? '', ...(toks.length > 2 ? [toks.slice(2).join(' ')] : [])], timeoutMs: 30_000 };
  }
  return { error: usage };
}

/** argv for the commands that run a child process; null for commands handled in-process. */
export function commandArgv(name: string, rest: string): Argv | { error: string } | null {
  if ((STATUS_SCRIPT_COMMANDS as readonly string[]).includes(name)) {
    return { cmd: 'npx', args: ['tsx', 'scripts/status.ts', name], timeoutMs: 60_000 };
  }
  if (name === 'apply') return applyArgv(rest);
  if (name === 'instruction') return instructionArgv(rest);
  if (name === 'report') return { cmd: 'npm', args: ['run', 'report'], timeoutMs: 60_000 };
  return null;
}

export interface OwnerMessage {
  text: string;
  /** Thread id of the topic the message is in; undefined in a private chat or the General topic. */
  threadId?: number;
}

export interface BridgeDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  /** { stopped, reason } from the shared kill switch check. */
  killed(): { stopped: boolean; reason: string };
  openDb(): BetterSqlite3.Database;
  /** Send markdown to the place the owner wrote from. */
  reply(markdown: string): Promise<void>;
  typing(): Promise<void>;
  sendDocument(absPath: string, caption: string): Promise<void>;
  /** /drip: the shared controller (confirm tokens live in it), the sender's user id and a sender with inline buttons. */
  drip?: DripController;
  fromId?: number;
  sendButtons?(markdown: string, rows: Button[][]): Promise<void>;
}

/** The /drip view of the bridge deps. Without a button sender the text is sent plain. */
export function dripIo(deps: BridgeDeps): DripIo {
  return {
    env: deps.env, openDb: deps.openDb, now: () => new Date(), killed: deps.killed, reply: deps.reply,
    sendButtons: deps.sendButtons ?? ((md) => deps.reply(md)),
  };
}

/** Bold heading above the code block of each status command. */
const COMMAND_HEADING: Record<string, string> = {
  limits: '📏 Limits', working: '⚙️ Working', health: '🩺 Health', sources: '🌐 Sources', escalations: '🔔 Escalations',
};

export const codeBlock =(s: string): string => `\`\`\`\n${s.replace(/```/g, "'''").slice(-3500)}\n\`\`\``;

const HELP = [
  '**Jobber commands**',
  '- /status /limits /working /health /sources /escalations',
  '- /apply <https url> [--force]',
  '- /outcome <job_id> <outcome> [note]',
  '- /include <job_id>',
  '- /calibrate /patterns /report',
  '- /runhunt',
  '- /drip (status) | /drip mail now | /drip linkedin now',
  '- /instruction add|list|done|reject',
  'Free chat: write in the chat topic.',
].join('\n');

function topicOfThread(root: string, threadId: number | undefined): TopicName | 'private' | 'general' | 'unknown' {
  const st = readTopicState(root);
  if (!st || !st.forum) return 'private';
  if (threadId === undefined) return 'general';
  for (const [name, id] of Object.entries(st.topics)) if (id === threadId) return name as TopicName;
  return 'unknown';
}

async function withDb<T>(deps: BridgeDeps, fn: (db: BetterSqlite3.Database) => T): Promise<T> {
  const db = deps.openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const pct = (n: number | null): string => (n === null ? 'n/a' : `${Math.round(n * 1000) / 10}%`);

async function runChild(deps: BridgeDeps, a: Argv): Promise<{ ok: boolean; out: string }> {
  const r = await deps.spawn(a.cmd, a.args, { cwd: deps.root, env: childEnv(deps.env), timeoutMs: a.timeoutMs });
  if (r.timedOut) return { ok: false, out: 'timed out' };
  const out = (r.stdout.trim() || r.stderr.trim() || '(no output)');
  return { ok: r.code === 0, out };
}

/** Handle one message of an owner. Every path ends in at least one reply. The caller has already checked the owner. */
export async function handleOwnerMessage(msg: OwnerMessage, deps: BridgeDeps): Promise<void> {
  const text = msg.text.trim();
  if (!text) return;
  await deps.typing().catch(() => undefined);
  try {
    const cmd = parseCommand(text);
    if (cmd) return await handleCommand(cmd.name, cmd.rest, deps);
    // Free text: only in the chat topic (or a private chat).
    const where = topicOfThread(deps.root, msg.threadId);
    if (where !== 'chat' && where !== 'private') {
      await deps.reply('Free chat works only in the **chat** topic. Here, use a command (/help).');
      return;
    }
    const k = deps.killed();
    if (k.stopped) {
      await deps.reply(`Kill switch is on (${k.reason}). Free chat is paused; read-only commands still work.`);
      return;
    }
    // Free text in the chat topic is answered by the long-running `chat` window (src/telegram/chatwin), before this point. Getting here means
    // that window did not take it; there is no `claude -p` fallback, so say how to bring the window back.
    await deps.reply('The chat window did not take that message. Start the stack with: npm run up (window chat), then write again.');
  } catch {
    await deps.reply('Something went wrong while handling that message.').catch(() => undefined);
  }
}

async function handleCommand(name: string, rest: string, deps: BridgeDeps): Promise<void> {
  if (name === 'help' || name === 'start') return deps.reply(HELP);
  const known = [...READ_ONLY_COMMANDS, 'apply', 'outcome', 'include', 'runhunt', 'instruction', 'drip'];
  if (!known.includes(name)) return deps.reply(`Unknown command /${name}. Try /help.`);
  // /drip answers its status while the kill switch is on and refuses a "now" request itself.
  if (name === 'drip') return (deps.drip ?? new DripController()).command(rest, dripIo(deps), deps.fromId);
  const k = deps.killed();
  if (k.stopped && !READ_ONLY_COMMANDS.includes(name)) {
    return deps.reply(`Kill switch is on (${k.reason}). Only read-only commands answer: /status /limits /working /health /sources /escalations /calibrate /patterns /report.`);
  }

  const argv = commandArgv(name, rest);
  if (argv && 'error' in argv) return deps.reply(argv.error);

  if (name === 'report' && argv && !('error' in argv)) {
    const r = await runChild(deps, argv);
    const file = r.out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    if (!r.ok || !/^reports\/funnel-[0-9-]+\.html$/.test(file)) return deps.reply(`❌ **Report failed**\n${codeBlock(r.out)}`);
    await deps.sendDocument(path.join(deps.root, file), 'Funnel report');
    return;
  }
  if (name === 'runhunt') {
    // No headless wake: the request goes to the running scheduler daemon, which runs the wake through the windows (src/scheduler/wakeRequest.ts).
    const out = await withDb(deps, (db) => requestWake(db, path.join(deps.root, '.jobber'), new Date()));
    if (!out.ok) return deps.reply(`⚠️ **No wake requested**\n${out.message}`);
    return deps.reply(`✅ **Wake requested** (${out.request.id})\nThe scheduler daemon runs it through the windows within about 30 seconds; the result comes to the **wakes** topic. Quiet hours, halts and the kill switch still apply.`);
  }
  if (argv) {
    const r = await runChild(deps, argv);
    // The script text is printed unchanged inside a code block (columns line up); only the bold heading is added.
    return deps.reply(r.ok ? `**${COMMAND_HEADING[name] ?? `/${name}`}**\n${codeBlock(r.out)}` : `❌ **/${name} failed**\n${codeBlock(r.out)}`);
  }

  if (name === 'status') {
    const f = await withDb(deps, (db) => funnelStats(db, matchThresholdFromEnv(deps.env)));
    return deps.reply([
      '📈 **Funnel**',
      `discovered **${f.discovered}** → matched **${f.matched}** → contacted **${f.contacted}** → replied **${f.replied}** → interview **${f.interview}** → offer **${f.offer}**`,
      '',
      `- **reply rate:** ${pct(f.rates.reply)} _(typical 3%, 2-13%)_`,
      `- **interview rate:** ${pct(f.rates.interview)}`,
      `- **rejection rate:** ${pct(f.rates.rejection)}`,
      `- **median days to first response:** ${f.first_response_days_median ?? 'n/a'}`,
    ].join('\n'));
  }
  if (name === 'outcome') {
    const [jobId, outcome, ...note] = rest.split(/\s+/).filter(Boolean);
    if (!jobId || !outcome || !(OUTCOMES as readonly string[]).includes(outcome)) return deps.reply(`usage: /outcome <job_id> <${OUTCOMES.join('|')}> [note]`);
    const r = await withDb(deps, (db) => recordOutcomeChecked(db, jobId, outcome as Outcome, note.join(' ') || undefined));
    return deps.reply(`✅ **Outcome recorded**\n- **job:** \`${jobId}\`\n- **outcome:** \`${outcome}\`${r.warning ? `\n- _${r.warning}_` : ''}`);
  }
  if (name === 'include') {
    const jobId = rest.replace(/^#/, '').trim();
    if (!jobId || /\s/.test(jobId)) return deps.reply('usage: /include <job_id>');
    const r = await withDb(deps, (db) => unexcludeJob(db, jobId));
    return deps.reply(r.ok ? `✅ **Job included again**\n- **job:** \`${jobId}\`\n- **previous reason:** ${r.previous_reason}` : `⚠️ **Not changed**\n${r.error}`);
  }
  if (name === 'calibrate') {
    const c = await withDb(deps, (db) => calibrate(getCalibrationRows(db)));
    return deps.reply(codeBlock(JSON.stringify(c, null, 2)));
  }
  if (name === 'patterns') {
    const p = await withDb(deps, (db) => patternStats(db));
    return deps.reply(codeBlock(JSON.stringify(p, null, 2)));
  }
}
