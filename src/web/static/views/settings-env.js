// src/web/static/views/settings-env.js
// Environment editor. Rows come from the env list endpoint (never a secret value). Changes are staged in a closure
// Map; a staged secret lives only there (never in the DOM, an attribute, a URL or storage) and is dropped on apply,
// on navigation and when the staged entry is removed. Review calls preview, Apply sends the one-time token back.
import { SETTINGS_API, get, postSettings } from '../api.js';
import { badge, button, clear, el, notice } from '../dom.js';
import { renderDiff, restartLine } from './settings-diff.js';

// ---- pure helpers (exported for tests) ----------------------------------------------------------------------

const isSecretSpec = (s) => s.secret === true || s.type === 'secret';

/** Which control a spec gets. never tier -> readonly; secret -> secret (never a value control). */
export function controlKindFor(spec) {
  if (spec.tier === 'never') return 'readonly';
  if (isSecretSpec(spec)) return 'secret';
  switch (spec.type) {
    case 'bool': return 'switch';
    case 'int': return 'number';
    case 'enum': return 'select';
    case 'string': case 'path': case 'url': case 'email': case 'list': case 'intList': return 'text';
    default: return 'readonly';
  }
}

/** The value a control starts with. A secret never has one. */
export function initialValueFor(spec) {
  if (isSecretSpec(spec)) return '';
  const st = spec.state || {};
  if (st.set && typeof st.value === 'string') return st.value;
  return typeof spec.default === 'string' ? spec.default : '';
}

/** 3 key match, 2 feature match, 1 about match, 0 none. Empty query matches everything (rank 1). */
export function matchesQuery(item, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 1;
  if (String(item.key).toLowerCase().includes(q)) return 3;
  if (String(item.feature || '').toLowerCase().includes(q)) return 2;
  if (String(item.about || '').toLowerCase().includes(q)) return 1;
  return 0;
}

/** sections: [{id, title, items}] -> groups with matching items ranked key-first. open when a query is active. */
export function groupBySection(sections, query, sectionId) {
  const q = String(query || '').trim();
  const out = [];
  for (const s of sections || []) {
    if (sectionId && s.id !== sectionId) continue;
    const ranked = (s.items || [])
      .map((item, i) => ({ item, i, r: matchesQuery(item, q) }))
      .filter((x) => x.r > 0);
    if (q) ranked.sort((a, b) => b.r - a.r || a.i - b.i);
    if (ranked.length === 0) continue;
    out.push({ id: s.id, title: s.title, items: ranked.map((x) => x.item), open: q !== '' });
  }
  return out;
}

function entriesOf(staged) {
  if (staged instanceof Map) return [...staged.entries()];
  return Object.entries(staged || {});
}

/** staged: Map(key -> {op, value?, secret?}) -> the ChangeOp array the API takes. */
export function buildChanges(staged) {
  return entriesOf(staged).map(([key, s]) => (s.op === 'set' ? { key, op: 'set', value: String(s.value ?? '') } : { key, op: s.op }));
}

/** Text for the pending list. A secret value is never part of the result. */
export function redactStagedForRender(staged) {
  return entriesOf(staged).map(([key, s]) => {
    let text;
    if (s.op === 'reset') text = 'reset to default';
    else if (s.op === 'clear') text = s.secret ? 'will be cleared' : 'will be cleared (blank)';
    else if (s.secret) text = 'new value staged (hidden)';
    else text = `set to "${String(s.value ?? '')}"`;
    return { key, text, secret: s.secret === true };
  });
}

const boolOf = (v) => /^(true|1|yes|on)$/i.test(String(v ?? '').trim());

// ---- view ---------------------------------------------------------------------------------------------------

function errorKeys(errors) {
  const map = new Map();
  for (const e of errors || []) {
    const m = /^([A-Z][A-Z0-9_]*)\b/.exec(String(e));
    if (m) map.set(m[1], [...(map.get(m[1]) || []), String(e)]);
  }
  return map;
}

export async function renderEnv({ host, meta, onCleanup, gotoBackups }) {
  const commands = meta.restartCommands || {};
  const staged = new Map(); // key -> {op, value?, secret}; secret values live only here
  const rowRefs = new Map(); // key -> {revert, error}
  let data = null;
  let query = '';
  let sectionId = '';
  let preview = null; // {token, plan}
  let busy = false;

  const status = el('div', { class: 'env-status', role: 'status', 'aria-live': 'polite', id: 'env-status' });
  status.tabIndex = -1;
  const say = (text, kind) => { clear(status).append(notice(text, kind)); };
  const list = el('div', { class: 'env-list' });
  const pendingBox = el('div', { class: 'env-pending' });
  const diffBox = el('div', { class: 'env-review' });
  const bar = el('div', { class: 'env-bar' });

  const search = el('input', { type: 'search', id: 'env-search', 'aria-label': 'Search settings by key, about text or feature', placeholder: 'Search settings (press / to focus)' });
  const sectionSel = el('select', { id: 'env-section', 'aria-label': 'Filter by section' });

  function onKey(ev) {
    const t = ev.target;
    const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (ev.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
      ev.preventDefault();
      search.focus();
    }
  }
  document.addEventListener('keydown', onKey);
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    staged.clear(); // a staged secret never outlives the view
  });

  function invalidate() {
    preview = null;
    clear(diffBox);
  }

  function stage(spec, entry) {
    staged.set(spec.key, { ...entry, secret: isSecretSpec(spec) });
    invalidate();
    paintPending();
  }
  function unstage(key) {
    staged.delete(key);
    const ref = rowRefs.get(key);
    if (ref) ref.revert();
    invalidate();
    paintPending();
  }

  function paintPending() {
    clear(pendingBox);
    const rows = redactStagedForRender(staged);
    const n = rows.length;
    clear(bar).append(
      el('span', { class: 'env-count' }, `${n} pending ${n === 1 ? 'change' : 'changes'}`),
      button('Review changes', review, { class: 'primary', disabled: n === 0 || busy }));
    if (n === 0) return;
    pendingBox.append(el('h3', null, `${n} pending ${n === 1 ? 'change' : 'changes'}`),
      el('ul', { class: 'pending-list' }, rows.map((r) => el('li', null,
        el('code', null, r.key), ` ${r.text} `,
        button('Remove', () => unstage(r.key), { 'aria-label': `Remove pending change for ${r.key}` })))));
  }

  // ---- rows -----------------------------------------------------------------------------------------------

  function badges(spec) {
    const st = spec.state || {};
    const out = [];
    if (isSecretSpec(spec)) out.push(badge('secret'));
    out.push(badge(spec.required === 'required' ? 'required' : spec.required === 'conditional' ? 'required in some setups' : 'optional'));
    if (spec.tier === 'never') out.push(badge(`locked: ${spec.tierReason || 'cannot be changed here'}`, 'bad'));
    else if (spec.tier === 'safety' || spec.tier === 'guarded') out.push(badge(`${spec.tier} setting: ${spec.tierReason || 'extra confirmation needed'}`, 'warn'));
    if (spec.restart && spec.restart !== 'none') {
      out.push(badge(`restart: ${spec.restart}${spec.restartCommand ? `, ${spec.restartCommand}` : ''}`, 'warn'));
    }
    if (st.modified) out.push(badge('modified from default'));
    if (st.shellOverride) out.push(badge('set in shell, ignored by launchers', 'warn'));
    return out;
  }

  function rangeLine(spec) {
    const parts = [];
    if (!isSecretSpec(spec)) parts.push(spec.default !== null && spec.default !== undefined && spec.default !== '' ? `default: ${spec.default}` : 'default: none');
    if (spec.type === 'int' || spec.type === 'intList') {
      if (typeof spec.min === 'number' || typeof spec.max === 'number') parts.push(`range: ${spec.min ?? '-'} to ${spec.max ?? '-'}`);
    }
    if (Array.isArray(spec.allowed) && spec.allowed.length) parts.push(`allowed: ${spec.allowed.join(', ')}`);
    return parts.join(' | ');
  }

  function controlFor(spec, id, describedBy) {
    const kind = controlKindFor(spec);
    const label = `${spec.key} value`;
    const st = staged.get(spec.key);
    const base = initialValueFor(spec);
    const current = st && st.op === 'set' ? st.value : base;
    const commit = (v) => {
      if (v === base) { staged.delete(spec.key); invalidate(); paintPending(); return; }
      stage(spec, { op: 'set', value: v });
    };
    if (kind === 'readonly') {
      return el('p', { class: 'muted', id: `${id}-ro` }, `Read only: ${spec.tierReason || 'this key cannot be changed here'}. Current value: ${spec.state && spec.state.set ? (isSecretSpec(spec) ? 'set' : spec.state.value) : 'not set'}.`);
    }
    if (kind === 'switch') {
      const box = el('input', { type: 'checkbox', id, 'aria-label': label, 'aria-describedby': describedBy });
      box.checked = boolOf(current);
      const word = el('span', { class: 'switch-word' }, box.checked ? 'true' : 'false');
      box.addEventListener('change', () => {
        word.textContent = box.checked ? 'true' : 'false';
        const v = box.checked ? 'true' : 'false';
        if (v === base) { staged.delete(spec.key); invalidate(); paintPending(); } else stage(spec, { op: 'set', value: v });
      });
      rowRefs.get(spec.key).revert = () => { box.checked = boolOf(base); word.textContent = box.checked ? 'true' : 'false'; };
      return el('span', { class: 'switch' }, box, ' ', word);
    }
    if (kind === 'select') {
      const sel = el('select', { id, 'aria-label': label, 'aria-describedby': describedBy });
      const opts = [...new Set([...(spec.allowed || []), ...(current ? [current] : [])])];
      if (!opts.includes('')) sel.append(el('option', { value: '' }, '(blank)'));
      for (const o of opts) sel.append(el('option', { value: o }, o));
      sel.value = current;
      sel.addEventListener('change', () => commit(sel.value));
      rowRefs.get(spec.key).revert = () => { sel.value = base; };
      return sel;
    }
    if (kind === 'secret') return secretControl(spec, id, describedBy);
    const inp = el('input', { type: kind === 'number' ? 'number' : 'text', id, 'aria-label': label, 'aria-describedby': describedBy });
    if (kind === 'number') {
      if (typeof spec.min === 'number') inp.min = String(spec.min);
      if (typeof spec.max === 'number') inp.max = String(spec.max);
      inp.step = '1';
    }
    inp.value = current;
    inp.addEventListener('change', () => commit(inp.value.trim()));
    rowRefs.get(spec.key).revert = () => { inp.value = base; };
    return inp;
  }

  function secretControl(spec, id, describedBy) {
    const holder = el('div', { class: 'secret-control' });
    const set = spec.state && spec.state.set;
    const paint = () => {
      clear(holder);
      const s = staged.get(spec.key);
      if (s && s.op === 'set') {
        holder.append(el('span', null, 'new value staged (hidden)'));
        return;
      }
      if (s && s.op === 'clear') {
        holder.append(el('span', null, 'will be cleared'));
        return;
      }
      holder.append(el('span', { class: 'secret-state' }, set ? 'set' : 'not set'), ' ',
        button('Replace', () => reveal(), { 'aria-label': `Replace ${spec.key}` }),
        set ? button('Clear', () => { stage(spec, { op: 'clear' }); paint(); }, { 'aria-label': `Clear ${spec.key}` }) : null);
    };
    function reveal() {
      clear(holder);
      const field = el('input', { type: 'password', id, 'aria-label': `New value for ${spec.key}`, 'aria-describedby': describedBy });
      field.autocomplete = 'new-password';
      field.spellcheck = false;
      const done = () => { field.value = ''; paint(); };
      holder.append(field, ' ',
        button('Stage new value', () => {
          const v = field.value;
          field.value = '';
          if (v === '') { say(`Type a new value for ${spec.key}, or cancel.`, 'warn'); return; }
          stage(spec, { op: 'set', value: v });
          paint();
        }, { 'aria-label': `Stage new value for ${spec.key}` }),
        button('Cancel', done, { 'aria-label': `Cancel replacing ${spec.key}` }));
      field.focus();
    }
    rowRefs.get(spec.key).revert = paint;
    paint();
    return holder;
  }

  function rowFor(spec) {
    const id = `env-${spec.key}`;
    const aboutId = `${id}-about`;
    rowRefs.set(spec.key, { revert: () => {} });
    const errBox = el('div', { class: 'row-error', 'aria-live': 'polite', id: `${id}-err` });
    rowRefs.get(spec.key).error = errBox;
    const row = el('div', { class: 'env-row', id: `${id}-row` },
      el('label', { class: 'env-key', for: id }, el('code', null, spec.key)),
      el('p', { class: 'env-about', id: aboutId }, spec.about),
      el('div', { class: 'badges' }, badges(spec)),
      el('p', { class: 'muted' }, rangeLine(spec)),
      controlFor(spec, id, aboutId));
    if (spec.state && spec.state.modified && spec.tier !== 'never') {
      row.append(button('Reset to default', () => stage(spec, { op: 'reset' }), { 'aria-label': `Reset ${spec.key} to default` }));
    }
    row.append(errBox);
    return row;
  }

  function paintList() {
    clear(list);
    rowRefs.clear();
    const groups = groupBySection(data.sections, query, sectionId);
    if (groups.length === 0) { list.append(notice('No setting matches.')); return; }
    for (const g of groups) {
      const d = el('details', { class: 'env-group' }, el('summary', null, `${g.title} (${g.items.length})`), g.items.map(rowFor));
      d.open = g.open || groups.length === 1;
      list.append(d);
    }
  }

  // ---- review and apply -----------------------------------------------------------------------------------

  function reauthButton() {
    return button('Needs a fresh sign-in', () => location.assign('/#/login?reauth=1'), { class: 'primary' });
  }

  function showErrors(e) {
    const byKey = errorKeys(e.data && e.data.errors);
    for (const ref of rowRefs.values()) clear(ref.error);
    for (const [k, msgs] of byKey) {
      const ref = rowRefs.get(k);
      if (ref) ref.error.append(...msgs.map((m) => el('p', { class: 'notice error' }, m)));
    }
    return byKey;
  }

  function failure(e) {
    clear(status);
    if (e.status === 401 && e.code === 'reauth_required') {
      status.append(notice('This change needs a fresh sign-in first.', 'warn'), reauthButton());
    } else if (e.status === 409 && e.code === 'stale_etag') {
      status.append(notice('The file changed on disk since you opened this page.', 'warn'),
        button('Reload', () => load(true), { class: 'primary' }));
    } else if (e.status === 422 && e.code === 'invalid_changes') {
      showErrors(e);
      const errs = (e.data && e.data.errors) || [];
      status.append(notice('Some changes are not valid. Fix them and review again.', 'error'),
        el('ul', null, errs.map((m) => el('li', null, String(m)))));
    } else if (e.status === 403 && e.code === 'phrase_mismatch') {
      status.append(notice('The confirmation text did not match. Nothing was changed.', 'error'));
    } else if (e.status === 403 && e.code === 'tier_never') {
      status.append(notice('A locked setting cannot be changed here.', 'error'));
    } else if (e.status === 403 && e.code === 'settings_disabled') {
      status.append(notice('Editing is turned off for this dashboard.', 'error'));
    } else if (e.status === 403) {
      status.append(notice('The change was refused. Review it again to get a new confirmation.', 'error'));
    } else if (e.status === 429) {
      status.append(notice(`Too many attempts. Try again in ${e.retryAfter || 'a few'} seconds.`, 'error'));
    } else {
      status.append(notice('Something went wrong. Nothing was changed.', 'error'));
    }
    status.focus();
  }

  async function review() {
    if (busy || staged.size === 0) return;
    busy = true;
    paintPending();
    try {
      const r = await postSettings('/env/preview', { etag: data.etag, changes: buildChanges(staged) });
      preview = { token: r.token, plan: r.plan };
      clear(status);
      showErrors({ data: { errors: r.plan.errors } });
      const { node, heading } = renderDiff(r.plan, commands);
      const fr = r.plan.friction || {};
      const controls = el('div', { class: 'row' });
      let phraseInput = null;
      if (fr.reauth && !meta.reauthFresh) controls.append(reauthButton());
      if (typeof fr.phrase === 'string' && fr.phrase) {
        phraseInput = el('input', { type: 'text', id: 'env-phrase', 'aria-label': `Type ${fr.phrase} to confirm` });
        phraseInput.autocomplete = 'off';
        controls.append(el('label', { for: 'env-phrase' }, `Type ${fr.phrase} to confirm`), phraseInput);
      }
      const hasErrors = (r.plan.errors || []).length > 0;
      controls.append(button('Apply', () => apply(phraseInput ? phraseInput.value : undefined), { class: 'primary', disabled: hasErrors || (r.plan.diffs || []).length === 0 }));
      clear(diffBox).append(node, controls);
      heading.focus();
    } catch (e) {
      failure(e);
    } finally {
      busy = false;
      paintPending();
    }
  }

  async function apply(phrase) {
    if (busy || !preview) return;
    busy = true;
    paintPending();
    const body = { etag: data.etag, changes: buildChanges(staged), token: preview.token };
    if (phrase !== undefined) body.phrase = phrase;
    try {
      const r = await postSettings('/env/apply', body);
      staged.clear(); // a staged secret is dropped the moment it was sent
      preview = null;
      clear(diffBox);
      const restarts = Array.isArray(r.restart) ? r.restart : [];
      clear(status).append(
        notice(`Saved. Backup id: ${r.backupId}`, 'good'),
        restarts.length ? el('div', null, el('h4', null, 'Restart needed'),
          el('ul', null, restarts.map((x) => el('li', null, restartLine(x, commands))))) : el('p', { class: 'muted' }, 'No restart needed.'),
        el('p', null, 'To undo this, open the Backups tab. ', button('Rollback', () => gotoBackups(), { class: 'link' })));
      status.focus();
      await load(false);
    } catch (e) {
      preview = null; // the token is spent or refused: review again for a new one
      clear(diffBox);
      failure(e);
    } finally {
      busy = false;
      paintPending();
    }
  }

  // ---- load -----------------------------------------------------------------------------------------------

  async function load(dropStaged) {
    if (dropStaged) { staged.clear(); invalidate(); }
    data = await get(`${SETTINGS_API}/env`);
    clear(sectionSel).append(el('option', { value: '' }, 'All sections'),
      data.sections.map((s) => el('option', { value: s.id }, s.title)));
    sectionSel.value = sectionId;
    paintList();
    paintPending();
    if (dropStaged) { clear(status); say('Reloaded from disk.', 'good'); }
  }

  search.addEventListener('input', () => { query = search.value; paintList(); });
  sectionSel.addEventListener('change', () => { sectionId = sectionSel.value; paintList(); });

  clear(host).append(
    el('div', { class: 'env-tools' },
      el('label', { for: 'env-search' }, 'Search'), search,
      el('label', { for: 'env-section' }, 'Section'), sectionSel),
    status, list, pendingBox, diffBox, bar);
  try {
    await load(false);
  } catch {
    clear(host).append(notice('Could not load the environment settings. Try again.', 'error'));
  }
}
