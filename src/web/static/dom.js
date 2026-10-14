// src/web/static/dom.js
// DOM helpers. Everything is built with createElement and textContent; there is no markup parsing anywhere.
// Only the attribute allowlist below can be set, so a stored value can never become a link or a handler.
const ATTRS = new Set(['class', 'id', 'type', 'value', 'disabled', 'placeholder']);
const attrOk = (k) => ATTRS.has(k) || k.startsWith('aria-') || k.startsWith('data-');

function append(node, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    child.forEach((c) => append(node, c));
    return;
  }
  node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/** el('div', {class: 'x', on: {click: fn}}, 'text', childNode, ...) */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    } else if (attrOk(k)) {
      if (k === 'disabled') node.disabled = true;
      else if (k === 'value') node.value = String(v);
      else node.setAttribute(k, String(v));
    } else {
      throw new Error(`attribute not allowed: ${k}`);
    }
  }
  children.forEach((c) => append(node, c));
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Same-origin form with fixed hidden fields. The action must be a literal absolute path on this site. */
export function form(action, method, hidden, ...children) {
  if (!/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(action)) throw new Error('bad form action');
  const f = document.createElement('form');
  f.method = method;
  f.action = action;
  for (const [name, value] of Object.entries(hidden || {})) {
    const i = el('input', { type: 'hidden', value });
    i.name = name;
    f.appendChild(i);
  }
  children.forEach((c) => append(f, c));
  return f;
}

export const show = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));

/** columns: [{label, key?, render?(row)}]; each cell carries data-label for the stacked phone layout. */
export function table(columns, rows) {
  const head = el('tr', null, columns.map((c) => el('th', null, c.label)));
  const body = rows.map((r) =>
    el('tr', null, columns.map((c) => el('td', { 'data-label': c.label }, c.render ? c.render(r) : show(r[c.key])))),
  );
  return el('table', null, el('thead', null, head), el('tbody', null, body));
}

export const badge = (text, kind) => el('span', { class: `badge ${kind || ''}` }, text);
export const pre = (text) => el('pre', null, show(text));
export const fmtDate = (s) => {
  if (!s) return '-';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString();
};
export const pct = (r) => (r === null || r === undefined ? '-' : `${Math.round(r * 1000) / 10}%`);

export function button(label, onClick, props) {
  return el('button', { type: 'button', ...(props || {}), on: { click: onClick } }, label);
}

export const notice = (text, kind) => el('p', { class: `notice ${kind || ''}`, 'aria-live': 'polite' }, text);

export const showError = (host) => (e) => {
  const wait = e && e.retryAfter ? e.retryAfter : 'a few';
  const msg = e && e.status === 429 ? `Too many requests. Try again in ${wait} seconds.` : 'Could not load this. Try again.';
  clear(host).append(el('p', { class: 'notice error', 'aria-live': 'assertive' }, msg));
};

/** Accumulating cursor pager: fetchPage(cursor) -> {items, nextCursor}; renderAll(items) -> node. */
export function paged(host, fetchPage, renderAll) {
  const items = [];
  const body = el('div');
  const foot = el('div', { class: 'row' });
  host.append(body, foot);
  async function load(cursor) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    clear(body).append(items.length ? renderAll(items) : notice('Nothing to show.'));
    clear(foot);
    if (page.nextCursor !== null && page.nextCursor !== undefined) {
      foot.append(button('Load more', () => load(page.nextCursor).catch(showError(foot))));
    }
  }
  return load(null);
}

/** Interval that skips ticks while the tab is hidden; returns a stop function. */
export function poll(fn, ms) {
  const id = setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
  return () => clearInterval(id);
}
