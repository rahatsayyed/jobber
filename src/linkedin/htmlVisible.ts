// Dependency-free tolerant HTML tokenizer plus visible-text rules. Mirrors the in-page
// inline-style/attribute hiding rules; class-based CSS hiding is the in-page script's job.
// Linear scan, no nested-quantifier regex. Zero-width/bidi chars are NOT stripped here (gateInput does).

export interface HtmlNode {
  tag: string; // lowercase; '#text' for text nodes
  attrs: Record<string, string>;
  text?: string;
  children: HtmlNode[];
  hidden: boolean; // computed from the rules, inherited by descendants
}

const MAX_INPUT = 2 * 1024 * 1024;
const MAX_DEPTH = 200;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const HIDDEN_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', 'svg', 'iframe']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul', 'button', 'option', 'td', 'th',
]);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function isWs(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
}

/** Parse one start-tag body (after the name) into attrs. i points just past the tag name; returns [attrs, indexAfter'>', selfClose]. */
function parseAttrs(s: string, i: number): [Record<string, string>, number] {
  const attrs: Record<string, string> = {};
  const n = s.length;
  while (i < n) {
    while (i < n && (isWs(s[i]) || s[i] === '/')) i++;
    if (i >= n) break;
    if (s[i] === '>') return [attrs, i + 1];
    let j = i;
    while (j < n && !isWs(s[j]) && s[j] !== '=' && s[j] !== '>' && s[j] !== '/') j++;
    const name = s.slice(i, j).toLowerCase();
    i = j;
    while (i < n && isWs(s[i])) i++;
    let val = '';
    if (s[i] === '=') {
      i++;
      while (i < n && isWs(s[i])) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, i + 1);
        if (end < 0) { val = s.slice(i + 1); i = n; } else { val = s.slice(i + 1, end); i = end + 1; }
      } else {
        let k = i;
        while (k < n && !isWs(s[k]) && s[k] !== '>') k++;
        val = s.slice(i, k);
        i = k;
      }
    }
    if (name && !(name in attrs)) attrs[name] = decode(val);
    if (name === '') i++; // guarantee progress
  }
  return [attrs, n];
}

function mk(tag: string, attrs: Record<string, string>, hidden: boolean): HtmlNode {
  return { tag, attrs, children: [], hidden };
}

export function parseHtml(html: string): HtmlNode {
  const root = mk('#root', {}, false);
  try {
    const s = (html ?? '').length > MAX_INPUT ? html.slice(0, MAX_INPUT) : html ?? '';
    const lower = s.toLowerCase();
    const n = s.length;
    const stack: HtmlNode[] = [root];
    let overflow = 0; // open non-void tags beyond the depth cap (not pushed)
    const top = () => stack[stack.length - 1];
    const addText = (t: string) => {
      if (!t) return;
      const p = top();
      p.children.push({ tag: '#text', attrs: {}, text: decode(t), children: [], hidden: p.hidden || overflow > 0 });
    };
    let i = 0;
    while (i < n) {
      const lt = s.indexOf('<', i);
      if (lt < 0) { addText(s.slice(i)); break; }
      if (lt > i) addText(s.slice(i, lt));
      i = lt;
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      const c = s[i + 1];
      if (c === '!' || c === '?') {
        const end = s.indexOf('>', i + 2);
        i = end < 0 ? n : end + 1;
        continue;
      }
      if (c === '/') {
        let j = i + 2;
        while (j < n && !isWs(s[j]) && s[j] !== '>') j++;
        const name = lower.slice(i + 2, j);
        const end = s.indexOf('>', j);
        i = end < 0 ? n : end + 1;
        if (VOID.has(name)) continue;
        if (overflow > 0) { overflow--; continue; }
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].tag === name) { stack.length = k; break; }
        }
        continue;
      }
      if (!c || !/[a-zA-Z]/.test(c)) { addText('<'); i++; continue; }
      let j = i + 1;
      while (j < n && !isWs(s[j]) && s[j] !== '>' && s[j] !== '/') j++;
      const tag = lower.slice(i + 1, j);
      const [attrs, next] = parseAttrs(s, j);
      i = next;
      const parent = top();
      const atCap = stack.length > MAX_DEPTH || overflow > 0;
      const node = mk(tag, attrs, parent.hidden || atCap || isHiddenByAttrs(tag, attrs));
      parent.children.push(node);
      if (VOID.has(tag)) continue;
      if (RAW_TEXT.has(tag)) {
        const end = lower.indexOf('</' + tag, i);
        const body = end < 0 ? s.slice(i) : s.slice(i, end);
        if (body) node.children.push({ tag: '#text', attrs: {}, text: body, children: [], hidden: true });
        if (end < 0) { i = n; } else {
          const gt = s.indexOf('>', end);
          i = gt < 0 ? n : gt + 1;
        }
        continue;
      }
      if (atCap) overflow++;
      else stack.push(node);
    }
  } catch {
    // tolerant: return what we have
  }
  return root;
}

function parseStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of style.split(';')) {
    const c = decl.indexOf(':');
    if (c < 0) continue;
    const k = decl.slice(0, c).trim().toLowerCase();
    const v = decl.slice(c + 1).replace(/!important/gi, '').trim().toLowerCase();
    if (k) out[k] = v;
  }
  return out;
}

function num(v: string): { n: number; unit: string } | null {
  const m = /^(-?[0-9]*\.?[0-9]+)([a-z%]*)$/.exec(v.trim());
  if (!m) return null;
  return { n: parseFloat(m[1]), unit: m[2] };
}

const NAMED_COLORS: Record<string, string> = { white: '#ffffff', black: '#000000' };
function normColor(v: string): string {
  let c = v.replace(/\s+/g, '');
  if (NAMED_COLORS[c]) c = NAMED_COLORS[c];
  if (/^#[0-9a-f]{3}$/.test(c)) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  if (c === 'rgb(255,255,255)') c = '#ffffff';
  if (c === 'rgb(0,0,0)') c = '#000000';
  return c;
}

function styleHides(st: Record<string, string>): boolean {
  if (st['display'] === 'none') return true;
  const vis = st['visibility'];
  if (vis === 'hidden' || vis === 'collapse') return true;
  if (st['opacity'] !== undefined) {
    const o = num(st['opacity']);
    if (o && o.n === 0) return true;
  }
  if (st['font-size'] !== undefined) {
    const f = num(st['font-size']);
    if (f) {
      if (f.n === 0) return true;
      if ((f.unit === 'px' || f.unit === 'pt') && f.n <= 5) return true;
    }
  }
  const ov = `${st['overflow'] ?? ''} ${st['overflow-x'] ?? ''} ${st['overflow-y'] ?? ''}`;
  if (ov.includes('hidden')) {
    for (const k of ['width', 'height']) {
      if (st[k] !== undefined) {
        const d = num(st[k]);
        if (d && d.n === 0) return true;
      }
    }
  }
  const pos = st['position'];
  if (pos === 'absolute' || pos === 'fixed') {
    for (const k of ['left', 'top']) {
      if (st[k] !== undefined) {
        const d = num(st[k]);
        if (d && d.n <= -999) return true;
      }
    }
  }
  if (st['text-indent'] !== undefined) {
    const d = num(st['text-indent']);
    if (d && d.n <= -999) return true;
  }
  if (st['clip'] !== undefined && /^rect\(0(px)?,?\s*0(px)?,?\s*0(px)?,?\s*0(px)?\)$/.test(st['clip'])) return true;
  if (st['clip-path'] !== undefined && /^inset\(\s*100%/.test(st['clip-path'])) return true;
  const color = st['color'];
  if (color !== undefined) {
    if (color === 'transparent') return true;
    const bg = st['background-color'] ?? st['background'];
    if (bg !== undefined) {
      const nc = normColor(color);
      const flat = bg.replace(/\s*,\s*/g, ',');
      for (const tok of flat.split(' ')) if (tok && normColor(tok) === nc) return true;
    }
  }
  return false;
}

export function isHiddenByAttrs(tag: string, attrs: Record<string, string>): boolean {
  const t = tag.toLowerCase();
  if (HIDDEN_TAGS.has(t)) return true;
  if ('hidden' in attrs) return true;
  if ((attrs['aria-hidden'] ?? '').trim().toLowerCase() === 'true') return true;
  if (t === 'input' && (attrs['type'] ?? '').trim().toLowerCase() === 'hidden') return true;
  const style = attrs['style'];
  if (style) return styleHides(parseStyle(style));
  return false;
}

export function visibleText(node: HtmlNode): string {
  const parts: string[] = [];
  const walk = (nd: HtmlNode) => {
    if (nd.hidden) return;
    if (nd.tag === '#text') { parts.push(nd.text ?? ''); return; }
    const block = BLOCK.has(nd.tag);
    if (block) parts.push('\n');
    for (const ch of nd.children) walk(ch);
    if (block) parts.push('\n');
  };
  walk(node);
  return parts
    .join('')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

export function findAll(node: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode[] {
  const out: HtmlNode[] = [];
  const walk = (nd: HtmlNode) => {
    if (pred(nd)) out.push(nd);
    for (const ch of nd.children) walk(ch);
  };
  walk(node);
  return out;
}

export function textOf(node: HtmlNode): string {
  return visibleText(node);
}
