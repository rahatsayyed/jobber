// src/web/static/views/settings-backups.js
// Backups and rollback. Pick a target (the env file or one editable config file), list its backups (time, size, id),
// compare one with the current file through the rollback preview, and restore it through the rollback apply with the
// same friction as any other write. Nothing here reads file content: only the server's plan is rendered.
import { SETTINGS_API, get, postSettings } from '../api.js';
import { button, clear, el, fmtDate, notice, table } from '../dom.js';
import { failureNodes, frictionControls, renderDiff, renderFileDiff } from './settings-diff.js';

// ---- pure helpers (exported for tests) ----------------------------------------------------------------------

/** 'env' or the file id -> the target string the rollback calls take. */
export function targetKey(idOrEnv) {
  return idOrEnv === 'env' ? 'env' : `file:${idOrEnv}`;
}

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const ID_RE = /^[a-z0-9-]{1,40}$/;

// ---- view ---------------------------------------------------------------------------------------------------

export async function renderBackups({ host, meta, onCleanup }) {
  const editable = meta.editEnabled === true;
  const commands = meta.restartCommands || {};
  const status = el('div', { class: 'env-status', role: 'status', 'aria-live': 'polite', id: 'backups-status' });
  status.tabIndex = -1;
  const listBox = el('div', { class: 'backups-list' });
  const reviewBox = el('div', { class: 'env-review' });
  const sel = el('select', { id: 'backups-target', 'aria-label': 'Backup target' });
  let current = { token: null, backupId: null, target: null };
  let busy = false;
  onCleanup(() => { current = { token: null, backupId: null, target: null }; });

  const say = (nodes) => { clear(status).append(...nodes); status.focus(); };

  async function loadList() {
    clear(reviewBox);
    current = { token: null, backupId: null, target: null };
    const target = sel.value;
    const rows = await get(`${SETTINGS_API}/backups`, { target });
    clear(listBox);
    if (rows.length === 0) {
      listBox.append(notice('No backups for this target yet. One is made before every save.'));
      return;
    }
    listBox.append(table([
      { label: 'Time', render: (r) => fmtDate(r.at) },
      { label: 'Size', render: (r) => formatSize(r.size) },
      { label: 'Id', render: (r) => el('code', null, r.id) },
      { label: 'Action', render: (r) => (editable
        ? button('Compare with current', () => compare(target, r.id), { 'aria-label': `Compare backup ${r.id} with current` })
        : el('span', { class: 'muted' }, 'editing is off')) },
    ], rows));
  }

  async function compare(target, backupId) {
    if (busy) return;
    busy = true;
    try {
      const r = await postSettings('/rollback/preview', { target, backupId });
      current = { token: r.token, backupId, target };
      clear(status);
      const isEnv = Array.isArray(r.plan.diffs);
      const { node, heading } = isEnv ? renderDiff(r.plan, commands) : renderFileDiff(r.plan, commands);
      const { controls, getPhrase } = frictionControls(r.plan.friction, meta.reauthFresh, 'rollback');
      if (isEnv && r.plan.modeAfter === 'LIVE') {
        node.append(notice('Restoring this backup would switch the mode to LIVE. Real sends become possible after a restart.', 'warn'));
      }
      const unchanged = isEnv ? (r.plan.diffs || []).length === 0 : !!(r.plan.diff && r.plan.diff.unchanged);
      controls.append(button('Restore this backup', () => restore(getPhrase()), { class: 'primary', disabled: unchanged }));
      clear(reviewBox).append(node, controls);
      heading.focus();
    } catch (e) {
      say(failureNodes(e, () => { loadList().catch(() => {}); }));
    } finally {
      busy = false;
    }
  }

  async function restore(phrase) {
    if (busy || !current.token) return;
    busy = true;
    const body = { target: current.target, backupId: current.backupId, token: current.token };
    if (phrase !== undefined) body.phrase = phrase;
    try {
      const r = await postSettings('/rollback/apply', body);
      current = { token: null, backupId: null, target: null };
      clear(reviewBox);
      const restarts = Array.isArray(r.restart) ? r.restart : [];
      say([notice(`Restored. A backup of the replaced version was made: ${r.backupId}`, 'good'),
        restarts.length ? el('ul', null, restarts.map((x) => el('li', null, `${x.key}: restart scope ${x.scope}${commands[x.scope] ? `, ${commands[x.scope]}` : ''}`)))
          : el('p', { class: 'muted' }, 'No restart needed.')]);
    } catch (e) {
      current = { token: null, backupId: null, target: null };
      clear(reviewBox);
      say(failureNodes(e, () => { loadList().catch(() => {}); }));
    } finally {
      busy = false;
    }
    try {
      await loadList();
    } catch {
      status.append(notice('Restored, but the list could not reload. Reopen this tab.', 'warn'));
    }
  }

  clear(host).append(
    el('div', { class: 'env-tools' }, el('label', { for: 'backups-target' }, 'Target'), sel),
    status, listBox, reviewBox);
  try {
    const files = await get(`${SETTINGS_API}/files`);
    sel.append(el('option', { value: 'env' }, 'Environment (.env)'),
      files.filter((f) => f.edit && ID_RE.test(f.id)).map((f) => el('option', { value: targetKey(f.id) }, f.rel)));
    sel.addEventListener('change', () => { loadList().catch(() => say([notice('Could not load backups. Try again.', 'error')])); });
    await loadList();
  } catch {
    clear(host).append(notice('Could not load backups. Try again.', 'error'));
  }
}
