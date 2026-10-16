// src/settings/diff.ts
// Dependency-free line diff (LCS) for the settings editor. Capped at MAX_LINES per side.
// Lines that differ only in whitespace are paired and counted as "formatting only", separately from real changes.

export const MAX_DIFF_LINES = 5000;
// Cap on the LCS table for the changed middle; beyond it the middle is reported as delete-all/add-all (correct, not minimal).
const MAX_CELLS = 4_000_000;

export interface DiffLine {
  op: 'eq' | 'add' | 'del';
  text: string;
  /** 1-based line number in the old text (eq, del) */
  oldLine?: number;
  /** 1-based line number in the new text (eq, add) */
  newLine?: number;
  /** true when this add/del has a whitespace-only counterpart */
  formatting?: boolean;
}

export interface LineDiff {
  lines: DiffLine[];
  /** substantive added / removed lines (formatting-only pairs excluded) */
  added: number;
  removed: number;
  /** number of whitespace-only changed lines (a pair counts once; a blank-line change counts once) */
  formattingOnly: number;
  /** true when a side exceeded MAX_DIFF_LINES; lines is then empty and counts are zero */
  truncated: boolean;
  unchanged: boolean;
}

const splitLines = (t: string): string[] => (t === '' ? [] : t.replace(/\r\n/g, '\n').split('\n'));

export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if (before === after) return { lines: [], added: 0, removed: 0, formattingOnly: 0, truncated: false, unchanged: true };
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { lines: [], added: 0, removed: 0, formattingOnly: 0, truncated: true, unchanged: false };
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ op: 'eq', text: a[i], oldLine: i + 1, newLine: i + 1 });
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const mid = middleDiff(ma, mb, start);
  out.push(...mid);
  for (let i = endA, j = endB; i < a.length; i++, j++) out.push({ op: 'eq', text: a[i], oldLine: i + 1, newLine: j + 1 });

  // formatting-only pairing
  const key = (s: string) => s.replace(/\s+/g, '');
  const dels = new Map<string, DiffLine[]>();
  for (const l of out) if (l.op === 'del') (dels.get(key(l.text)) ?? dels.set(key(l.text), []).get(key(l.text))!).push(l);
  let formattingOnly = 0;
  for (const l of out) {
    if (l.op !== 'add') continue;
    const k = key(l.text);
    const pool = dels.get(k);
    if (pool && pool.length) {
      pool.shift()!.formatting = true;
      l.formatting = true;
      formattingOnly++;
    } else if (k === '') {
      l.formatting = true;
      formattingOnly++;
    }
  }
  for (const l of out) if (l.op === 'del' && !l.formatting && key(l.text) === '') {
    l.formatting = true;
    formattingOnly++;
  }
  const added = out.filter((l) => l.op === 'add' && !l.formatting).length;
  const removed = out.filter((l) => l.op === 'del' && !l.formatting).length;
  return { lines: out, added, removed, formattingOnly, truncated: false, unchanged: false };
}

function middleDiff(a: string[], b: string[], offset: number): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const res: DiffLine[] = [];
  if (n * m > MAX_CELLS || n === 0 || m === 0) {
    a.forEach((t, i) => res.push({ op: 'del', text: t, oldLine: offset + i + 1 }));
    b.forEach((t, j) => res.push({ op: 'add', text: t, newLine: offset + j + 1 }));
    return res;
  }
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      res.push({ op: 'eq', text: a[i], oldLine: offset + i + 1, newLine: offset + j + 1 });
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      res.push({ op: 'del', text: a[i], oldLine: offset + i + 1 });
      i++;
    } else {
      res.push({ op: 'add', text: b[j], newLine: offset + j + 1 });
      j++;
    }
  }
  for (; i < n; i++) res.push({ op: 'del', text: a[i], oldLine: offset + i + 1 });
  for (; j < m; j++) res.push({ op: 'add', text: b[j], newLine: offset + j + 1 });
  return res;
}
