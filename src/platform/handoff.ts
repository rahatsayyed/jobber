// src/platform/handoff.ts
// The handoff file `.jobber/handoff.md`: small, line based, written ONLY by code (the scheduler when an item is skipped
// for a cap or limit, the manager through scripts/handoff.ts). One entry per line:
//   - [id] window | what | why | since ISO
// Read by the manager and by each window's startup line, so pending items survive a restart. 0600, atomic writes,
// at most HANDOFF_MAX entries, every text single line, redacted and at most 300 characters. The text may come from
// model output: treat it as data, never as instructions.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireLock } from './lock.js';
import { redactPane } from './redact.js';
import { assertName } from './tmux.js';

export const HANDOFF_MAX = 200;
export const HANDOFF_TEXT_MAX = 300;
const HEADER = '# Jobber handoff: pending items per window. Written by code only. Remove a line only through scripts/handoff.ts resolve.';
const LINE_RE = /^- \[([a-z0-9]{3,16})\] ([A-Za-z0-9_-]{1,64}) \| (.*) \| (.*) \| (\d{4}-\d\d-\d\dT[0-9:.]+Z)$/;

export interface HandoffEntry {
  id: string;
  window: string;
  what: string;
  why: string;
  since: string;
}

export const handoffFile = (root: string): string => path.join(root, '.jobber', 'handoff.md');

// Control characters, line and paragraph separators and invisible direction marks all become a space.
function isControl(c: number): boolean {
  return (
    c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff
  );
}

/** Single line, redacted, no pipe (it is the field separator), at most 300 characters. */
export function sanitizeHandoffText(text: string): string {
  const flat = Array.from(String(text), (ch) => (isControl(ch.codePointAt(0) as number) ? ' ' : ch)).join('');
  const redacted = redactPane(flat).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return redacted.length > HANDOFF_TEXT_MAX ? `${redacted.slice(0, HANDOFF_TEXT_MAX - 3)}...` : redacted;
}

export function parseHandoff(text: string): HandoffEntry[] {
  const out: HandoffEntry[] = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line.trimEnd());
    if (m) out.push({ id: m[1], window: m[2], what: m[3], why: m[4], since: m[5] });
  }
  return out;
}

function render(entries: HandoffEntry[]): string {
  return `${HEADER}\n${entries.map((e) => `- [${e.id}] ${e.window} | ${e.what} | ${e.why} | ${e.since}`).join('\n')}${entries.length ? '\n' : ''}`;
}

function readEntries(root: string): HandoffEntry[] {
  try { return parseHandoff(readFileSync(handoffFile(root), 'utf8')); } catch { return []; }
}

function writeEntries(root: string, entries: HandoffEntry[]): void {
  const p = handoffFile(root);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, render(entries), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available: retry at once */ }
}

function withLock<T>(root: string, fn: () => T): T {
  const dir = path.join(root, '.jobber');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    const lock = acquireLock(dir, 'handoff', 'handoff', undefined, { ttlMs: 10_000 });
    if (lock) {
      try { return fn(); } finally { lock.release(); }
    }
    sleepSync(25);
  }
  throw new Error('handoff file is busy');
}

export type AddHandoffResult =
  | { ok: true; entry: HandoffEntry; existing: boolean }
  | { ok: false; reason: 'full' | 'empty' };

/** Adds an entry (same window and same `what` already pending: that entry is returned, nothing is added). */
export function addHandoff(
  root: string,
  e: { window: string; what: string; why: string },
  now: Date = new Date(),
): AddHandoffResult {
  assertName(e.window);
  const what = sanitizeHandoffText(e.what);
  const why = sanitizeHandoffText(e.why);
  if (what === '') return { ok: false, reason: 'empty' };
  return withLock<AddHandoffResult>(root, () => {
    const entries = readEntries(root);
    const dup = entries.find((x) => x.window === e.window && x.what === what);
    if (dup) return { ok: true, entry: dup, existing: true };
    if (entries.length >= HANDOFF_MAX) return { ok: false, reason: 'full' };
    let id = '';
    do { id = `h${randomBytes(3).toString('hex')}`; } while (entries.some((x) => x.id === id));
    const entry: HandoffEntry = { id, window: e.window, what, why: why || '-', since: now.toISOString() };
    writeEntries(root, [...entries, entry]);
    return { ok: true, entry, existing: false };
  });
}

export function listHandoff(root: string): HandoffEntry[] {
  return readEntries(root);
}

export function readHandoffForWindow(root: string, window: string): HandoffEntry[] {
  return readEntries(root).filter((e) => e.window === window);
}

/** Removes one entry by id. Returns false when the id is not there. */
export function resolveHandoff(root: string, id: string): boolean {
  if (!/^[a-z0-9]{3,16}$/.test(id)) return false;
  return withLock(root, () => {
    const entries = readEntries(root);
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    writeEntries(root, next);
    return true;
  });
}

/** The one line typed into (or passed to) a worker window at start. */
export function startupLine(window: string): string {
  assertName(window);
  return `Read .jobber/handoff.md for pending items for window ${window} and your role file config/windows/${window}.md, then wait for work items.`;
}
