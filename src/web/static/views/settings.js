// src/web/static/views/settings.js
// Settings shell: tabs Environment, Files, Backups and the read-only notice when editing is off. Reads the settings
// meta; creates no write controls while editEnabled is not true. The Environment tab is settings-env.js; Files and
// Backups are placeholders filled by a later task.
import { getSettingsMeta } from '../api.js';
import { button, clear, el, notice } from '../dom.js';
import { renderEnv } from './settings-env.js';

export const READ_ONLY_TEXT = 'Read only. To enable editing set WEB_SETTINGS_EDIT=true in .env and restart the dashboard.';
export const TABS = [['environment', 'Environment'], ['files', 'Files'], ['backups', 'Backups']];

export async function render({ root, onCleanup: addCleanup }) {
  let meta = null;
  try {
    meta = await getSettingsMeta();
  } catch {
    meta = null;
  }
  root.append(el('h2', null, 'Settings'));
  if (!meta) {
    root.append(notice('Settings are not available.', 'warn'));
    return;
  }
  const editable = meta.editEnabled === true;
  if (!editable) root.append(notice(READ_ONLY_TEXT, 'warn'));

  const panel = el('section', { class: 'panel', 'aria-live': 'polite' });
  const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Settings sections' });
  let tabCleanups = [];
  const runTabCleanups = () => { tabCleanups.forEach((f) => f()); tabCleanups = []; };
  if (typeof addCleanup === 'function') addCleanup(runTabCleanups);

  function show(id) {
    runTabCleanups();
    const entry = TABS.find(([n]) => n === id) || TABS[0];
    clear(tabs).append(...TABS.map(([n, label]) => button(label, () => show(n), {
      class: n === entry[0] ? 'tab active' : 'tab', 'aria-pressed': n === entry[0] ? 'true' : 'false',
    })));
    clear(panel).append(el('h3', null, entry[1]));
    if (entry[0] === 'environment' && editable) {
      const host = el('div');
      panel.append(host);
      renderEnv({ host, meta, onCleanup: (f) => tabCleanups.push(f), gotoBackups: () => show('backups') });
      return;
    }
    panel.append(el('p', { class: 'muted' }, `${entry[1]} settings load here.`));
  }
  root.append(tabs, panel);
  show(TABS[0][0]);
}
