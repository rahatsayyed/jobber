// src/web/static/views/settings-diff.js
// Renders the server's preview plan: field diffs (secret rows are words only), warnings, errors, restart badges and
// the friction. Pure DOM building with textContent; nothing here ever receives a secret value.
import { badge, el } from '../dom.js';

export function restartLine(item, commands) {
  const cmd = (commands && commands[item.scope]) || '';
  return cmd ? `${item.key}: restart scope ${item.scope}, ${cmd}` : `${item.key}: restart scope ${item.scope}`;
}

/** plan: {diffs, warnings, errors, restart, modeAfter, friction}. Returns {node, heading}. */
export function renderDiff(plan, commands) {
  const heading = el('h3', { id: 'env-diff-heading' }, 'Review changes');
  heading.tabIndex = -1;
  const diffs = Array.isArray(plan.diffs) ? plan.diffs : [];
  const node = el('section', { class: 'env-diff', 'aria-labelledby': 'env-diff-heading' }, heading);
  if (diffs.length === 0) node.append(el('p', { class: 'muted' }, 'No change: the file already has these values.'));
  else {
    node.append(el('ul', { class: 'diff-list' }, diffs.map((d) => el('li', { class: 'diff-row' },
      el('code', null, d.key),
      el('span', { class: 'diff-before' }, `before: ${d.secret ? d.before : d.before === '' ? '(blank)' : d.before}`),
      el('span', { class: 'diff-after' }, `after: ${d.secret ? d.after : d.after === '' ? '(blank)' : d.after}`),
      d.secret ? badge('secret, value hidden') : null))));
  }
  if (plan.modeAfter) node.append(el('p', null, `Mode after this change: ${plan.modeAfter}`));
  for (const w of plan.warnings || []) node.append(el('p', { class: 'notice warn' }, `Warning: ${w}`));
  for (const e of plan.errors || []) node.append(el('p', { class: 'notice error' }, `Problem: ${e}`));
  const restarts = Array.isArray(plan.restart) ? plan.restart : [];
  if (restarts.length > 0) {
    node.append(el('h4', null, 'Restart needed'),
      el('ul', null, restarts.map((r) => el('li', null, badge(`restart: ${r.scope}`, 'warn'), ' ', restartLine(r, commands)))));
  }
  return { node, heading };
}
