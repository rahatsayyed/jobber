// browserctl layout adapter: turns an engine tree into the RawSnapshot shape the layout observer
// already understands, so layout memory keeps learning from linkedin_snapshot. Advisory telemetry
// only: it carries no page text beyond what the observer's own fingerprinting reads (counts and
// landmark ids come out of it), and a wrong guess here never blocks or refuses anything.
import { classifyUrl } from '../linkedin/urls.js';
import type { RawSnapshot } from '../linkedin/types.js';
import { normName } from './guard.js';
import type { RawTree } from './snapshot.js';

const DEGREE_RE = /^[\s·.]*(1st|2nd|3rd)\b/i;
const ACTION_NAMES = new Set(['connect', 'message', 'follow', 'more', 'pending', 'send profile in a message', 'view in sales navigator']);
const BODY_CAP = 60_000;
const LIST_CAP = 50;

export function treeToRawSnapshot(tree: RawTree): RawSnapshot {
  const kind = classifyUrl(tree.url);
  const outside = tree.nodes.filter((x) => x.dialog === undefined && x.role !== 'dialog');
  const bodyText = tree.nodes.map((x) => (x.role === 'text' ? x.text : x.name)).filter(Boolean).join('\n').slice(0, BODY_CAP);
  const dialogText = tree.nodes
    .filter((x) => x.dialog !== undefined || x.role === 'dialog')
    .map((x) => (x.role === 'text' ? x.text : x.name))
    .filter(Boolean)
    .join('\n') || null;

  let profile: RawSnapshot['profile'] = null;
  if (kind === 'profile') {
    const actionable = outside.filter((x) => x.role === 'button' || x.role === 'link' || x.role === 'menuitem');
    const names = actionable.map((x) => normName(x.name));
    const actions: string[] = [];
    for (const x of actionable) {
      const nm = normName(x.name);
      if (/^invite .+ to connect$/.test(nm) || nm === 'connect') actions.push('Connect');
      else if (ACTION_NAMES.has(nm)) actions.push(x.name);
    }
    const headIdx = outside.findIndex((x) => x.role === 'heading' && x.name);
    const head = headIdx >= 0 ? outside[headIdx] : null;
    const after = headIdx >= 0 ? outside.slice(headIdx + 1) : [];
    const degreeNode = after.find((x) => x.role === 'text' && DEGREE_RE.test(x.text));
    const degreeMatch = degreeNode ? DEGREE_RE.exec(degreeNode.text) : null;
    const headline = after.find((x) => x.role === 'text' && x.text && !DEGREE_RE.test(x.text))?.text ?? '';
    profile = {
      name: head?.name ?? '',
      headline,
      degree: degreeMatch ? (degreeMatch[1].toLowerCase() as '1st' | '2nd' | '3rd') : null,
      location: '',
      about: null,
      actions,
      pending: names.some((n) => /^pending\b|^withdraw\b/.test(n)),
      hasBell: names.some((n) => /^manage notifications/.test(n)),
      hasMessageButton: names.includes('message'),
    };
  }

  const links = outside.filter((x) => x.role === 'link' && x.href);
  const results = kind === 'search'
    ? links.filter((x) => /\/in\//.test(x.href ?? '')).slice(0, 12).map((x) => ({ name: x.name, headline: '', href: x.href ?? '' }))
    : [];
  const jobCards = kind === 'jobs'
    ? links.filter((x) => /\/jobs\/view\//.test(x.href ?? '')).slice(0, LIST_CAP)
      .map((x) => ({ title: x.name, company: '', href: x.href ?? '', snippet: '', easyApply: false }))
    : undefined;
  const invitations = kind === 'invitations'
    ? outside.filter((x) => x.role === 'button' && /^accept\b/.test(normName(x.name))).slice(0, 20)
      .map((x, i) => ({ index: i, name: '', headline: '', href: '' }))
    : [];

  return {
    url: tree.url,
    title: tree.title,
    profile,
    results,
    invitations,
    messages: [],
    messageHeaderName: null,
    notices: [],
    dialogText,
    hasPasswordInput: tree.nodes.some((x) => x.secret === true),
    bodyText,
    ...(jobCards ? { jobCards } : {}),
  };
}
