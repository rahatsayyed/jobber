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
}

export interface SemanticResult {
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
  return { jobCards: jobCards, postCards: postCards, jobLinks: nj, postLinks: np };
}
`;

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const core = new Function(`${SEMANTIC_CORE_SRC}; return semanticCards;`)() as (a: SemanticHost) => SemanticResult;

/** Run the shared core over any host (used by the fixture side; the page runs the same text). */
export const runSemanticCore = (host: SemanticHost): SemanticResult => core(host);

/** Fixture side: the same core over a parsed HTML tree. Hidden nodes are skipped like in the page. */
export function semanticCardsFromHtml(root: HtmlNode): SemanticResult {
  const parents = new Map<HtmlNode, HtmlNode>();
  const walk = (n: HtmlNode): void => { for (const c of n.children) { parents.set(c, n); walk(c); } };
  walk(root);
  const live = (n: HtmlNode) => n.tag !== '#text' && !n.hidden;
  const host: SemanticHost = {
    anchors: findAll(root, (n) => live(n) && n.tag === 'a' && 'href' in n.attrs),
    urnEls: findAll(root, (n) => live(n) && 'data-urn' in n.attrs),
    parent: (el) => parents.get(el as HtmlNode) ?? null,
    attr: (el, name) => (el as HtmlNode).attrs[name] ?? '',
    tag: (el) => (el as HtmlNode).tag,
    lines: (el) => ((el as HtmlNode).hidden ? [] : visibleText(el as HtmlNode).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)),
  };
  return core(host);
}
