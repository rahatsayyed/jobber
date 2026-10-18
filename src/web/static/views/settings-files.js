// src/web/static/views/settings-files.js
// Config file editor. The file list comes from the server registry (the client sends an id, never a path). A file with
// simple fields gets a form view; every file gets a raw JSON tab. Form edits regenerate the 2-space JSON text on the
// client and go through the same preview call, so the server stays the only validator. Keys the form does not know
// are copied through untouched. No storage, no markup parsing: DOM is built with textContent only.
import { SETTINGS_API, get, postSettings } from '../api.js';
import { badge, button, clear, el, notice } from '../dom.js';
import { failureNodes, frictionControls, renderFileDiff } from './settings-diff.js';

// ---- pure helpers (exported for tests) ----------------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const ATS_NAMES = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio', 'smartrecruiters', 'workday'];
const LEVELS = ['basic', 'professional', 'fluent', 'native'];
const FACT_WARN = 'Adding an entry here widens what the fact gate lets through. Only add a fact you confirmed, and add it to user-data/resume.json first.';

/** Field types: bool, string, enum, int, list (strings), rows (array of objects), keyed (object of objects), qa (map of
 * question to answer), boolish (switch while a boolean, read only otherwise). */
const SCHEMAS = {
  replies: [
    { key: 'auto_record_enabled', label: 'Auto-record detected interviews and rejections', type: 'bool',
      warn: 'Leave this off. With it off, every detected interview or rejection is only a proposal until you approve it.' },
  ],
  'target-regions': [
    { key: 'home', label: 'Home countries', type: 'list' },
    { key: 'targets', label: 'Target regions', type: 'list' },
    { key: 'remote', label: 'Remote roles are acceptable', type: 'bool' },
    { key: 'remote_anywhere', label: 'Remote roles based in other countries are acceptable', type: 'bool',
      warn: 'Keep this in step with location_filter.remote_anywhere in the portals file. Turning it on lets more postings through.' },
  ],
  'deal-breakers': [{ key: 'keywords', label: 'Deal-breaker keywords', type: 'list' }],
  languages: [
    { key: 'confirmed', label: 'This list is confirmed', type: 'bool',
      warn: 'Until this is on, a missing language is only a flag. Once on, a posting that requires a language you did not declare is excluded.' },
    { key: 'declared', label: 'Declared languages', type: 'rows', addable: true, defaultRow: { language: '', level: 'basic' },
      columns: [{ key: 'language', label: 'Language', type: 'string' }, { key: 'level', label: 'Level', type: 'enum', allowed: LEVELS }] },
  ],
  portals: [
    { key: 'tracked_companies', label: 'Tracked companies', type: 'rows', addable: true,
      defaultRow: { name: '', ats: 'greenhouse', slug: '', enabled: false },
      columns: [{ key: 'name', label: 'Name', type: 'string' }, { key: 'ats', label: 'Board type', type: 'enum', allowed: ATS_NAMES },
        { key: 'slug', label: 'Slug', type: 'string' }, { key: 'enabled', label: 'Enabled', type: 'bool' }] },
    { key: 'aggregators', label: 'Aggregator feeds', type: 'keyed', keyCol: 'name', addable: false,
      columns: [{ key: 'name', label: 'Feed', type: 'string', fixed: true }, { key: 'enabled', label: 'Enabled', type: 'bool' },
        { key: 'max_pages', label: 'Max pages', type: 'int' }] },
  ],
  profile: [
    { key: 'roles', label: 'Roles', type: 'list' },
    { key: 'locations', label: 'Locations', type: 'list' },
    { key: 'remote_ok', label: 'Remote is acceptable', type: 'bool' },
    { key: 'remote_anywhere', label: 'Remote roles based elsewhere are acceptable', type: 'bool' },
    { key: 'salary', label: 'Salary bands', type: 'keyed', keyCol: 'currency', addable: true, defaultRow: { currency: '' },
      columns: [{ key: 'currency', label: 'Currency', type: 'string' }, { key: 'floor', label: 'Floor', type: 'int' },
        { key: 'target', label: 'Target', type: 'int' }] },
    { key: 'notice_period_days', label: 'Notice period (days)', type: 'int' },
  ],
  'fact-gate': [
    { key: 'allow_facts', label: 'Allowed facts', type: 'list', warn: FACT_WARN },
    { key: 'allow_metrics', label: 'Allowed metrics', type: 'list', warn: FACT_WARN },
    { key: 'forbidden_phrases', label: 'Forbidden phrases (block)', type: 'list' },
    { key: 'warn_phrases', label: 'Warn phrases', type: 'list' },
  ],
  'easy-apply-answers': [
    { key: 'years_experience', label: 'Years of experience', type: 'int' },
    { key: 'authorized_to_work', label: 'Authorized to work', type: 'bool' },
    { key: 'requires_sponsorship', label: 'Requires sponsorship', type: 'boolish',
      objectBanner: 'requires_sponsorship is an object ({india, other}) in this file. The Easy Apply flow types it as a boolean and falls back to asking you. Change it in the Raw JSON tab.' },
    { key: 'willing_to_relocate', label: 'Willing to relocate', type: 'bool' },
    { key: 'notice_period_days', label: 'Notice period (days)', type: 'int' },
    { key: 'expected_salary', label: 'Expected salary', type: 'string' },
    { key: 'phone', label: 'Phone', type: 'string' },
    { key: 'linkedin_profile_url', label: 'LinkedIn profile URL', type: 'string' },
    { key: 'custom', label: 'Custom questions and answers', type: 'qa', addable: true, defaultRow: { q: '', a: '' },
      columns: [{ key: 'q', label: 'Question', type: 'string' }, { key: 'a', label: 'Answer', type: 'string' }] },
  ],
};

export const FORM_VIEW_IDS = Object.keys(SCHEMAS);

/** The field list of a form view, or null when the file has raw view only. */
export function formSchema(id) {
  return SCHEMAS[id] || null;
}

/** Which control a file field gets. `value` matters only for boolish. */
export function controlKindFor(field, value) {
  switch (field && field.type) {
    case 'bool': return 'switch';
    case 'int': return 'number';
    case 'enum': return 'select';
    case 'string': return 'text';
    case 'list': return 'list';
    case 'rows': case 'keyed': case 'qa': return 'rows';
    case 'boolish': return typeof value === 'boolean' ? 'switch' : 'readonly';
    default: return 'readonly';
  }
}

const cloneRow = (r) => (isObj(r) ? { ...r } : {});

function toFormValue(field, v) {
  switch (field.type) {
    case 'bool': return v === true;
    case 'string': case 'enum': return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
    case 'int': return typeof v === 'number' ? v : v === undefined || v === null ? '' : String(v);
    case 'list': return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String(x))) : [];
    case 'rows': return Array.isArray(v) ? v.map(cloneRow) : [];
    case 'keyed': return isObj(v) ? Object.entries(v).map(([k, val]) => ({ [field.keyCol]: k, ...(isObj(val) ? val : {}) })) : [];
    case 'qa': return isObj(v) ? Object.entries(v).map(([q, a]) => ({ q, a })) : [];
    default: return v;
  }
}

function normInt(v) {
  if (v === '' || v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '') return undefined;
  return /^-?\d+$/.test(s) ? Number(s) : s;
}

function normRow(columns, row) {
  const out = { ...row };
  for (const c of columns || []) {
    if (c.type !== 'int') continue;
    const n = normInt(out[c.key]);
    if (n === undefined) delete out[c.key];
    else out[c.key] = n;
  }
  return out;
}

function fromFormValue(field, f) {
  switch (field.type) {
    case 'bool': return f === true;
    case 'string': case 'enum': return typeof f === 'string' ? f : f === undefined || f === null ? '' : String(f);
    case 'int': return normInt(f);
    case 'list': return (Array.isArray(f) ? f : []).map((x) => String(x).trim()).filter((x) => x !== '');
    case 'rows': return (Array.isArray(f) ? f : []).map((r) => normRow(field.columns, r));
    case 'keyed': {
      const out = {};
      for (const r of Array.isArray(f) ? f : []) {
        const { [field.keyCol]: k, ...rest } = normRow(field.columns, r);
        if (typeof k === 'string' && k.trim() !== '') out[k.trim()] = rest;
      }
      return out;
    }
    case 'qa': {
      const out = {};
      for (const r of Array.isArray(f) ? f : []) if (typeof r.q === 'string' && r.q.trim() !== '') out[r.q.trim()] = r.a;
      return out;
    }
    default: return f;
  }
}

function isEmptyForm(field, f) {
  if (field.type === 'bool' || field.type === 'boolish') return f === false || f === undefined;
  if (field.type === 'string' || field.type === 'enum' || field.type === 'int') return f === '' || f === undefined || f === null;
  if (Array.isArray(f)) return f.length === 0;
  return f === undefined;
}

/** obj (parsed file) -> form state {fieldKey: formValue}. */
export function toForm(id, obj) {
  const o = isObj(obj) ? obj : {};
  const form = {};
  for (const f of SCHEMAS[id] || []) form[f.key] = toFormValue(f, o[f.key]);
  return form;
}

/** Regenerates the file text. Starts from the loaded object, so keys the form does not know survive unchanged. */
export function formToText(id, obj, form) {
  const base = isObj(obj) ? obj : {};
  const out = { ...base };
  for (const f of SCHEMAS[id] || []) {
    const fv = form[f.key];
    if (!(f.key in base) && isEmptyForm(f, fv)) continue;
    const v = fromFormValue(f, fv);
    if (v === undefined) delete out[f.key];
    else out[f.key] = v;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/** Offset of the first syntax error of strict JSON, or -1 when the text parses. Small recursive scanner. */
function errorOffset(text) {
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && ' \t\n\r'.includes(text[i])) i++; };
  const lit = (w) => { if (text.startsWith(w, i)) { i += w.length; return true; } return false; };
  function str() {
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '"') { i++; return true; }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return false;
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else { i++; return false; }
      } else if (c < ' ') return false;
      else i++;
    }
    return false;
  }
  function value() {
    ws();
    if (i >= n) return false;
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return true; }
      for (;;) {
        ws();
        if (text[i] !== '"' || !str()) return false;
        ws();
        if (text[i] !== ':') return false;
        i++;
        if (!value()) return false;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return true; }
        return false;
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return true; }
      for (;;) {
        if (!value()) return false;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return true; }
        return false;
      }
    }
    if (c === '"') return str();
    if (lit('true') || lit('false') || lit('null')) return true;
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (m) { i += m[0].length; return true; }
    return false;
  }
  if (!value()) return Math.min(i, n);
  ws();
  return i < n ? i : -1;
}

function lineColumn(text, offset) {
  const upto = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = upto.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Line and column (1-based) of a JSON syntax error. Uses the engine's hint when it gives one, else a scan. */
export function parseErrorPosition(text, err) {
  const msg = String((err && err.message) || '');
  const lc = /line (\d+) column (\d+)/.exec(msg);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(msg);
  if (pos) return lineColumn(text, Number(pos[1]));
  if (/end of JSON/i.test(msg)) return lineColumn(text, text.length);
  const off = text === '' ? 0 : errorOffset(text);
  return off < 0 ? { line: 1, column: 1 } : lineColumn(text, off);
}

/** {ok: true, value} or {ok: false, line, column, message}. */
export function parseText(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, ...parseErrorPosition(String(text), e), message: String((e && e.message) || 'invalid JSON').slice(0, 200) };
  }
}

/** Badges for the file list. Text carries the meaning; kind is only styling. */
export function fileBadges(s) {
  const out = [];
  if (s.edit) out.push({ text: 'editable', kind: 'good' });
  else out.push({ text: `view only${s.viewReason ? `: ${s.viewReason}` : ''}`, kind: '' });
  if (s.exists === false) out.push({ text: 'missing', kind: 'warn' });
  if (s.problem) out.push({ text: `problem: ${s.problem}`, kind: 'bad' });
  return out;
}

const ID_RE = /^[a-z0-9-]{1,40}$/;

// ---- view ---------------------------------------------------------------------------------------------------

export async function renderFiles({ host, meta, onCleanup, gotoBackups }) {
  const editable = meta.editEnabled === true;
  const commands = meta.restartCommands || {};
  const status = el('div', { class: 'env-status', role: 'status', 'aria-live': 'polite', id: 'files-status' });
  status.tabIndex = -1;
  const say = (text, kind) => { clear(status).append(notice(text, kind)); };
  const listBox = el('div', { class: 'files-list' });
  const editorBox = el('div', { class: 'files-editor' });
  let stopEditor = () => {};
  onCleanup(() => { stopEditor(); });

  async function showList() {
    stopEditor();
    stopEditor = () => {};
    clear(editorBox);
    listBox.hidden = false;
    const rows = await get(`${SETTINGS_API}/files`);
    clear(listBox).append(el('ul', { class: 'files-ul' }, rows.map((s) => el('li', { class: 'file-row' },
      el('code', null, s.rel),
      el('div', { class: 'badges' }, fileBadges(s).map((b) => badge(b.text, b.kind))),
      ID_RE.test(s.id) ? button(s.edit && editable ? 'Open' : 'View', () => openFile(s.id), { 'aria-label': `${s.edit && editable ? 'Open' : 'View'} ${s.rel}` }) : null))));
  }

  async function openFile(id) {
    clear(status);
    let data;
    try {
      data = await get(`${SETTINGS_API}/files/${id}`);
    } catch {
      say('Could not open this file. Try again.', 'error');
      status.focus();
      return;
    }
    listBox.hidden = true;
    stopEditor();
    stopEditor = editor(id, data);
  }

  function editor(id, data) {
    const entry = data.entry;
    const canEdit = editable && entry.edit === true;
    const cur = { text: data.text, etag: data.etag, preview: null, busy: false };
    let tab = FORM_VIEW_IDS.includes(id) && canEdit ? 'form' : 'raw';
    let obj0 = null;
    let form = null;
    const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Editor view' });
    const body = el('div', { class: 'file-body' });
    const parseBox = el('div', { class: 'parse-status', role: 'status', 'aria-live': 'polite' });
    const diffBox = el('div', { class: 'env-review' });
    const bar = el('div', { class: 'env-bar' });
    let raw = null;
    let reviewBtn = null;

    const invalidate = () => { cur.preview = null; clear(diffBox); };

    function paintParse() {
      clear(parseBox);
      const r = parseText(cur.text);
      if (!r.ok) parseBox.append(notice(`JSON error at line ${r.line}, column ${r.column}: ${r.message}`, 'error'));
      if (reviewBtn) reviewBtn.disabled = !r.ok || cur.busy || !canEdit;
      return r;
    }

    function onFormChange() {
      cur.text = formToText(id, obj0, form);
      if (raw) raw.value = cur.text;
      invalidate();
      paintParse();
    }

    // ---- form controls ----------------------------------------------------------------------------------

    function textInput(label, value, onInput, opts) {
      const inp = el('input', { type: opts && opts.number ? 'number' : 'text', 'aria-label': label });
      if (opts && opts.number) inp.step = '1';
      if (opts && opts.readOnly) inp.readOnly = true;
      inp.value = value === undefined || value === null ? '' : String(value);
      inp.addEventListener('input', () => onInput(inp.value));
      return inp;
    }

    function cellFor(field, col, row, rowNo, repaint) {
      const label = `${field.label}, row ${rowNo + 1}, ${col.label}`;
      if (col.type === 'bool') {
        const box = el('input', { type: 'checkbox', 'aria-label': label });
        box.checked = row[col.key] === true;
        const word = el('span', { class: 'switch-word' }, box.checked ? 'true' : 'false');
        box.addEventListener('change', () => { row[col.key] = box.checked; word.textContent = box.checked ? 'true' : 'false'; onFormChange(); });
        return el('span', { class: 'switch' }, box, ' ', word);
      }
      if (col.type === 'enum') {
        const sel = el('select', { 'aria-label': label });
        const opts = [...new Set([...(col.allowed || []), ...(row[col.key] ? [String(row[col.key])] : [])])];
        for (const o of opts) sel.append(el('option', { value: o }, o));
        sel.value = typeof row[col.key] === 'string' ? row[col.key] : opts[0] || '';
        sel.addEventListener('change', () => { row[col.key] = sel.value; onFormChange(); });
        return sel;
      }
      if (col.fixed) return el('code', null, String(row[col.key] ?? ''));
      return textInput(label, row[col.key], (v) => { row[col.key] = v; onFormChange(); }, { number: col.type === 'int' });
    }

    function rowsControl(field) {
      const box = el('div', { class: 'rows-editor' });
      const rows = form[field.key];
      const paint = (focusLast) => {
        clear(box);
        rows.forEach((row, i) => {
          const fields = el('div', { class: 'row-fields' }, field.columns.map((col) => el('div', { class: 'cell' },
            el('span', { class: 'cell-label muted' }, col.label), cellFor(field, col, row, i, paint))));
          box.append(el('div', { class: 'row-item' }, fields,
            field.addable ? button('Remove', () => { rows.splice(i, 1); onFormChange(); paint(false); }, { 'aria-label': `Remove ${field.label} row ${i + 1}` }) : null));
        });
        if (field.addable) {
          box.append(button('Add row', () => {
            rows.push({ ...(field.defaultRow || {}) });
            onFormChange();
            paint(true);
          }, { 'aria-label': `Add a row to ${field.label}` }));
        }
        if (focusLast) {
          const inputs = box.querySelectorAll('.row-item:last-of-type input');
          if (inputs.length > 0) inputs[0].focus();
        }
      };
      paint(false);
      return box;
    }

    function listControl(field) {
      const box = el('div', { class: 'rows-editor' });
      const items = form[field.key];
      const paint = (focusLast) => {
        clear(box);
        items.forEach((v, i) => {
          box.append(el('div', { class: 'row-item' },
            textInput(`${field.label}, item ${i + 1}`, v, (nv) => { items[i] = nv; onFormChange(); }),
            button('Remove', () => { items.splice(i, 1); onFormChange(); paint(false); }, { 'aria-label': `Remove ${field.label} item ${i + 1}` })));
        });
        box.append(button('Add item', () => { items.push(''); onFormChange(); paint(true); }, { 'aria-label': `Add an item to ${field.label}` }));
        if (focusLast) {
          const inputs = box.querySelectorAll('.row-item:last-of-type input');
          if (inputs.length > 0) inputs[0].focus();
        }
      };
      paint(false);
      return box;
    }

    function fieldNode(field) {
      const id2 = `ff-${id}-${field.key}`;
      const kind = controlKindFor(field, obj0 ? obj0[field.key] : undefined);
      const head = el('h4', { id: `${id2}-h` }, field.label);
      const wrap = el('div', { class: 'file-field', role: 'group', 'aria-labelledby': `${id2}-h` }, head);
      if (field.warn) wrap.append(el('p', { class: 'notice warn' }, field.warn));
      if (kind === 'readonly') {
        wrap.append(notice(field.objectBanner || 'This field cannot be edited in the form. Use the Raw JSON tab.', 'warn'),
          el('pre', null, JSON.stringify(obj0 ? obj0[field.key] : null, null, 2)));
      } else if (kind === 'switch') {
        const box = el('input', { type: 'checkbox', id: id2, 'aria-label': field.label });
        box.checked = form[field.key] === true;
        const word = el('span', { class: 'switch-word' }, box.checked ? 'true' : 'false');
        box.addEventListener('change', () => { form[field.key] = box.checked; word.textContent = box.checked ? 'true' : 'false'; onFormChange(); });
        wrap.append(el('span', { class: 'switch' }, box, ' ', word));
      } else if (kind === 'list') wrap.append(listControl(field));
      else if (kind === 'rows') wrap.append(rowsControl(field));
      else {
        wrap.append(textInput(field.label, form[field.key], (v) => { form[field.key] = v; onFormChange(); }, { number: kind === 'number' }));
      }
      return wrap;
    }

    // ---- body ---------------------------------------------------------------------------------------------

    function paintBody() {
      clear(body);
      clear(tabs);
      if (FORM_VIEW_IDS.includes(id) && canEdit) {
        tabs.append(...[['form', 'Form'], ['raw', 'Raw JSON']].map(([n, label]) => button(label, () => { tab = n; paintBody(); }, {
          class: n === tab ? 'tab active' : 'tab', 'aria-pressed': n === tab ? 'true' : 'false' })));
      }
      raw = null;
      if (tab === 'form') {
        const r = parseText(cur.text);
        if (!r.ok || !isObj(r.value)) {
          body.append(notice(`The text is not valid JSON (line ${r.line || 1}, column ${r.column || 1}). Fix it in the Raw JSON tab first.`, 'error'));
        } else {
          obj0 = r.value;
          form = toForm(id, obj0);
          body.append(...SCHEMAS[id].map(fieldNode));
        }
      } else {
        raw = el('textarea', { id: 'file-raw', 'aria-label': `Raw JSON text of ${entry.rel}` });
        raw.spellcheck = false;
        raw.wrap = 'off';
        raw.value = cur.text;
        raw.readOnly = !canEdit;
        raw.addEventListener('input', () => { cur.text = raw.value; invalidate(); paintParse(); });
        body.append(raw);
      }
      paintParse();
    }

    // ---- review and apply ---------------------------------------------------------------------------------

    function reloadClick() {
      openFile(id).catch(() => { say('Could not reload. Try again.', 'error'); status.focus(); });
    }

    function failure(e) {
      clear(status).append(...failureNodes(e, reloadClick));
      status.focus();
    }

    async function review() {
      if (cur.busy || !paintParse().ok) return;
      cur.busy = true;
      paintParse();
      try {
        const r = await postSettings(`/files/${id}/preview`, { etag: cur.etag, text: cur.text });
        cur.preview = { token: r.token, plan: r.plan };
        clear(status);
        const { node, heading } = renderFileDiff(r.plan, commands);
        const { controls, getPhrase } = frictionControls(r.plan.friction, meta.reauthFresh, 'file');
        const unchanged = !!(r.plan.diff && r.plan.diff.unchanged);
        controls.append(button('Apply', () => apply(getPhrase()), { class: 'primary', disabled: unchanged }));
        clear(diffBox).append(node, controls);
        heading.focus();
      } catch (e) {
        failure(e);
      } finally {
        cur.busy = false;
        paintParse();
      }
    }

    async function apply(phrase) {
      if (cur.busy || !cur.preview) return;
      cur.busy = true;
      paintParse();
      const body2 = { etag: cur.etag, text: cur.text, token: cur.preview.token };
      if (phrase !== undefined) body2.phrase = phrase;
      let done = null;
      try {
        done = await postSettings(`/files/${id}/apply`, body2);
        cur.preview = null;
        clear(diffBox);
        const restarts = Array.isArray(done.restart) ? done.restart : [];
        clear(status).append(notice(`Saved. Backup id: ${done.backupId}`, 'good'),
          el('p', null, restarts.length ? 'Read on next run.' : 'No restart needed: read on every use.'),
          el('p', null, 'To undo this, open the Backups tab. ', button('Rollback', () => gotoBackups(), { class: 'link' })));
        status.focus();
        cur.etag = done.newEtag || cur.etag;
      } catch (e) {
        cur.preview = null;
        clear(diffBox);
        failure(e);
      } finally {
        cur.busy = false;
        paintParse();
      }
    }

    reviewBtn = button('Review changes', review, { class: 'primary' });
    reviewBtn.disabled = !canEdit;
    clear(editorBox).append(
      el('div', { class: 'file-head' }, el('h3', null, entry.rel),
        el('div', { class: 'badges' }, fileBadges({ edit: canEdit, exists: data.exists, viewReason: canEdit ? '' : entry.viewReason || 'editing is off' }).map((b) => badge(b.text, b.kind))),
        button('Back to files', () => { showList().catch(() => say('Could not load the file list.', 'error')); }, { 'aria-label': 'Back to the file list' })),
      ...(data.warnings || []).map((w) => notice(`Warning: ${w}`, 'warn')),
      tabs, parseBox, body, diffBox, canEdit ? bar : null);
    if (canEdit) bar.append(el('span', { class: 'env-count' }, 'Edits stay here until you review and apply.'), reviewBtn);
    paintBody();
    return () => { cur.preview = null; };
  }

  clear(host).append(status, listBox, editorBox);
  try {
    await showList();
  } catch {
    clear(host).append(notice('Could not load the file list. Try again.', 'error'));
  }
}
