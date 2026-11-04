import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addHandoff, handoffFile, HANDOFF_MAX, HANDOFF_TEXT_MAX, listHandoff, parseHandoff, readHandoffForWindow, resolveHandoff,
  sanitizeHandoffText, startupLine,
} from '../src/platform/handoff.js';
import type { Run } from '../src/platform/tmux.js';
import {
  readWindowSession, typeStartupLine, windowSessionFile, windowTranscript, writeWindowSession,
} from '../src/platform/windowSession.js';
import { laneUsesWindow, parseWindowLanes } from '../src/scheduler/windowLanes.js';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'wh-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('handoff file', () => {
  it('adds, lists, filters by window and resolves; file is 0600', () => {
    const a = addHandoff(root, { window: 'mail', what: 'email to a@x.io skipped', why: 'daily cap' }, new Date('2026-11-04T10:00:00.000Z'));
    expect(a.ok && a.entry.since).toBe('2026-11-04T10:00:00.000Z');
    const b = addHandoff(root, { window: 'linkedin', what: 'invite waiting', why: 'limit reached' });
    expect(listHandoff(root)).toHaveLength(2);
    expect(readHandoffForWindow(root, 'mail').map((e) => e.what)).toEqual(['email to a@x.io skipped']);
    expect(statSync(handoffFile(root)).mode & 0o777).toBe(0o600);
    expect(readFileSync(handoffFile(root), 'utf8')).toMatch(/^- \[h[0-9a-f]{6}\] mail \| email to a@x.io skipped \| daily cap \| 2026-11-04T10:00:00.000Z$/m);
    if (!a.ok || !b.ok) throw new Error('add failed');
    expect(resolveHandoff(root, a.entry.id)).toBe(true);
    expect(resolveHandoff(root, a.entry.id)).toBe(false);
    expect(resolveHandoff(root, '../bad')).toBe(false);
    expect(listHandoff(root).map((e) => e.id)).toEqual([b.entry.id]);
  });

  it('the same window and text is added once (idempotent for the scheduler)', () => {
    const a = addHandoff(root, { window: 'mail', what: 'same', why: 'w1' });
    const b = addHandoff(root, { window: 'mail', what: 'same', why: 'w2' });
    expect(a.ok && b.ok && b.existing && b.entry.id === a.entry.id).toBe(true);
    expect(listHandoff(root)).toHaveLength(1);
  });

  it('sanitises text: one line, redacted, no pipe, at most 300 characters', () => {
    const sep = String.fromCharCode(0x2028);
    const t = sanitizeHandoffText(`line one\nline two | pipe${sep}x ${'word '.repeat(100)}`);
    expect(t).not.toMatch(/[\n\r|]/);
    expect(t.includes(sep)).toBe(false);
    expect(t.length).toBeLessThanOrEqual(HANDOFF_TEXT_MAX);
    expect(t.endsWith('...')).toBe(true);
    expect(sanitizeHandoffText('TOKEN=abc123 secret')).toBe('[redacted line]');
    expect(sanitizeHandoffText('bot 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end')).toContain('[redacted]');
    const r = addHandoff(root, { window: 'mail', what: 'a | b\nc', why: '' });
    expect(r.ok && r.entry.what).toBe('a / b c');
    expect(r.ok && r.entry.why).toBe('-');
  });

  it('refuses an empty text and a bad window name', () => {
    expect(addHandoff(root, { window: 'mail', what: '  ', why: 'x' })).toEqual({ ok: false, reason: 'empty' });
    expect(() => addHandoff(root, { window: '-x', what: 'a', why: 'b' })).toThrow();
  });

  it('is capped at 200 entries and refuses the next one', () => {
    for (let i = 0; i < HANDOFF_MAX; i++) expect(addHandoff(root, { window: 'mail', what: `item ${i}`, why: 'w' }).ok).toBe(true);
    expect(addHandoff(root, { window: 'mail', what: 'one too many', why: 'w' })).toEqual({ ok: false, reason: 'full' });
    expect(listHandoff(root)).toHaveLength(HANDOFF_MAX);
    const first = listHandoff(root)[0];
    expect(resolveHandoff(root, first.id)).toBe(true);
    expect(addHandoff(root, { window: 'mail', what: 'now fits', why: 'w' }).ok).toBe(true);
  });

  it('ignores lines that are not entries (header, hand edits)', () => {
    expect(parseHandoff('# header\nnot an entry\n- [abc123] mail | a | b | 2026-11-04T10:00:00.000Z\n- [x] bad')).toHaveLength(1);
  });

  it('startupLine is the documented single line', () => {
    expect(startupLine('mail')).toBe('Read .jobber/handoff.md for pending items for window mail and your role file config/windows/mail.md, then wait for work items.');
    expect(() => startupLine('-x')).toThrow();
  });
});

describe('window session record', () => {
  const SID = '11111111-2222-4333-8444-555555555555';

  it('writes ids only, 0600, atomically, and reads them back', () => {
    expect(readWindowSession(root, 'mail')).toBeNull();
    writeWindowSession(root, 'mail', SID, new Date('2026-11-04T10:00:00.000Z'));
    expect(statSync(windowSessionFile(root, 'mail')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(windowSessionFile(root, 'mail'), 'utf8'))).toEqual({ session_id: SID, started_at: '2026-11-04T10:00:00.000Z' });
    expect(readWindowSession(root, 'mail')?.session_id).toBe(SID);
    expect(readWindowSession(root, 'linkedin')).toBeNull();
    expect(windowTranscript(root, 'mail', '/claude-home')).toMatch(new RegExp(`/claude-home/projects/.+/${SID}\\.jsonl$`));
  });

  it('refuses a bad id or window name', () => {
    expect(() => writeWindowSession(root, 'mail', 'nope')).toThrow();
    expect(() => windowSessionFile(root, '../x')).toThrow();
  });
});

describe('typeStartupLine (fallback for the unverified positional prompt)', () => {
  const fake = (windows: () => string): { run: Run; typed: string[] } => {
    const typed: string[] = [];
    const run: Run = async (_c, args) => {
      if (args[0] === 'list-windows') return { stdout: windows(), code: 0 };
      if (args[0] === 'send-keys' && args.includes('-l')) typed.push(args[args.length - 1]);
      return { stdout: '', code: 0 };
    };
    return { run, typed };
  };

  it('waits until the pane runs claude, then types the startup line once', async () => {
    let n = 0;
    const f = fake(() => `0|mail|0|${++n < 3 ? 'zsh' : 'claude'}`);
    const r = await typeStartupLine(f.run, 'Jobber', 'mail', { sleep: async () => undefined });
    expect(r).toBe('typed');
    expect(f.typed).toEqual([startupLine('mail')]);
  });

  it('gives up with not_ready and types nothing when claude never shows up', async () => {
    const f = fake(() => '0|mail|0|zsh');
    expect(await typeStartupLine(f.run, 'Jobber', 'mail', { tries: 3, sleep: async () => undefined })).toBe('not_ready');
    expect(f.typed).toEqual([]);
  });
});

describe('WINDOW_LANES flag', () => {
  it('is empty by default: no lane uses a window', () => {
    expect(parseWindowLanes({})).toEqual({ lanes: [], invalid: [] });
    expect(parseWindowLanes({ WINDOW_LANES: '' }).lanes).toEqual([]);
    expect(laneUsesWindow('mail_drip', {})).toBe(false);
  });

  it('parses a comma list, lowercases, dedupes and reports invalid names', () => {
    const r = parseWindowLanes({ WINDOW_LANES: ' mail_drip, Linkedin_Drip ,mail_drip,bad name,' });
    expect(r.lanes).toEqual(['mail_drip', 'linkedin_drip']);
    expect(r.invalid).toEqual(['bad name']);
    expect(laneUsesWindow('mail_drip', { WINDOW_LANES: 'mail_drip' })).toBe(true);
    expect(laneUsesWindow('apply', { WINDOW_LANES: 'mail_drip' })).toBe(false);
  });
});
