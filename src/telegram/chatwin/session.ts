// src/telegram/chatwin/session.ts
// Where the transcript of the `chat` window lives. The launcher (ensureChatWindow) starts claude with
// `--session-id <uuid>` and records it in .jobber/chat-session.json; Claude Code writes the transcript to
// <claude home>/projects/<encoded project dir>/<session-id>.jsonl. When the id is unknown or stale (after /clear Claude
// starts a new session) the file is found by matching the text the owner typed against the user entries of the
// newest transcripts of the project dir. Nothing here logs transcript content.
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SESSION_ID_RE } from '../../platform/runner.js';

export const chatSessionFile = (root: string): string => path.join(root, '.jobber', 'chat-session.json');

export interface ChatSessionRecord {
  session_id: string;
  started_at: string;
}

export function readChatSessionRecord(root: string): ChatSessionRecord | null {
  try {
    const j = JSON.parse(readFileSync(chatSessionFile(root), 'utf8')) as Partial<ChatSessionRecord>;
    if (typeof j.session_id !== 'string' || !SESSION_ID_RE.test(j.session_id)) return null;
    return { session_id: j.session_id, started_at: typeof j.started_at === 'string' ? j.started_at : '' };
  } catch {
    return null;
  }
}

export function writeChatSessionRecord(root: string, sessionId: string, now: Date = new Date()): void {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid session id');
  const p = chatSessionFile(root);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ session_id: sessionId, started_at: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

/** Claude Code names the project folder after the working directory with every non-alphanumeric character as a dash. */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^A-Za-z0-9-]/g, '-');
}

export function claudeHomeDir(): string {
  return path.join(homedir(), '.claude');
}

/** The folder that holds the transcripts of sessions started in `root`. */
export function projectTranscriptDir(root: string, claudeHome: string): string {
  let real = root;
  try { real = realpathSync(root); } catch { /* use the given path */ }
  return path.join(claudeHome, 'projects', encodeProjectDir(real));
}

export const transcriptFile = (dir: string, sessionId: string): string => path.join(dir, `${sessionId}.jsonl`);

const TAIL_SCAN_BYTES = 400_000;
const HEAD_SCAN_BYTES = 3_000_000;

function userTextOf(line: string): string | null {
  try {
    const j = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    if (j.type !== 'user') return null;
    const c = j.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the transcript that received `typed`: among the .jsonl files of `dir` changed at or after `sinceMs`, the one
 * whose recent user entry contains the typed text. Returns the file and the byte offset of that entry, so the answer
 * that follows is read from there. null when nothing matches.
 */
export function findTranscriptByTypedText(dir: string, typed: string, sinceMs: number): { file: string; offset: number } | null {
  const needle = typed.trim().slice(0, 200);
  if (!needle) return null;
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return null; }
  const cands: { f: string; mtime: number; size: number }[] = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const st = statSync(f);
      if (st.mtimeMs >= sinceMs) cands.push({ f, mtime: st.mtimeMs, size: st.size });
    } catch { /* gone */ }
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  // A new session file holds the typed line near its START and a huge `api-request-blob` (the whole system prompt) right after it,
  // so after one second the line can be far more than TAIL_SCAN_BYTES from the end. Scan the tail first (long-lived session: the
  // line is recent) and then the head (fresh session after /clear).
  const scan = (f: string, start: number, end: number): number | null => {
    if (end <= start) return null;
    const buf = Buffer.alloc(end - start);
    let fd = -1;
    try {
      fd = openSync(f, 'r');
      readSync(fd, buf, 0, buf.length, start);
    } catch {
      return null;
    } finally {
      if (fd >= 0) closeSync(fd);
    }
    let hit: number | null = null;
    const parts = buf.toString('utf8').split('\n');
    // a region that does not begin at a line start has a cut first line: skip it
    let pos = start > 0 ? start + Buffer.byteLength(parts[0]) + 1 : start;
    for (let k = start > 0 ? 1 : 0; k < parts.length; k++) {
      const raw = parts[k];
      const lineStart = pos;
      pos += Buffer.byteLength(raw) + 1;
      if (!raw.includes('"user"')) continue;
      const t = userTextOf(raw);
      if (t !== null && t.includes(needle)) hit = lineStart;
    }
    return hit;
  };
  for (const { f, size } of cands.slice(0, 16)) {
    const tailStart = Math.max(0, size - TAIL_SCAN_BYTES);
    let hit = scan(f, tailStart, size);
    if (hit === null && tailStart > 0) hit = scan(f, 0, Math.min(tailStart + 4096, HEAD_SCAN_BYTES));
    if (hit !== null) return { file: f, offset: hit };
  }
  return null;
}

export const sessionIdOfFile = (file: string): string | null => {
  const id = path.basename(file, '.jsonl');
  return SESSION_ID_RE.test(id) ? id : null;
};
