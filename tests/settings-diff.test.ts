// tests/settings-diff.test.ts
import { describe, expect, it } from 'vitest';
import { MAX_DIFF_LINES, lineDiff } from '../src/settings/diff.js';

describe('lineDiff', () => {
  it('returns an empty diff for unchanged text', () => {
    const d = lineDiff('a\nb\n', 'a\nb\n');
    expect(d).toMatchObject({ lines: [], added: 0, removed: 0, formattingOnly: 0, truncated: false, unchanged: true });
  });

  it('diffs added, removed and changed lines with line numbers', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
    const dels = d.lines.filter((l) => l.op === 'del');
    expect(dels).toEqual([{ op: 'del', text: 'b', oldLine: 2 }]);
    expect(d.lines.filter((l) => l.op === 'add').map((l) => [l.text, l.newLine])).toEqual([['B', 2], ['d', 4]]);
    expect(d.lines.filter((l) => l.op === 'eq').map((l) => l.text)).toEqual(['a', 'c', '']);
  });

  it('finds a minimal diff in the middle (LCS)', () => {
    const d = lineDiff('1\n2\n3\n4\n5', '1\n3\n4\n6\n5');
    expect(d.removed).toBe(1);
    expect(d.added).toBe(1);
  });

  it('counts whitespace-only changes separately', () => {
    const d = lineDiff('{\n"a": 1,\n"b": 2\n}\n', '{\n  "a": 1,\n  "b": 2\n}\n');
    expect(d).toMatchObject({ added: 0, removed: 0, formattingOnly: 2 });
    const real = lineDiff('{\n  "a": 1\n}\n', '{\n    "a": 1\n}\n');
    expect(real).toMatchObject({ added: 0, removed: 0, formattingOnly: 1 });
    const mixed = lineDiff('x\n  y\n', 'x\ny\nz\n');
    expect(mixed).toMatchObject({ added: 1, removed: 0, formattingOnly: 1 });
  });

  it('treats CRLF like LF', () => {
    expect(lineDiff('a\r\nb', 'a\nb').unchanged).toBe(false);
    expect(lineDiff('a\r\nb', 'a\nb')).toMatchObject({ added: 0, removed: 0 });
  });

  it('is capped: beyond the line limit it says truncated and returns no lines', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    const d = lineDiff(big, big + '\nx');
    expect(d.truncated).toBe(true);
    expect(d.lines).toEqual([]);
    const ok = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `l${i}`).join('\n');
    expect(lineDiff(ok, ok + 'x').truncated).toBe(false);
  });

  it('handles empty sides', () => {
    expect(lineDiff('', 'a\nb')).toMatchObject({ added: 2, removed: 0 });
    expect(lineDiff('a\nb', '')).toMatchObject({ added: 0, removed: 2 });
  });
});
