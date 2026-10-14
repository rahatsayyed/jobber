// A small, strict, dependency-free XML/RSS reader for board feeds (Personio, We Work Remotely).
// Linear time (one forward scan, no backtracking regexes), size and shape capped, entities decoded exactly once.
// Not supported on purpose: DOCTYPE and entity declarations (throws); processing instructions and comments are skipped.
import { decodeOnce } from './filters.js';

export interface XmlNode { name: string; text: string; children: XmlNode[] }

export const MAX_XML_CHARS = 15 * 1024 * 1024;
export const MAX_XML_NODES = 200_000;
export const MAX_XML_DEPTH = 32;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

// Parse `xml` into a virtual root node (name "#root"). `text` of a node is its own character data (entity-decoded once)
// plus its CDATA sections (raw), concatenated in document order; children keep their order. Attributes are ignored.
// Throws "xml: <reason>" for malformed or over-limit input.
export function parseXml(xml: string): XmlNode {
  const src = String(xml ?? '');
  if (src.length > MAX_XML_CHARS) throw new Error('xml: document too large');
  const root: XmlNode = { name: '#root', text: '', children: [] };
  const stack: XmlNode[] = [root];
  const parts: string[][] = [[]];
  let nodes = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { if (stack.length > 1) parts[parts.length - 1].push(decodeOnce(src.slice(i))); break; }
    if (lt > i && stack.length > 1) parts[parts.length - 1].push(decodeOnce(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e === -1) throw new Error('xml: unterminated comment');
      i = e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      if (e === -1) throw new Error('xml: unterminated CDATA');
      if (stack.length > 1) parts[parts.length - 1].push(src.slice(lt + 9, e));
      i = e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      if (e === -1) throw new Error('xml: unterminated declaration');
      i = e + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) throw new Error('xml: DOCTYPE and entity declarations are not allowed');
    // Tag: scan to the closing ">" honouring quoted attribute values (each character is visited once).
    let j = lt + 1;
    let quote = '';
    for (; j < n; j++) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
    }
    if (j >= n) throw new Error('xml: unterminated tag');
    const inner = src.slice(lt + 1, j);
    i = j + 1;
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const top = stack[stack.length - 1];
      if (stack.length < 2 || top.name !== name) throw new Error('xml: mismatched closing tag');
      top.text = (parts.pop() as string[]).join('');
      stack.pop();
      continue;
    }
    const m = NAME_RE.exec(inner);
    if (!m) throw new Error('xml: malformed tag');
    if (++nodes > MAX_XML_NODES) throw new Error('xml: too many elements');
    const node: XmlNode = { name: m[0], text: '', children: [] };
    stack[stack.length - 1].children.push(node);
    if (inner.endsWith('/')) continue;
    if (stack.length > MAX_XML_DEPTH) throw new Error('xml: nesting too deep');
    stack.push(node);
    parts.push([]);
  }
  if (stack.length > 1) throw new Error('xml: unclosed element');
  return root;
}

/** Direct children with this name. */
export const childrenOf = (n: XmlNode | undefined, name: string): XmlNode[] => (n ? n.children.filter((c) => c.name === name) : []);
/** First direct child with this name. */
export const childOf = (n: XmlNode | undefined, name: string): XmlNode | undefined => (n ? n.children.find((c) => c.name === name) : undefined);
/** Trimmed text of the first direct child with this name ('' when absent). */
export const textOf = (n: XmlNode | undefined, name: string): string => childOf(n, name)?.text.trim() ?? '';
/** All descendants with this name in document order; iterative, so depth cannot overflow the call stack. */
export function descendantsOf(n: XmlNode | undefined, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  if (!n) return out;
  const stack: XmlNode[] = [...n.children].reverse();
  while (stack.length) {
    const cur = stack.pop() as XmlNode;
    if (cur.name === name) out.push(cur);
    for (let k = cur.children.length - 1; k >= 0; k--) stack.push(cur.children[k]);
  }
  return out;
}
