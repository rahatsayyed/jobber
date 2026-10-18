// src/web/static/views/settings-diff.js
// Renders the server's preview plan: field diffs (secret rows are words only), warnings, errors, restart badges and
// the friction. Pure DOM building with textContent; nothing here ever receives a secret value.
import { badge, button, el, notice } from '../dom.js';

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

// ---- file diffs, shared friction and failure notices (Task 12) ---------------------------------------------------

/** Keep changed lines plus `n` lines of context; skipped runs become one {op: 'gap', skipped} marker. Pure. */
export function contextLines(lines, n) {
  const src = Array.isArray(lines) ? lines : [];
  const keep = new Array(src.length).fill(false);
  src.forEach((l, i) => {
    if (l.op === 'eq') return;
    for (let j = Math.max(0, i - n); j <= Math.min(src.length - 1, i + n); j++) keep[j] = true;
  });
  const out = [];
  let skipped = 0;
  src.forEach((l, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ op: 'gap', skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped > 0 && out.length > 0) out.push({ op: 'gap', skipped });
  return out;
}

const MARK = { add: '+ added', del: '- removed', eq: 'same' };

/** plan: the file preview view {diff, warnings, errors, restart, friction, tier, weakens, changedPaths}. */
export function renderFileDiff(plan, commands) {
  const heading = el('h3', { id: 'file-diff-heading' }, 'Review changes');
  heading.tabIndex = -1;
  const node = el('section', { class: 'env-diff', 'aria-labelledby': 'file-diff-heading' }, heading);
  const d = plan.diff || {};
  if (d.truncated) node.append(notice('The file is too long to show a line diff. The change still applies as a whole.', 'warn'));
  else if (d.unchanged) node.append(el('p', { class: 'muted' }, 'No change: the file already has this text.'));
  else {
    node.append(el('p', null, `${d.added || 0} added, ${d.removed || 0} removed, ${d.formattingOnly || 0} formatting-only lines`));
    node.append(el('ul', { class: 'diff-list file-diff' }, contextLines(d.lines, 2).slice(0, 600).map((l) => (l.op === 'gap'
      ? el('li', { class: 'diff-gap muted' }, `... ${l.skipped} unchanged lines ...`)
      : el('li', { class: `diff-line diff-${l.op}${l.formatting ? ' diff-fmt' : ''}` },
        el('span', { class: 'ln' }, String((l.op === 'add' ? l.newLine : l.oldLine) ?? '')),
        el('code', null, `${MARK[l.op] || ''}${l.formatting ? ' (formatting only)' : ''}: ${l.text}`))))));
  }
  if (plan.weakens) node.append(el('p', { class: 'notice warn' }, `This change widens what the agent may do: ${plan.weakens}`));
  for (const w of plan.warnings || []) node.append(el('p', { class: 'notice warn' }, `Warning: ${w}`));
  for (const e of plan.errors || []) node.append(el('p', { class: 'notice error' }, `Problem: ${e}`));
  const restarts = Array.isArray(plan.restart) ? plan.restart : [];
  if (restarts.length > 0) {
    node.append(el('ul', null, restarts.map((r) => el('li', null, badge(`effect: ${r.scope}`, 'warn'), ' ',
      r.scope === 'next_run' || r.scope === 'next_fetch' ? 'read on next run' : restartLine(r, commands)))));
  } else node.append(el('p', { class: 'muted' }, 'No restart needed: read on every use.'));
  return { node, heading };
}

export function reauthButton(url) {
  const ok = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && url.length < 100;
  const target = ok ? url : '/#/login?reauth=1';
  return button('Needs a fresh sign-in', () => location.assign(target), { class: 'primary' });
}

/** Phrase input and reauth button for a plan's friction. Returns {controls, getPhrase}. */
export function frictionControls(fr, reauthFresh, idPrefix) {
  const controls = el('div', { class: 'row' });
  let input = null;
  if (fr && fr.reauth && !reauthFresh) controls.append(reauthButton());
  if (fr && typeof fr.phrase === 'string' && fr.phrase) {
    input = el('input', { type: 'text', id: `${idPrefix}-phrase`, 'aria-label': `Type ${fr.phrase} to confirm` });
    input.autocomplete = 'off';
    controls.append(el('label', { for: `${idPrefix}-phrase` }, `Type ${fr.phrase} to confirm`), input);
  }
  return { controls, getPhrase: () => (input ? input.value : undefined) };
}

/** Plain-words notice nodes for a failed settings call. */
export function failureNodes(e, onReload) {
  if (e.status === 401 && e.code === 'reauth_required') {
    return [notice('This change needs a fresh sign-in first.', 'warn'), reauthButton(e.data && e.data.url)];
  }
  if (e.status === 409 && e.code === 'stale_etag') {
    return [notice('The file changed on disk since you opened this page.', 'warn'), button('Reload', onReload, { class: 'primary' })];
  }
  if (e.status === 422) {
    const errs = (e.data && e.data.errors) || [];
    return [notice('The text is not valid. Fix the problems and review again.', 'error'),
      el('ul', null, errs.map((m) => el('li', null, String(m))))];
  }
  if (e.status === 403 && e.code === 'phrase_mismatch') return [notice('The confirmation text did not match. Nothing was changed.', 'error')];
  if (e.status === 403 && e.code === 'not_editable') return [notice('This file is view only.', 'error')];
  if (e.status === 403 && e.code === 'settings_disabled') return [notice('Editing is turned off for this dashboard.', 'error')];
  if (e.status === 403 && e.code === 'remote_exposure') return [notice('This change is refused while the dashboard is exposed remotely.', 'error')];
  if (e.status === 403) return [notice('The change was refused. Review it again to get a new confirmation.', 'error')];
  if (e.status === 413) return [notice('The file is too large for this editor.', 'error')];
  if (e.status === 429) return [notice(`Too many attempts. Try again in ${e.retryAfter || 'a few'} seconds.`, 'error')];
  return [notice('Something went wrong. Nothing was changed.', 'error')];
}
