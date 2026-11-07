// Regression: a fresh session file holds the typed work-item line near its start, followed by a huge api-request-blob.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findTranscriptByTypedText } from '../src/telegram/chatwin/session.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });
const mk = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'tf-')); dirs.push(d); return d; };
const user = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

describe('findTranscriptByTypedText', () => {
  const typed = 'Work item w-apply-x1-abcd: read .jobber/work/w-apply-x1-abcd.md and do exactly what it says; do not do anything else';

  it('finds a line that sits far from the end of a fresh session file', () => {
    const d = mk();
    const head = `${JSON.stringify({ type: 'mode' })}\n${user('<command-name>/clear</command-name>')}\n`;
    const blob = JSON.stringify({ type: 'api-request-blob', body: 'x'.repeat(900_000) });
    writeFileSync(path.join(d, '11111111-1111-4111-8111-111111111111.jsonl'), `${head}${user(typed)}\n${blob}\n${blob}\n`);
    const hit = findTranscriptByTypedText(d, typed, 0);
    expect(hit?.file.endsWith('11111111-1111-4111-8111-111111111111.jsonl')).toBe(true);
    expect(hit?.offset).toBe(Buffer.byteLength(head));
  });

  it('still finds a recent line at the end of a long file', () => {
    const d = mk();
    const old = `${user('old')}\n`.repeat(20_000);
    writeFileSync(path.join(d, '22222222-2222-4222-8222-222222222222.jsonl'), `${old}${user(typed)}\n`);
    const hit = findTranscriptByTypedText(d, typed, 0);
    expect(hit?.offset).toBe(Buffer.byteLength(old));
  });

  it('returns null when no file has the line', () => {
    const d = mk();
    writeFileSync(path.join(d, '33333333-3333-4333-8333-333333333333.jsonl'), `${user('nothing')}\n`);
    expect(findTranscriptByTypedText(d, typed, 0)).toBeNull();
  });
});
