// src/telegram/chatwin/transcript.ts
// Reads Claude Code's JSONL transcript and turns NEW assistant entries into chat events. Only assistant text blocks
// and a short tool line ("using Read file.ts": no command text, no arguments, no results) are ever surfaced; thinking
// blocks, tool results, user and system entries are dropped. Claude Code writes one entry per content block, each
// carrying the message's stop_reason: `tool_use` means the turn goes on, `end_turn` means it is finished.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

export type ChatEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; summary: string }
  | { kind: 'done' }
  | { kind: 'tool_result' };

/** stop_reason values that end a turn (tool_use does not). */
const DONE_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);
const SAFE_NAME = /[^A-Za-z0-9_.:-]/g;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function toolSummary(name: unknown, input: unknown): string {
  const n = (typeof name === 'string' ? name : 'tool').replace(SAFE_NAME, '').slice(0, 60) || 'tool';
  if (FILE_TOOLS.has(n) && isObj(input) && typeof input.file_path === 'string') {
    const base = path.basename(input.file_path).replace(SAFE_NAME, '').slice(0, 60);
    if (base) return `using ${n} ${base}`;
  }
  return `using ${n}`;
}

/** Events of one transcript line. Never throws; a line that is not valid JSON gives no events. */
export function parseTranscriptLine(line: string): ChatEvent[] {
  let j: unknown;
  try { j = JSON.parse(line); } catch { return []; }
  if (!isObj(j) || j.isSidechain === true) return [];
  const msg = isObj(j.message) ? j.message : null;
  if (!msg) return [];
  if (j.type === 'user') {
    const c = msg.content;
    return Array.isArray(c) && c.some((b) => isObj(b) && b.type === 'tool_result') ? [{ kind: 'tool_result' }] : [];
  }
  if (j.type !== 'assistant') return [];
  const out: ChatEvent[] = [];
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') out.push({ kind: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ kind: 'tool', summary: toolSummary(b.name, b.input) });
    // thinking and every other block type: never surfaced
  }
  if (typeof msg.stop_reason === 'string' && DONE_REASONS.has(msg.stop_reason)) out.push({ kind: 'done' });
  return out;
}

/** Offset-based reader: returns only COMPLETE lines; a partial last line waits until its newline is written. */
export class TranscriptTailer {
  private pending = Buffer.alloc(0);

  constructor(public file: string, public offset: number) {}

  /** Start at the current end of the file (history is not replayed). A missing file starts at 0. */
  static atEnd(file: string): TranscriptTailer {
    try { return new TranscriptTailer(file, statSync(file).size); } catch { return new TranscriptTailer(file, 0); }
  }

  /** File size in bytes, or -1 when the file does not exist (yet). */
  size(): number {
    try { return statSync(this.file).size; } catch { return -1; }
  }

  readLines(): string[] {
    const size = this.size();
    if (size < 0) return [];
    if (size < this.offset) { this.offset = 0; this.pending = Buffer.alloc(0); } // truncated or replaced
    if (size === this.offset) return [];
    const len = Math.min(size - this.offset, 4_000_000);
    const buf = Buffer.alloc(len);
    let fd = -1;
    try {
      fd = openSync(this.file, 'r');
      const n = readSync(fd, buf, 0, len, this.offset);
      this.offset += n;
      this.pending = Buffer.concat([this.pending, buf.subarray(0, n)]);
    } catch {
      return [];
    } finally {
      if (fd >= 0) closeSync(fd);
    }
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.pending.indexOf(0x0a)) >= 0) {
      const l = this.pending.subarray(0, nl).toString('utf8').trim();
      this.pending = this.pending.subarray(nl + 1);
      if (l) lines.push(l);
    }
    return lines;
  }
}
