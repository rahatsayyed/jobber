// src/scheduler/windowDispatch.ts
// Hands ONE work item to a long-lived interactive `claude` worker window and learns the outcome. This is the ONLY way work
// reaches a model: the mail drip, the LinkedIn drip, the reply check and every wake step go through here (no headless `claude -p`).
//
// dispatch():  validate -> kill switch, usage backoff, claude pane -> per-window lock -> write .jobber/work/<runId>.md (0600)
//              -> type ONE line (sendText) -> tail the transcript until the turn ends, the deadline passes, the window
//              stalls, a usage limit shows up or the kill switch goes on -> scheduler_runs row (trigger from the caller,
//              log_path = the transcript) -> typed result. The lock stays held until finish().
// finish():    after the CALLER has reconciled DB state: remove the work file, type /clear (after an Escape when the turn did
//              not end by itself), mark the transcript stale so the next dispatch finds the new file, release the lock.
// The caller sets any usage backoff (same as the headless path today); this module only reports `usage_limit`.
// Transcript and pane text are untrusted data: only the last assistant text (redacted, 2000 chars) is returned, nothing is logged.
import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type LockHandle } from '../platform/lock.js';
import { takeWindowLock, WINDOW_LOCK_TTL_MS } from '../platform/windowLock.js';
import { redactPane } from '../platform/redact.js';
import { assertClaudePane, assertName, capture, sendText, validateSendText, type Run } from '../platform/tmux.js';
import {
  claudeHomeDir, findTranscriptByTypedText, projectTranscriptDir, readWindowSession, sessionIdOfFile, transcriptFile,
  writeWindowSession,
} from '../platform/windowSession.js';
import { parseTranscriptLine, TranscriptTailer } from '../telegram/chatwin/transcript.js';
import { LIMIT_RE } from './budget.js';
import { finishRun, getState, setRunLogPath, setRunSession, startRun, type RunStatus } from './runLog.js';

type Db = BetterSqlite3.Database;

export type DispatchStatus = 'ok' | 'failed' | 'stalled' | 'usage_limit' | 'killed' | 'timeout' | 'unavailable';

export interface DispatchResult {
  status: DispatchStatus;
  /** Short machine reason: end_turn, api_error, stalled, no_transcript, usage_limit, killed, wall_clock, or why it was refused. */
  stopReason: string;
  /** Last assistant text of the turn, redacted, at most 2000 characters. Untrusted data. */
  summary: string;
  toolCalls: number;
  tokensApprox?: number;
  /** Set unless the item was refused before anything was typed (`unavailable`). Pass it to finish(). */
  runId?: string;
  /** The transcript file that was tailed (when known). */
  transcript?: string;
}

export interface DispatchInput {
  window: string;
  lane: string;
  /** scheduler_runs.trigger, chosen by the caller (for example `mail_drip`). */
  trigger: string;
  /** What the item is, recorded in scheduler_runs.tasks. Code-made, not model text. */
  item: unknown;
  /** The prompt written to the work file. Code-made; the file is 0600 and removed in finish(). */
  promptText: string;
  /** Per-item wall-clock limit in milliseconds. */
  deadlineMs: number;
  dryRun?: boolean;
}

export interface WindowDispatchDeps {
  root: string;
  /** tmux session that holds the windows. */
  session: string;
  run: Run;
  db: Db;
  killed: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Recent pane text of a window. Default: tmux capture-pane through `run`. */
  capture?: (window: string, lines: number) => Promise<string>;
  claudeHome?: string;
  pollMs?: number;
  stallMs?: number;
  /** Quiet time allowed while a background subagent of the window is still running (default 10 minutes). */
  asyncStallMs?: number;
  settleMs?: number;
  paneEveryMs?: number;
  discoverAfterMs?: number;
  lockTtlMs?: number;
  /**
   * Called when the window is missing or is not a claude pane: starts it (manager startWindow path, with the startup line) and waits a
   * bounded time for a claude pane. Returns 'ready' or a short reason. Absent: the item is refused as `window_unavailable`.
   */
  ensureReady?: (window: string) => Promise<string>;
}

const LANE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_PROMPT_CHARS = 100_000;
export const SUMMARY_MAX = 2000;
export const WORK_FILE_MAX_AGE_MS = 24 * 3600_000;
const PANE_LINES = 40;
const ASYNC_QUIET_MS = 600_000;
/** After the last background agent's notice, wait this long for the model to start another turn before the item is closed. */
const ASYNC_SETTLE_MS = 4000;
const PANE_TAIL = 12;
/** A running claude shows "esc to interrupt" in its footer: a quiet transcript then is a slow tool, not a permission prompt. UNVERIFIED. */
const BUSY_PANE_RE = /esc to interrupt/i;
const DONE_OK = new Set(['end_turn', 'stop_sequence']);
const DONE_FAIL = new Set(['max_tokens', 'refusal']);

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export const workDir = (root: string): string => path.join(root, '.jobber', 'work');
export const workFile = (root: string, runId: string): string => path.join(workDir(root), `${runId}.md`);

/** Removes work files older than 24 hours. Returns how many were removed. Never throws. */
export function cleanupWorkFiles(root: string, nowMs: number, maxAgeMs: number = WORK_FILE_MAX_AGE_MS): number {
  let n = 0;
  let names: string[];
  try { names = readdirSync(workDir(root)); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const f = path.join(workDir(root), name);
    try {
      if (nowMs - statSync(f).mtimeMs > maxAgeMs) { unlinkSync(f); n++; }
    } catch { /* gone or locked: next time */ }
  }
  return n;
}

/** The one line typed into the window. Single line, no leading ! # &, well under 2000 characters. */
export function workItemLine(runId: string): string {
  return `Work item ${runId}: read .jobber/work/${runId}.md and do exactly what it says; do not do anything else`;
}

interface LineInfo { limit: boolean; stopReason: string | null; apiError: boolean; chars: number }

/** What the dispatcher needs from one raw transcript line, beyond parseTranscriptLine. Sidechain (subagent) lines count for nothing. */
function inspectLine(line: string): LineInfo {
  const none: LineInfo = { limit: false, stopReason: null, apiError: false, chars: 0 };
  let j: unknown;
  try { j = JSON.parse(line); } catch { return none; }
  if (!isObj(j) || j.isSidechain === true) return none;
  const msg = isObj(j.message) ? j.message : null;
  if (j.type === 'system') {
    const t = typeof j.content === 'string' ? j.content : typeof j.message === 'string' ? j.message : '';
    return { ...none, limit: LIMIT_RE.test(t) };
  }
  if (j.type !== 'assistant' || !msg) return none;
  let text = '';
  let chars = 0;
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') { text += `${b.text}\n`; chars += b.text.length; }
    else if (b.type === 'tool_use') { try { chars += JSON.stringify(b.input ?? {}).length; } catch { /* ignore */ } }
  }
  const apiError = j.isApiErrorMessage === true || (j.error !== undefined && j.error !== null && j.error !== false);
  // Only an API error entry may report a usage limit: the model's own text can say "rate limit reached" about anything.
  return { limit: apiError && LIMIT_RE.test(text), stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null, apiError, chars };
}

/**
 * Background subagents of the window's main thread. A model that starts an Agent call "in the background" ends its first turn with
 * "waiting for the completion notice" and the harness opens a NEW turn when the notice arrives. That first end_turn is not the end
 * of the item: the result (the final report line) comes in the second turn. `launched` are the tool_use ids whose Agent result said
 * "Async agent launched", `finished` the ids of a `<task-notification>` that came back.
 */
export function asyncAgentEvents(line: string): { launched: string[]; finished: string[] } {
  const out = { launched: [] as string[], finished: [] as string[] };
  let j: unknown;
  try { j = JSON.parse(line); } catch { return out; }
  if (!isObj(j) || j.isSidechain === true) return out;
  // A hand-back or completion notice reaches the transcript as a `user` string, as an `attachment` of type queued_command
  // (attachment.prompt) or as a `queue-operation` entry. The model's own lines (assistant) and tool results never count.
  let notice = '';
  if (j.type === 'attachment' && isObj(j.attachment) && typeof j.attachment.prompt === 'string') notice = j.attachment.prompt;
  else if (j.type === 'queue-operation' && typeof j.content === 'string') notice = j.content;
  else if (j.type === 'user' && isObj(j.message) && typeof j.message.content === 'string') notice = j.message.content;
  if (notice !== '') {
    if (notice.includes('<task-notification>')) {
      for (const m of notice.matchAll(/<(?:tool-use-id|task-id)>([A-Za-z0-9_-]{1,80})<\/(?:tool-use-id|task-id)>/g)) out.finished.push(m[1] as string);
    }
    // the subagent's final report delivered to the main thread (a completion notice may or may not follow it)
    for (const m of notice.matchAll(/<agent-message from="([A-Za-z0-9_-]{1,80})"/g)) out.finished.push(m[1] as string);
    return out;
  }
  if (j.type !== 'user' || !isObj(j.message)) return out;
  const c = j.message.content;
  for (const b of Array.isArray(c) ? c : []) {
    if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    const inner = b.content;
    const text = typeof inner === 'string' ? inner : Array.isArray(inner) ? inner.map((x) => (isObj(x) && typeof x.text === 'string' ? x.text : '')).join('\n') : '';
    if (/Async agent launched/i.test(text)) {
      const agent = /agentId:\s*([A-Za-z0-9_-]{1,80})/.exec(text)?.[1] ?? '';
      out.launched.push(`${b.tool_use_id}|${agent}`);
    }
  }
  return out;
}

function paneHasLimit(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-PANE_TAIL);
  return LIMIT_RE.test(lines.join('\n'));
}

interface Active {
  window: string;
  workFile: string;
  lock: LockHandle;
  status: DispatchStatus;
}

export class WindowDispatcher {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly dir: string;
  /** Windows whose recorded transcript is stale (after /clear): the next dispatch finds the new file by the typed text. */
  private readonly stale = new Set<string>();
  private readonly active = new Map<string, Active>();

  constructor(private readonly d: WindowDispatchDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.dir = projectTranscriptDir(d.root, d.claudeHome ?? claudeHomeDir());
  }

  private target(window: string): string {
    return `=${this.d.session}:=${window}`;
  }

  private paneText(window: string): Promise<string> {
    return this.d.capture ? this.d.capture(window, PANE_LINES) : capture(this.d.run, this.d.session, window, PANE_LINES);
  }

  private refuse(stopReason: string): DispatchResult {
    return { status: 'unavailable', stopReason, summary: '', toolCalls: 0 };
  }

  private validate(i: DispatchInput): string | null {
    try { assertName(i.window); } catch { return 'invalid:window'; }
    if (typeof i.lane !== 'string' || !LANE_RE.test(i.lane)) return 'invalid:lane';
    if (typeof i.trigger !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(i.trigger)) return 'invalid:trigger';
    if (typeof i.promptText !== 'string' || i.promptText.trim() === '' || i.promptText.length > MAX_PROMPT_CHARS || i.promptText.includes('\0')) {
      return 'invalid:prompt';
    }
    if (!Number.isFinite(i.deadlineMs) || i.deadlineMs < 1000 || i.deadlineMs > 6 * 3600_000) return 'invalid:deadline';
    return null;
  }

  async dispatch(i: DispatchInput): Promise<DispatchResult> {
    const bad = this.validate(i);
    if (bad) return this.refuse(bad);
    if (this.d.killed()) return this.refuse('killed');
    const until = getState(this.d.db, 'usage_backoff_until');
    if (until && Date.parse(until) > this.now()) return this.refuse('usage_backoff');
    try {
      await assertClaudePane(this.d.run, this.d.session, i.window);
    } catch (e) {
      const why = /not found/.test((e as Error).message) ? 'window_missing' : 'not_claude';
      if (!this.d.ensureReady) return this.refuse(`window_unavailable:${why}`);
      let r: string;
      try { r = await this.d.ensureReady(i.window); } catch { r = 'ensure_failed'; }
      if (r !== 'ready') return this.refuse(`window_unavailable:${why}:${r}`.slice(0, 80));
      if (this.d.killed()) return this.refuse('killed');
      try { await assertClaudePane(this.d.run, this.d.session, i.window); } catch { return this.refuse(`window_unavailable:${why}:not_ready`); }
    }
    const lock = takeWindowLock(this.d.root, i.window, `dispatch:${i.window}`, this.d.lockTtlMs ?? WINDOW_LOCK_TTL_MS);
    if (!lock) return this.refuse('window_busy');

    const runId = `w-${i.window.slice(0, 12)}-${this.now().toString(36)}-${randomBytes(2).toString('hex')}`;
    const file = workFile(this.d.root, runId);
    let typed = false;
    try {
      cleanupWorkFiles(this.d.root, this.now());
      mkdirSync(workDir(this.d.root), { recursive: true });
      writeFileSync(file, `# Work item ${runId} (lane ${i.lane})\n\n${i.promptText}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      const line = workItemLine(runId);
      validateSendText(line);
      const rec = readWindowSession(this.d.root, i.window);
      let tailer: TranscriptTailer | null = null;
      if (rec && !rec.stale && !this.stale.has(i.window)) tailer = TranscriptTailer.atEnd(transcriptFile(this.dir, rec.session_id));
      const sentAt = this.now();
      try {
        await sendText(this.d.run, this.d.session, i.window, line);
        typed = true;
      } catch {
        return this.refuseAndRelease(lock, file, 'send_failed');
      }
      startRun(this.d.db, {
        id: runId, at: new Date(sentAt), trigger: i.trigger, dryRun: i.dryRun === true, tasks: [{ lane: i.lane, item: i.item }],
        status: 'running', window: i.window, ...(tailer ? { logPath: tailer.file } : {}),
      });
      this.active.set(runId, { window: i.window, workFile: file, lock, status: 'ok' });
      const result = await this.watch(i, runId, line, sentAt, tailer, lock);
      const a = this.active.get(runId);
      if (a) a.status = result.status;
      return result;
    } catch (e) {
      // A bug or a disk error: never leave the lock or a half-written run behind.
      if (this.active.has(runId)) {
        try { finishRun(this.d.db, runId, { at: new Date(this.now()), status: 'crashed', stopReason: 'dispatch_error' }); } catch { /* ignore */ }
        this.active.delete(runId);
      }
      if (typed) this.stale.add(i.window);
      this.cleanupFile(file);
      lock.release();
      return { status: 'failed', stopReason: `dispatch_error: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 80)}`, summary: '', toolCalls: 0, ...(typed ? { runId } : {}) };
    }
  }

  private refuseAndRelease(lock: LockHandle, file: string, why: string): DispatchResult {
    this.cleanupFile(file);
    lock.release();
    return this.refuse(why);
  }

  private cleanupFile(file: string): void {
    try { unlinkSync(file); } catch { /* already gone */ }
  }

  private async escape(window: string): Promise<void> {
    try { await this.d.run('tmux', ['send-keys', '-t', this.target(window), 'Escape']); } catch { /* best effort */ }
  }

  private async watch(
    i: DispatchInput, runId: string, typedLine: string, sentAt: number, start: TranscriptTailer | null, lock: LockHandle,
  ): Promise<DispatchResult> {
    const pollMs = this.d.pollMs ?? 1000;
    const stallMs = this.d.stallMs ?? 60_000;
    const paneEveryMs = this.d.paneEveryMs ?? 10_000;
    const discoverAfterMs = this.d.discoverAfterMs ?? 3000;
    let tailer = start;
    let gotLine = false;
    let toolCalls = 0;
    let chars = 0;
    let curText = '';
    let toolSince: number | null = null;
    let lastSize = tailer ? tailer.size() : -1;
    let lastGrowAt = this.now();
    let lastPaneAt = this.now();
    let escaped = false;
    const asyncOut = new Set<string>();
    let heldDone = false; // an end_turn was held back because a background agent was out, and nothing happened since
    let emptiedAt = 0;
    let lastHeldText = '';
    const asyncQuietMs = this.d.asyncStallMs ?? ASYNC_QUIET_MS;

    const conclude = (status: DispatchStatus, stopReason: string): DispatchResult => {
      const summary = redactPane(curText.trim()).slice(-SUMMARY_MAX);
      const tokensApprox = Math.round(chars / 4);
      const runStatus: RunStatus =
        status === 'ok' ? 'ok' : status === 'stalled' ? 'incomplete' : status === 'timeout' ? 'budget_exceeded' : status === 'usage_limit' ? 'usage_limit' : status === 'killed' ? 'killed' : 'failed';
      try {
        finishRun(this.d.db, runId, { at: new Date(this.now()), status: runStatus, stopReason, toolCalls, tokensApprox, summary });
      } catch { /* the caller still gets the result */ }
      return { status, stopReason, summary, toolCalls, tokensApprox, runId, ...(tailer ? { transcript: tailer.file } : {}) };
    };

    const discover = (): void => {
      const hit = findTranscriptByTypedText(this.dir, typedLine, sentAt - 5000);
      if (!hit || (tailer && hit.file === tailer.file)) return;
      tailer = new TranscriptTailer(hit.file, hit.offset);
      this.stale.delete(i.window);
      lastSize = tailer.size();
      lastGrowAt = this.now();
      try { setRunLogPath(this.d.db, runId, hit.file); } catch { /* ignore */ }
      const id = sessionIdOfFile(hit.file);
      if (id) {
        try { setRunSession(this.d.db, runId, id); } catch { /* ignore */ }
        try { writeWindowSession(this.d.root, i.window, id); } catch { /* the next dispatch finds it again */ }
      }
    };

    for (;;) {
      await this.sleep(pollMs);
      lock.heartbeat();
      const t = this.now();

      if (this.d.killed()) {
        if (!escaped) { escaped = true; await this.escape(i.window); }
        return conclude('killed', 'killed');
      }

      if (!tailer) discover();
      else if (!gotLine && t - sentAt >= discoverAfterMs && tailer.size() <= tailer.offset) discover();

      let outcome: { status: DispatchStatus; reason: string } | null = null;
      if (tailer) {
        for (const line of tailer.readLines()) {
          gotLine = true;
          const info = inspectLine(line);
          chars += info.chars;
          if (info.limit && !outcome) outcome = { status: 'usage_limit', reason: 'usage_limit' };
          const ae = asyncAgentEvents(line);
          for (const id of ae.launched) asyncOut.add(id);
          for (const id of ae.finished) for (const k of [...asyncOut]) if (k.split('|').includes(id)) asyncOut.delete(k);
          if (ae.finished.length > 0 && asyncOut.size === 0) emptiedAt = t;
          for (const ev of parseTranscriptLine(line)) {
            if (ev.kind === 'tool') { toolCalls++; toolSince = t; curText = ''; heldDone = false; }
            else if (ev.kind === 'tool_result') toolSince = null;
            else if (ev.kind === 'text') { toolSince = null; curText += `${curText ? '\n' : ''}${ev.text}`; heldDone = false; }
            else if (ev.kind === 'done' && !outcome && !info.apiError && asyncOut.size > 0 && info.stopReason === 'end_turn') {
              // "waiting for the background agent": the real result usually comes in the next turn. Keep watching. The completion
              // notice arrives AFTER the model's reaction turn, so when it empties the set with no new activity since the last
              // end_turn, that last turn was the final one (see the check below).
              toolSince = t;
              heldDone = true;
              if (curText.trim() !== '') lastHeldText = curText;
              curText = '';
            } else if (ev.kind === 'done' && !outcome) {
              if (info.apiError) outcome = { status: 'failed', reason: 'api_error' };
              else if (info.stopReason !== null && DONE_FAIL.has(info.stopReason)) outcome = { status: 'failed', reason: info.stopReason };
              else outcome = { status: 'ok', reason: info.stopReason !== null && DONE_OK.has(info.stopReason) ? info.stopReason : 'end_turn' };
            }
          }
        }
        const size = tailer.size();
        if (size !== lastSize) { lastSize = size; lastGrowAt = t; }
      }
      if (!outcome && heldDone && asyncOut.size === 0 && t - emptiedAt >= ASYNC_SETTLE_MS) {
        curText = lastHeldText; // the held turn was the final one: the agents are back and the model did not go on
        outcome = { status: 'ok', reason: 'end_turn' };
      }
      if (outcome) return conclude(outcome.status, outcome.reason);

      let pane: string | null = null;
      const needPane = t - lastPaneAt >= paneEveryMs;
      const quiet = t - lastGrowAt >= (asyncOut.size > 0 ? Math.max(stallMs, asyncQuietMs) : stallMs);
      if (needPane || quiet || t - sentAt >= i.deadlineMs) {
        lastPaneAt = t;
        try { pane = await this.paneText(i.window); } catch { pane = null; }
        if (pane !== null && paneHasLimit(pane)) return conclude('usage_limit', 'usage_limit');
      }

      if (t - sentAt >= i.deadlineMs) return conclude('timeout', 'wall_clock');
      if (!tailer && t - sentAt >= stallMs) return conclude('stalled', 'no_transcript');
      if (tailer && toolSince !== null && quiet) {
        if (pane !== null && BUSY_PANE_RE.test(pane)) lastGrowAt = t; // still running a slow tool
        else return conclude('stalled', 'stalled');
      }
    }
  }

  /**
   * Call after the item's outcome was reconciled in the DB. Removes the work file, types /clear (after an Escape when the
   * turn did not end by itself), marks the transcript stale, and releases the window lock. Never throws.
   */
  async finish(runId: string): Promise<{ cleared: boolean; reason?: string }> {
    const a = this.active.get(runId);
    if (!a) return { cleared: false, reason: 'unknown_run' };
    this.active.delete(runId);
    this.cleanupFile(a.workFile);
    this.stale.add(a.window); // the recorded transcript is stale whatever happens next
    try {
      if (this.d.killed()) return { cleared: false, reason: 'killed' };
      if (a.status === 'timeout' || a.status === 'stalled') {
        await this.escape(a.window);
        await this.sleep(500);
      }
      try {
        await assertClaudePane(this.d.run, this.d.session, a.window);
        await sendText(this.d.run, this.d.session, a.window, '/clear');
      } catch (e) {
        return { cleared: false, reason: (e as Error).message.replace(/\s+/g, ' ').slice(0, 80) };
      }
      await this.sleep(this.d.settleMs ?? 1500);
      return { cleared: true };
    } finally {
      a.lock.release();
    }
  }
}
