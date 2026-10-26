// A tiny DOM double that is just big enough to run the browserctl in-page script (bcScript) in node:
// elements with attributes and text, OPEN and closed shadow roots, same-origin and cross-origin iframes,
// every element visible unless style="display:none". No selector engine: the script must not need one.
import { bcScript } from '../../src/browserctl/snapshot.js';

type Kid = FEl | string;

class Container {
  kids: FEl[] = [];
  nodes: ({ nodeType: 1; el: FEl } | { nodeType: 3; nodeValue: string })[] = [];
  host: FEl | null = null;
  get firstElementChild(): FEl | null { return this.kids[0] ?? null; }
  add(k: Kid): void {
    if (typeof k === 'string') { this.nodes.push({ nodeType: 3, nodeValue: k }); return; }
    k.container = this; k.parent = this instanceof FEl ? this : null;
    this.kids.push(k); this.nodes.push({ nodeType: 1, el: k });
  }
}

export class FEl extends Container {
  nodeType = 1 as const;
  tagName: string;
  attrs: Record<string, string>;
  container: Container | null = null;
  parent: FEl | null = null;
  shadowRoot: Container | null = null;
  contentDocument: { body: FEl | null; elementFromPoint?: () => null; activeElement?: null } | null = null;
  crossOrigin = false;
  value = '';
  constructor(tag: string, attrs: Record<string, string> = {}, kids: Kid[] = []) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    for (const k of kids) this.add(k);
  }
  get parentElement(): FEl | null { return this.parent; }
  get nextElementSibling(): FEl | null {
    const c = this.container; if (!c) return null;
    return c.kids[c.kids.indexOf(this) + 1] ?? null;
  }
  get childNodes(): unknown[] { return this.nodes.map((n) => (n.nodeType === 1 ? n.el : n)); }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k: string): boolean { return k in this.attrs; }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getRootNode(): { host?: FEl } {
    let x: FEl | null = this;
    while (x && x.parent) x = x.parent;
    const c = x?.container;
    return c && c.host ? { host: c.host } : {};
  }
  getBoundingClientRect() { return { width: 100, height: 20, right: 100, bottom: 20, left: 0, top: 0 }; }
  // A browser top-layer element (a popover, a position:fixed box) has offsetParent null, so the double says so for every
  // element: the in-page script must never read visibility from it.
  get offsetParent(): null { return null; }
  querySelector(): null { return null; }
  get innerText(): string { return ''; }
  get textContent(): string { return ''; }
}

export const el = (tag: string, attrs: Record<string, string> = {}, ...kids: Kid[]): FEl => new FEl(tag, attrs, kids);

/** Attach an OPEN (default) or closed shadow root holding these children to a host. */
export function shadow(host: FEl, kids: Kid[], open = true): FEl {
  const root = new Container();
  root.host = host;
  for (const k of kids) root.add(k);
  if (open) host.shadowRoot = root;
  return host;
}

export function iframe(kids: Kid[], crossOrigin = false): FEl {
  const f = new FEl('iframe', {});
  const body = new FEl('body', {}, kids);
  if (crossOrigin) {
    Object.defineProperty(f, 'contentDocument', { get() { throw new Error('SecurityError'); } });
  } else {
    f.contentDocument = { body, elementFromPoint: () => null, activeElement: null };
  }
  return f;
}

/** Run bcScript against a body element. */
export function runBc<T>(body: FEl, mode: 'snapshot' | 'describe' | 'at' | 'focused' | 'diag', args: { n?: number; x?: number; y?: number } = {}, url = 'https://www.linkedin.com/in/jane-example/'): T | null {
  const doc = { body, documentElement: body, title: 'Test', activeElement: null as FEl | null, elementFromPoint: () => null };
  const loc = { href: url, pathname: new URL(url).pathname };
  const win = { scrollX: 0, scrollY: 0 };
  const cs = (e: FEl) => ({
    display: (e.attrs['style'] ?? '').includes('display:none') ? 'none' : 'block', visibility: 'visible', opacity: '1',
    fontSize: '16px', textIndent: '0px', clipPath: 'none', clip: 'auto', overflow: 'visible', overflowX: 'visible', overflowY: 'visible',
    color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
  });
  const fn = new Function('document', 'location', 'window', 'getComputedStyle', `return ${bcScript(mode, args)};`);
  return fn(doc, loc, win, cs) as T | null;
}
