// browserctl layout adapter: turns an engine tree into the RawSnapshot shape the layout observer
// already understands, so layout memory keeps learning from linkedin_snapshot. Advisory telemetry
// only: it carries no page text beyond what the observer's own fingerprinting reads (counts and
// landmark ids come out of it), and a wrong guess here never blocks or refuses anything.
import type { NaukriRawSnapshot, WellfoundRawSnapshot } from '../layout/fingerprint.js';
import { classifyUrl } from '../linkedin/urls.js';
import type { RawSnapshot } from '../linkedin/types.js';
import { normName } from './guard.js';
import type { RawTree } from './snapshot.js';

const DEGREE_RE = /^[\s·.]*(1st|2nd|3rd)\b/i;
const ACTION_NAMES = new Set(['connect', 'message', 'follow', 'more', 'pending', 'send profile in a message', 'view in sales navigator']);
const SECTION_HEADINGS = new Set(['about', 'activity', 'featured', 'experience', 'education', 'skills', 'highlights', 'interests', 'licenses & certifications', 'recommendations']);
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
      else if (/^follow .+$/.test(nm)) actions.push('Follow');
      else if (ACTION_NAMES.has(nm)) actions.push(x.name);
    }
    // The profile name is the heading that is not a section heading; prefer the one named by a
    // "Follow <name>" or "Invite <name> to connect" control, which is stable on real pages.
    const headings = outside.map((x, i) => ({ x, i })).filter((h) => h.x.role === 'heading' && h.x.name && !SECTION_HEADINGS.has(normName(h.x.name)));
    const named = headings.find((h) => names.some((n) => n === `follow ${normName(h.x.name)}` || n === `invite ${normName(h.x.name)} to connect`));
    const pick = named ?? headings[0];
    const headIdx = pick ? pick.i : -1;
    const head = pick ? pick.x : null;
    const after = headIdx >= 0 ? outside.slice(headIdx + 1) : [];
    const degreeNode = after.find((x) => x.role === 'text' && DEGREE_RE.test(x.text));
    const degreeMatch = degreeNode ? DEGREE_RE.exec(degreeNode.text) : null;
    const headline = after.find((x) => x.role === 'text' && x.text.replace(/[\s·.]/g, '').length > 2 && !DEGREE_RE.test(x.text))?.text ?? '';
    const aboutIdx = outside.findIndex((x) => x.role === 'heading' && normName(x.name) === 'about');
    const about = aboutIdx >= 0 ? outside.slice(aboutIdx + 1).find((x) => x.role === 'text' && x.text.trim())?.text ?? null : null;
    profile = {
      name: head?.name ?? '',
      headline,
      degree: degreeMatch ? (degreeMatch[1].toLowerCase() as '1st' | '2nd' | '3rd') : null,
      location: '',
      about,
      actions,
      pending: names.some((n) => /^pending\b|^withdraw\b/.test(n)),
      hasBell: names.some((n) => /^manage notifications/.test(n)),
      hasMessageButton: names.includes('message'),
    };
  }

  const links = outside.filter((x) => x.role === 'link' && x.href);
  // Search cards: profile links, or (when hrefs are not exposed) the per-card "Invite <name> to connect"
  // link and "Follow <name>" button every real card carries.
  const cardControls = outside.filter((x) => (x.role === 'link' || x.role === 'button') && /^(invite .+ to connect|follow .+)$/.test(normName(x.name)));
  const results = kind === 'search'
    ? (links.filter((x) => /\/in\//.test(x.href ?? '')).length > 0
      ? links.filter((x) => /\/in\//.test(x.href ?? '')).slice(0, 12).map((x) => ({ name: x.name, headline: '', href: x.href ?? '' }))
      : cardControls.slice(0, 12).map((x) => ({ name: x.name, headline: '', href: x.href ?? '' })))
    : [];
  const extras: NonNullable<RawSnapshot['extras']> = {};
  if (kind === 'search') extras.filters = outside.some((x) => x.role === 'radio' && /^filter by /.test(normName(x.name)));
  if (kind === 'feed') {
    extras.composer = outside.some((x) => x.role === 'button' && normName(x.name) === 'start a post');
    extras.posts = outside.filter((x) => x.role === 'button' && /^(open control menu for post by|hide post by) /.test(normName(x.name))).length;
  }
  if (kind === 'messaging') {
    extras.inboxSearch = outside.some((x) => x.role === 'searchbox' && normName(x.name) === 'search messages');
    extras.conversations = outside.filter((x) => x.role === 'heading' && x.name && normName(x.name) !== 'messaging').length;
  }
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
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
}

// ---- Naukri ----
const NAUKRI_BUTTON_RE = /^(apply|applied|save|saved|login|register|apply on company site)\b/i;

/**
 * Engine tree to the Naukri snapshot shape the layout observer already understands (telemetry only; a
 * wrong guess never blocks anything). Bot and user chat messages cannot be told apart in a tree, so the
 * message list stays empty and only the landmarks that exist in the tree are reported.
 */
export function treeToNaukriSnapshot(tree: RawTree): NaukriRawSnapshot {
  const buttons: string[] = [];
  for (const x of tree.nodes) {
    if (x.composer || (x.role !== 'button' && x.role !== 'link')) continue;
    const nm = x.name.replace(/\s+/g, ' ').trim();
    if (nm && nm.length <= 40 && NAUKRI_BUTTON_RE.test(nm) && !buttons.includes(nm)) buttons.push(nm);
  }
  const box = tree.nodes.find((x) => x.role === 'textbox' && x.composer && !x.secret);
  const send = tree.nodes.find((x) => x.role === 'button' && x.composer && /^send\b/i.test(x.name));
  const options = tree.nodes
    .filter((x) => (x.role === 'radio' || x.role === 'option' || x.role === 'checkbox') && x.name && x.name.length <= 80)
    .map((x) => x.name)
    .slice(0, 10);
  return {
    title: tree.title,
    url: tree.url,
    buttons,
    chatbot: {
      open: !!box || !!send,
      messages: [],
      placeholder: box ? box.name : null,
      sendLabel: send ? send.name : null,
      options,
    },
    notices: [],
    hasPasswordInput: tree.nodes.some((x) => x.secret === true),
  };
}

// ---- Wellfound ----
const WELLFOUND_BUTTON_RE = /^(apply|apply now|applied|save|saved|login|log in|sign up|apply on .+|apply externally)\b/i;

/**
 * Engine tree to the Wellfound snapshot shape the layout observer understands (telemetry only; a wrong
 * guess never blocks anything). Only booleans and short control names come out; no page text.
 */
export function treeToWellfoundSnapshot(tree: RawTree): WellfoundRawSnapshot {
  const buttons: string[] = [];
  for (const x of tree.nodes) {
    if (x.composer || (x.role !== 'button' && x.role !== 'link')) continue;
    const nm = x.name.replace(/\s+/g, ' ').trim();
    if (nm && nm.length <= 40 && WELLFOUND_BUTTON_RE.test(nm) && !buttons.includes(nm)) buttons.push(nm);
  }
  const box = tree.nodes.find((x) => x.role === 'textbox' && x.composer && !x.secret);
  const send = tree.nodes.find((x) => x.role === 'button' && x.composer && /^(send|send message)$/i.test(x.name.trim()));
  const dialogOpen = tree.nodes.some((x) => x.dialog !== undefined || x.role === 'dialog');
  const submit = tree.nodes.some((x) => x.role === 'button' && x.dialog !== undefined && /^(submit application|send application|submit)\b/i.test(x.name.trim()));
  return {
    title: tree.title,
    url: tree.url,
    buttons,
    form: { open: dialogOpen, hasNote: dialogOpen && !!box, hasSubmit: submit },
    composer: { present: !!box && !dialogOpen, sendLabel: send ? send.name : null },
    notices: [],
    hasPasswordInput: tree.nodes.some((x) => x.secret === true),
  };
}
