// src/platform/noticeLog.ts
// A plain-text copy of every notice the code sends to Telegram, for the dashboard "Notices" tab. One JSON line per notice in
// <root>/.jobber/notices.jsonl (mode 0600). Written BEFORE the Telegram call (see sendToTopic), so a notice is kept even when Telegram is
// not configured or the send fails. recordNotice never throws and never blocks the send. The file is bounded: past 1 MB only the last
// 500 lines are kept (atomic rewrite). Text is plain (HTML tags stripped, entities decoded), secret shapes redacted, and bounded.
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../safety/redact.js';
import { htmlToPlain } from './tgHtml.js';

export interface Notice {
  id: string;
  at: string;
  topic: string;
  urgency: 'loud' | 'silent';
  title: string;
  text: string;
}

export const NOTICE_FILE_MAX_BYTES = 1_000_000;
export const NOTICE_KEEP_LINES = 500;
export const NOTICE_TEXT_MAX = 1500;
export const NOTICE_TITLE_MAX = 120;

export function noticesPath(root: string): string {
  return path.join(root, '.jobber', 'notices.jsonl');
}

function toPlain(text: string, html: boolean | undefined): string {
  let s = String(text ?? '');
  if (html) s = htmlToPlain(s);
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n');
  try { s = redactSecrets(s); } catch { /* best effort */ }
  return s.trim();
}

function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

function rotate(file: string): void {
  if (statSync(file).size <= NOTICE_FILE_MAX_BYTES) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${lines.slice(-NOTICE_KEEP_LINES).join('\n')}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Append one notice. Never throws. */
export function recordNotice(
  root: string,
  n: { topic: string; text: string; silent: boolean; html?: boolean },
  now: Date = new Date(),
): void {
  try {
    const plain = toPlain(n.text, n.html);
    const firstLine = plain.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    const notice: Notice = {
      id: randomUUID().slice(0, 12),
      at: now.toISOString(),
      topic: n.topic,
      urgency: n.silent ? 'silent' : 'loud',
      title: cut(firstLine, NOTICE_TITLE_MAX),
      text: cut(plain, NOTICE_TEXT_MAX),
    };
    const file = noticesPath(root);
    mkdirSync(path.dirname(file), { recursive: true });
    const fresh = !existsSync(file);
    appendFileSync(file, `${JSON.stringify(notice)}\n`, { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
    rotate(file);
  } catch { /* the notice log must never break a send */ }
}

/** Newest first. Skips lines that are not a valid notice. */
export function readNotices(root: string, opts: { limit?: number; topic?: string } = {}): Notice[] {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  let raw: string;
  try { raw = readFileSync(noticesPath(root), 'utf8'); } catch { return []; }
  const out: Notice[] = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Partial<Notice>;
      if (!o || typeof o.id !== 'string' || typeof o.at !== 'string' || typeof o.topic !== 'string' || typeof o.text !== 'string') continue;
      if (opts.topic && o.topic !== opts.topic) continue;
      out.push({ id: o.id, at: o.at, topic: o.topic, urgency: o.urgency === 'loud' ? 'loud' : 'silent', title: String(o.title ?? ''), text: o.text });
    } catch { /* skip a bad line */ }
  }
  return out;
}
