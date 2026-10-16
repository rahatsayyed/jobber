// src/safety/jsonPatch.ts
// Formatting-preserving JSON edits: change only the values that differ, leave every other byte of the file
// (indentation, compact one-line objects, key order) alone, so a rewrite shows a minimal git diff.

interface Node {
  start: number;
  end: number;
  members?: Map<string, Node>;
  items?: Node[];
}

class Scanner {
  constructor(readonly t: string) {}

  ws(i: number): number {
    while (i < this.t.length && /\s/.test(this.t[i])) i++;
    return i;
  }

  str(i: number): number {
    if (this.t[i] !== '"') throw new Error(`json: expected a string at ${i}`);
    i++;
    while (i < this.t.length && this.t[i] !== '"') i += this.t[i] === '\\' ? 2 : 1;
    if (i >= this.t.length) throw new Error('json: unterminated string');
    return i + 1;
  }

  value(i: number): Node {
    i = this.ws(i);
    const c = this.t[i];
    if (c === '{') {
      const members = new Map<string, Node>();
      let p = this.ws(i + 1);
      if (this.t[p] === '}') return { start: i, end: p + 1, members };
      for (;;) {
        const kEnd = this.str(p);
        const key = JSON.parse(this.t.slice(p, kEnd)) as string;
        p = this.ws(kEnd);
        if (this.t[p] !== ':') throw new Error(`json: expected ":" at ${p}`);
        const v = this.value(p + 1);
        members.set(key, v);
        p = this.ws(v.end);
        if (this.t[p] === ',') { p = this.ws(p + 1); continue; }
        if (this.t[p] === '}') return { start: i, end: p + 1, members };
        throw new Error(`json: expected "," or "}" at ${p}`);
      }
    }
    if (c === '[') {
      const items: Node[] = [];
      let p = this.ws(i + 1);
      if (this.t[p] === ']') return { start: i, end: p + 1, items };
      for (;;) {
        const v = this.value(p);
        items.push(v);
        p = this.ws(v.end);
        if (this.t[p] === ',') { p = this.ws(p + 1); continue; }
        if (this.t[p] === ']') return { start: i, end: p + 1, items };
        throw new Error(`json: expected "," or "]" at ${p}`);
      }
    }
    if (c === '"') return { start: i, end: this.str(i) };
    let e = i;
    while (e < this.t.length && !/[\s,}\]]/.test(this.t[e])) e++;
    if (e === i) throw new Error(`json: unexpected character at ${i}`);
    return { start: i, end: e };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function indentStep(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : '  ';
}

function lineIndent(text: string, pos: number): string {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(ls, pos));
  return m ? m[0] : '';
}

interface Edit { start: number; end: number; repl: string }

function diff(text: string, node: Node, oldV: unknown, newV: unknown, edits: Edit[], step: string): void {
  if (sameJson(oldV, newV)) return;
  if (node.members && isObj(oldV) && isObj(newV)) {
    const ok = Object.keys(oldV);
    const nk = Object.keys(newV);
    if (ok.length === nk.length && ok.every((k) => Object.prototype.hasOwnProperty.call(newV, k))) {
      for (const k of ok) diff(text, node.members.get(k) as Node, oldV[k], newV[k], edits, step);
      return;
    }
  }
  if (node.items && Array.isArray(oldV) && Array.isArray(newV) && oldV.length === newV.length) {
    newV.forEach((nv, i) => diff(text, (node.items as Node[])[i], oldV[i], nv, edits, step));
    return;
  }
  const oldText = text.slice(node.start, node.end);
  let repl: string;
  if (!oldText.includes('\n')) repl = JSON.stringify(newV);
  else {
    const base = lineIndent(text, node.start);
    repl = JSON.stringify(newV, null, step).split('\n').map((l, i) => (i === 0 ? l : base + l)).join('\n');
  }
  edits.push({ start: node.start, end: node.end, repl });
}

/**
 * Replace the value at `path` with `newValue`, changing only the parts that differ. Objects with the same key
 * set and arrays of the same length are compared member by member; anything else is replaced as one value, laid
 * out like the text it replaces (one line stays one line). Throws when the path does not exist.
 */
export function patchJsonText(text: string, path: Array<string | number>, newValue: unknown): string {
  const sc = new Scanner(text);
  const root = sc.value(0);
  let node = root;
  let old: unknown = JSON.parse(text);
  for (const seg of path) {
    if (typeof seg === 'string') {
      const next = node.members?.get(seg);
      if (!next || !isObj(old)) throw new Error(`json path not found: ${path.join('.')}`);
      node = next;
      old = old[seg];
    } else {
      const next = node.items?.[seg];
      if (!next || !Array.isArray(old)) throw new Error(`json path not found: ${path.join('.')}`);
      node = next;
      old = old[seg];
    }
  }
  const edits: Edit[] = [];
  diff(text, node, old, newValue, edits, indentStep(text));
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.repl + out.slice(e.end);
  return out;
}
