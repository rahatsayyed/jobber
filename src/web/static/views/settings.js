// src/web/static/views/settings.js
// Settings shell: tabs Environment, Files, Backups (placeholder panels, filled by later tasks) and the read-only
// notice when editing is off. Reads the settings meta; creates no write controls while editEnabled is not true.
import { getSettingsMeta } from '../api.js';
import { button, clear, el, notice } from '../dom.js';

export const READ_ONLY_TEXT = 'Read only. To enable editing set WEB_SETTINGS_EDIT=true in .env and restart the dashboard.';
export const TABS = [['environment', 'Environment'], ['files', 'Files'], ['backups', 'Backups']];

export async function render({ root }) {
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
  function show(id) {
    const entry = TABS.find(([n]) => n === id) || TABS[0];
    clear(tabs).append(...TABS.map(([n, label]) => button(label, () => show(n), {
      class: n === entry[0] ? 'tab active' : 'tab', 'aria-pressed': n === entry[0] ? 'true' : 'false',
    })));
    clear(panel).append(el('h3', null, entry[1]), el('p', { class: 'muted' }, `${entry[1]} settings load here.`));
  }
  root.append(tabs, panel);
  show(TABS[0][0]);
}
