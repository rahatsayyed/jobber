// Class-name-independent card parser for LinkedIn search pages (jobs and hiring posts).
//
// The primary parser in snapshot.ts reads cards through CSS class names, which LinkedIn changes without notice
// (for 8 days it returned 0 cards). This fallback uses only signals that survive a redesign: the href shapes
// /jobs/view/<id> and /feed/update/urn:li:<kind>:<id> (or /posts/<slug>-<kind>-<id>), data-urn, and the repetition
// of those links. A card is the LARGEST ancestor of a link that still contains exactly one distinct id; its text
// lines give company, location and snippet (jobs) or author, headline and body (posts).
//
// ONE implementation, two hosts: SEMANTIC_CORE_SRC is plain ES5 source text. snapshot.ts embeds it in the
// in-page script (adapter over the real DOM) and `semanticCardsFromHtml` runs the very same text over the fixture
// HtmlNode tree, so a fixture test proves the code that runs in the browser. Everything it returns is untrusted
// page text, capped here and gated later by the parsers. Nothing is fetched or followed.
import type { RawJobCard, RawPostCard } from './types.js';
import { findAll, visibleText, type HtmlNode } from './htmlVisible.js';

/** Adapter the core needs from its host (DOM in the page, HtmlNode in tests). */
export interface SemanticHost {
  /** Visible anchors that have an href. */
  anchors: unknown[];
  /** Visible elements that carry a data-urn attribute. */
  urnEls: unknown[];
  parent(el: unknown): unknown | null;
  attr(el: unknown, name: string): string;
  tag(el: unknown): string;
  /** Visible text lines of an element (empty when hidden). */
  lines(el: unknown): string[];
  /** Visible buttons (button and role=button): needed only by the card-as-button job layout and the post menu boxes. */
  buttons?: unknown[];
  /** All [name, value] attribute pairs of an element. */
  attrPairs?(el: unknown): Array<[string, string]>;
  /** The element and its descendants, breadth first, at most `max`. */
  walk?(el: unknown, max: number): unknown[];
  /** Write one attribute (used to mark a card so code can click it). */
  setAttr?(el: unknown, name: string, value: string): void;
}

export interface SemanticResult {
  /** Cards of the card-as-button layout (no job link in the page); only when the host gave `buttons`. */
  buttonCards: RawJobCard[];
  jobCards: RawJobCard[];
  postCards: RawPostCard[];
  /** Distinct /jobs/view ids and distinct post ids linked from the page (link evidence, also when no card was built). */
  jobLinks: number;
  postLinks: number;
}

export const SEMANTIC_CORE_SRC = String.raw`
function semanticCards(A) {
  var JOB = /\/jobs\/view\/(?:[^\/?#]*?-)?(\d{6,25})(?:[\/?#]|$)/;
  var POST1 = /\/feed\/update\/urn:li:(activity|share|ugcPost):(\d{6,25})/;
  var POST2 = /\/posts\/[^\/?#]+-(activity|share|ugcPost)-(\d{6,25})(?:[\-\/?#]|$)/;
  var URN = /urn:li:(activity|share|ugcPost):(\d{6,25})/;
  var AUTHOR = /\/(in|company|school)\/[^\/?#]+/;
  var NOISE = /^(?:promoted|viewed|saved|easy apply|actively (?:recruiting|hiring)|be an early applicant|reposted.*|\d+\s*(?:applicants?|connections?|school alumni.*)|\d+\s*(?:s|m|h|d|w|mo|min|mins|hr|hrs)\b.*|\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?)\s+ago|dismiss|save|[·•.\-])$/i;
  function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  var anchors = A.anchors, urnEls = A.urnEls;
  var keyOf = [], i, j;
  var jobKeys = {}, postKeys = {}, byKey = {}, order = [];
  function note(key, kind, el) {
    if (!byKey[key]) { byKey[key] = { kind: kind, anchors: [], urnEl: null }; order.push(key); }
    if (kind === 'job') jobKeys[key] = 1; else postKeys[key] = 1;
    return byKey[key];
  }
  for (i = 0; i < anchors.length; i++) {
    var href = A.attr(anchors[i], 'href'), m;
    if ((m = JOB.exec(href))) { keyOf[i] = 'j' + m[1]; note(keyOf[i], 'job').anchors.push(i); }
    else if ((m = POST1.exec(href)) || (m = POST2.exec(href))) { keyOf[i] = 'p' + m[2]; note(keyOf[i], 'post').anchors.push(i); }
    else keyOf[i] = '';
  }
  for (i = 0; i < urnEls.length; i++) {
    var um = URN.exec(A.attr(urnEls[i], 'data-urn'));
    if (um) { var e1 = note('p' + um[2], 'post'); if (!e1.urnEl) e1.urnEl = urnEls[i]; }
  }
  // Which keys each ancestor contains (links and data-urn elements).
  var keysIn = [], els = [];
  function mark(el, key) {
    for (var x = el, n = 0; x && n < 40; x = A.parent(x), n++) {
      var at = els.indexOf(x);
      if (at < 0) { els.push(x); keysIn.push({}); at = els.length - 1; }
      keysIn[at][key] = 1;
    }
  }
  for (i = 0; i < anchors.length; i++) if (keyOf[i]) mark(anchors[i], keyOf[i]);
  for (j = 0; j < order.length; j++) if (byKey[order[j]].urnEl) mark(byKey[order[j]].urnEl, order[j]);
  function count(el) {
    var at = els.indexOf(el), c = 0;
    if (at < 0) return 0;
    for (var k in keysIn[at]) if (keysIn[at].hasOwnProperty(k)) c++;
    return c;
  }
  var STOP = { main: 1, body: 1, html: 1, ul: 1, ol: 1, section: 0 };
  function containerOf(key) {
    var ent = byKey[key];
    var node = ent.urnEl || (ent.anchors.length ? anchors[ent.anchors[0]] : null);
    if (!node) return null;
    if (ent.urnEl) return node;
    for (var step = 0; step < 14; step++) {
      var p = A.parent(node);
      if (!p || STOP[A.tag(p)] === 1 || count(p) > 1) break;
      if (A.lines(p).length > 90) break;
      node = p;
    }
    return node;
  }
  function anchorsWithin(container) {
    var out = [];
    for (var k = 0; k < anchors.length; k++) {
      for (var x = anchors[k], n = 0; x && n < 40; x = A.parent(x), n++) if (x === container) { out.push(k); break; }
    }
    return out;
  }
  var jobCards = [], postCards = [];
  for (j = 0; j < order.length; j++) {
    var key = order[j], ent2 = byKey[key], box = containerOf(key);
    if (!box) continue;
    if (ent2.kind === 'job' && jobCards.length < 50) {
      var title = '';
      for (i = 0; i < ent2.anchors.length && !title; i++) {
        var al = A.attr(anchors[ent2.anchors[i]], 'aria-label');
        if (al && al.length >= 3) title = al;
      }
      for (i = 0; i < ent2.anchors.length && !title; i++) {
        var tl = A.lines(anchors[ent2.anchors[i]]);
        if (tl.length && tl[0].length >= 3) title = tl[0];
      }
      if (!title) continue;
      var tn = norm(title), rest = [], ls = A.lines(box), seen = {};
      for (i = 0; i < ls.length; i++) {
        var ln = norm(ls[i]);
        if (!ln || NOISE.test(ln) || seen[ln]) continue;
        if (ln === tn || ln.indexOf(tn) === 0 || (tn.indexOf(ln) === 0 && ln.length > 8)) continue;
        seen[ln] = 1;
        rest.push(cap(ls[i], 300));
      }
      var easy = false;
      for (i = 0; i < ls.length; i++) if (/^easy apply$/i.test(ls[i])) easy = true;
      var wi = anchorsWithin(box);
      for (i = 0; i < wi.length; i++) if (/easy apply/i.test(A.attr(anchors[wi[i]], 'aria-label'))) easy = true;
      jobCards.push({ title: cap(title, 200), company: cap(rest[0] || '', 200),
        href: '/jobs/view/' + key.slice(1) + '/', snippet: cap(rest.slice(1).join(' · '), 2000), easyApply: easy });
    }
    if (ent2.kind === 'post' && postCards.length < 50) {
      var inside = anchorsWithin(box), au = -1, perma = '';
      for (i = 0; i < inside.length; i++) {
        var h2 = A.attr(anchors[inside[i]], 'href');
        if (au < 0 && AUTHOR.test(h2)) au = inside[i];
        if (!perma && keyOf[inside[i]] === key) perma = h2;
      }
      if (au < 0) continue;
      var pl = A.lines(box).slice(0, 60), alines = A.lines(anchors[au]), anm = alines[0] || A.attr(anchors[au], 'aria-label') || '';
      for (i = 0; i < pl.length; i++) pl[i] = cap(pl[i], 400);
      var urnv = ent2.urnEl ? A.attr(ent2.urnEl, 'data-urn') : '';
      postCards.push({ text: cap(pl.join(' '), 3000), authorName: cap(anm, 200), profileHref: cap(A.attr(anchors[au], 'href'), 500),
        permalinkHref: cap(perma, 500), urn: cap(urnv, 120), lines: pl });
    }
  }
  var nj = 0, np = 0, k2;
  for (k2 in jobKeys) if (jobKeys.hasOwnProperty(k2)) nj++;
  for (k2 in postKeys) if (postKeys.hasOwnProperty(k2)) np++;
  return { jobCards: jobCards, postCards: postCards, jobLinks: nj, postLinks: np, buttonCards: A.buttons ? jobberButtonJobCards(A) : [] };
}
// ---- card-as-button job layout (no job link anywhere): the card is ONE button whose accessible name holds
// "<Company> <Location> (<Remote|Hybrid|On-site>)? Dismiss <Title> job <salary> · <meta>". The job id comes only from DOM attributes
// (jobberIdFromPairs); the title is taken from the exact label of the sibling "Dismiss <Title> job" button when there is one.
function jobberIdFromPairs(pairs) {
  for (var i = 0; i < pairs.length; i++) {
    var n = String(pairs[i][0]).toLowerCase(), v = String(pairs[i][1]), m;
    if ((m = /\/jobs\/view\/(?:[^\/?#]*?-)?(\d{6,25})/.exec(v))) return { id: m[1], from: 'jobs_view_url' };
    if ((m = /currentJobId=(\d{6,25})/.exec(v))) return { id: m[1], from: 'current_job_id' };
    if ((m = /urn:li:(?:fsd_|fs_normalized_)?jobPosting:(\d{6,25})/.exec(v))) return { id: m[1], from: 'job_posting_urn' };
    if (/^data-.*job.*id$/.test(n) && /^\d{6,25}$/.test(v)) return { id: v, from: 'data_job_id' };
  }
  return null;
}
function jobberButtonJobCards(A) {
  var btns = A.buttons || [], names = [], dismiss = [], i, m;
  function nm(b) {
    var c = [A.attr(b, 'aria-label'), A.lines(b).join(' ')], k, first = '';
    for (k = 0; k < c.length; k++) {
      var s = String(c[k] || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (s && !first) first = s;
      if (/ Dismiss .+ job(?: |$)/.test(s)) return s;
    }
    return first;
  }
  for (i = 0; i < btns.length; i++) {
    names[i] = nm(btns[i]);
    if ((m = /^Dismiss (.+) job$/.exec(names[i]))) dismiss.push(m[1]);
  }
  var cards = [];
  for (i = 0; i < btns.length; i++) {
    if (/^Dismiss /.test(names[i]) || !/ Dismiss .+ job(?: |$)/.test(names[i])) continue;
    cards.push(i);
    if (cards.length >= 50) break;
  }
  // How many card buttons each ancestor (6 levels) holds: an ancestor that holds exactly one card may lend its own attributes.
  var anc = [], cnt = [], c, x, n, at;
  for (c = 0; c < cards.length; c++) {
    for (x = btns[cards[c]], n = 0; x && n < 6; x = A.parent(x), n++) {
      at = anc.indexOf(x);
      if (at < 0) { anc.push(x); cnt.push(0); at = anc.length - 1; }
      cnt[at]++;
    }
  }
  var out = [];
  for (c = 0; c < cards.length; c++) {
    var el = btns[cards[c]], name = names[cards[c]], found = null, list, k;
    if (A.walk && A.attrPairs) {
      list = A.walk(el, 120);
      for (k = 0; k < list.length && !found; k++) found = jobberIdFromPairs(A.attrPairs(list[k]));
      for (x = A.parent(el), n = 0; x && n < 5 && !found; x = A.parent(x), n++) {
        at = anc.indexOf(x);
        if (at >= 0 && cnt[at] > 1) break;
        found = jobberIdFromPairs(A.attrPairs(x));
      }
    }
    if (A.setAttr) A.setAttr(el, 'data-jobber-card', String(out.length));
    var best = '';
    for (k = 0; k < dismiss.length; k++) if (name.indexOf(' Dismiss ' + dismiss[k] + ' job') >= 0 && dismiss[k].length > best.length) best = dismiss[k];
    var ls = A.lines(el).slice(0, 12);
    for (k = 0; k < ls.length; k++) ls[k] = ls[k].slice(0, 200);
    out.push({ title: best.slice(0, 200), company: '', href: '', snippet: '', easyApply: false, cardName: name,
      cardLines: ls, cardIdx: out.length, idHint: found ? found.id : '', idFrom: found ? found.from : '' });
  }
  return out;
}
// ---- hiring post card read from one box (a list item, or the box found around the post's "Open control menu" button).
// No permalink is needed: identity is decided in code from what is here. Works for a person author (/in/) and a company author (/company/).
function jobberWithin(A, el, box) {
  for (var x = el, n = 0; x && n < 40; x = A.parent(x), n++) if (x === box) return true;
  return false;
}
function jobberPostBox(A, box) {
  var POST1 = /\/feed\/update\/urn:li:(activity|share|ugcPost):(\d{6,25})/;
  var POST2 = /\/posts\/[^\/?#]+-(activity|share|ugcPost)-(\d{6,25})(?:[\-\/?#]|$)/;
  var i, a, h, lab, au = null, cmp = null, perma = '', mail = [], outs = {}, nOut = 0, badge = false;
  for (i = 0; i < A.anchors.length; i++) {
    a = A.anchors[i];
    if (!jobberWithin(A, a, box)) continue;
    h = A.attr(a, 'href'); lab = A.attr(a, 'aria-label');
    if (/^mailto:/i.test(h)) {
      var addr = h.replace(/^mailto:/i, '').split('?')[0];
      try { addr = decodeURIComponent(addr); } catch (e1) { }
      addr = addr.trim().slice(0, 120);
      if (addr.indexOf('@') > 0 && mail.length < 12 && mail.indexOf(addr) < 0) mail.push(addr);
      continue;
    }
    if (/,\s*hiring\b/i.test(lab)) badge = true;
    if (!au && /\/in\/[^\/?#]+/.test(h)) au = a;
    if (!cmp && /\/company\/[^\/?#]+/.test(h)) cmp = a;
    if (!perma && (POST1.test(h) || POST2.test(h))) perma = h;
    if (/^https?:\/\//i.test(h) && !/^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com(?:[\/?#:]|$)/i.test(h) && !outs[h]) { outs[h] = 1; nOut++; }
  }
  if (!au && !cmp) return null;
  var anm = '';
  if (au) {
    for (i = 0; i < A.anchors.length && !anm; i++) {
      a = A.anchors[i];
      if (!jobberWithin(A, a, box) || !/\/in\/[^\/?#]+/.test(A.attr(a, 'href'))) continue;
      var al = A.lines(a)[0] || '';
      if (al && !/^(?:follow|view)\b/i.test(al)) anm = al;
    }
    if (!anm) anm = A.attr(au, 'aria-label').replace(/^view\s+/i, '').replace(/[’']s profile$/i, '');
  } else {
    anm = A.lines(cmp)[0] || A.attr(cmp, 'aria-label').replace(/^view company:\s*/i, '');
  }
  var cname = '', chref = '';
  if (cmp) {
    var cl = A.attr(cmp, 'aria-label');
    cname = /^view company:/i.test(cl) ? cl.replace(/^view company:\s*/i, '') : (A.lines(cmp)[0] || '');
    chref = A.attr(cmp, 'href').split(/[?#]/)[0];
  }
  var pl = A.lines(box).slice(0, 60);
  for (i = 0; i < pl.length; i++) pl[i] = pl[i].slice(0, 400);
  var urn = '';
  for (var y = box, n2 = 0; y && !urn && n2 < 6; y = A.parent(y), n2++) urn = A.attr(y, 'data-urn') || A.attr(y, 'data-id') || '';
  return { text: pl.join(' ').slice(0, 3000), authorName: anm.slice(0, 200), profileHref: A.attr(au || cmp, 'href').slice(0, 500),
    permalinkHref: perma.slice(0, 500), urn: urn.slice(0, 120), lines: pl, companyName: cname.slice(0, 200), companyHref: chref.slice(0, 300),
    mailtos: mail, outLinks: Math.min(nOut, 99), hiringBadge: badge };
}
// Boxes around each "Open control menu for post by <author>" button: the largest ancestor that holds exactly one such button.
function jobberPostMenuBoxes(A) {
  var menus = [], i, boxes = [];
  for (i = 0; i < (A.buttons || []).length; i++) if (/^open control menu for post by /i.test(A.attr(A.buttons[i], 'aria-label'))) menus.push(A.buttons[i]);
  function holds(el) { var c = 0; for (var k = 0; k < menus.length; k++) if (jobberWithin(A, menus[k], el)) c++; return c; }
  for (i = 0; i < menus.length && boxes.length < 50; i++) {
    var node = menus[i];
    for (var step = 0; step < 14; step++) {
      var p = A.parent(node), t = p ? A.tag(p) : '';
      if (!p || t === 'main' || t === 'body' || t === 'html' || holds(p) > 1) break;
      node = p;
    }
    if (boxes.indexOf(node) < 0) boxes.push(node);
  }
  return boxes;
}
`;

interface Core {
  semanticCards: (a: SemanticHost) => SemanticResult;
  jobberPostBox: (a: SemanticHost, box: unknown) => RawPostCard | null;
  jobberPostMenuBoxes: (a: SemanticHost) => unknown[];
}
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const core = new Function(`${SEMANTIC_CORE_SRC}; return { semanticCards: semanticCards, jobberPostBox: jobberPostBox, jobberPostMenuBoxes: jobberPostMenuBoxes };`)() as Core;

/** Run the shared core over any host (used by the fixture side; the page runs the same text). */
export const runSemanticCore = (host: SemanticHost): SemanticResult => core.semanticCards(host);

/** Fixture side host over a parsed HTML tree. Hidden nodes are skipped like in the page. */
export function htmlHost(root: HtmlNode): SemanticHost {
  const parents = new Map<HtmlNode, HtmlNode>();
  const walk = (n: HtmlNode): void => { for (const c of n.children) { parents.set(c, n); walk(c); } };
  walk(root);
  const live = (n: HtmlNode) => n.tag !== '#text' && !n.hidden;
  return {
    anchors: findAll(root, (n) => live(n) && n.tag === 'a' && 'href' in n.attrs),
    urnEls: findAll(root, (n) => live(n) && 'data-urn' in n.attrs),
    buttons: findAll(root, (n) => live(n) && (n.tag === 'button' || n.attrs['role'] === 'button')),
    parent: (el) => parents.get(el as HtmlNode) ?? null,
    attr: (el, name) => (el as HtmlNode).attrs[name] ?? '',
    tag: (el) => (el as HtmlNode).tag,
    lines: (el) => ((el as HtmlNode).hidden ? [] : visibleText(el as HtmlNode).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)),
    attrPairs: (el) => Object.entries((el as HtmlNode).attrs),
    walk: (el, max) => {
      const out: HtmlNode[] = [];
      const q: HtmlNode[] = [el as HtmlNode];
      while (q.length && out.length < max) { const x = q.shift()!; out.push(x); for (const c of x.children) if (c.tag !== '#text') q.push(c); }
      return out;
    },
    setAttr: (el, name, value) => { (el as HtmlNode).attrs[name] = value; },
  };
}

/** Fixture side: the same core over a parsed HTML tree. */
export function semanticCardsFromHtml(root: HtmlNode): SemanticResult {
  return core.semanticCards(htmlHost(root));
}

/** Fixture side: post cards from the given boxes (list items), or from the boxes around each post control-menu button when none is given. */
export function postCardsFromBoxes(host: SemanticHost, boxes: unknown[]): RawPostCard[] {
  const out: RawPostCard[] = [];
  for (const b of boxes) {
    if (out.length >= 50) break;
    const c = core.jobberPostBox(host, b);
    if (c) out.push(c);
  }
  return out;
}
export const postMenuBoxes = (host: SemanticHost): unknown[] => core.jobberPostMenuBoxes(host);
