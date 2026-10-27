// browserctl snapshot: a flat, DOM-ordered node list with ordinals stamped on the page as data-bc.
// Two builders of the same RawTree: bcScript('snapshot') runs inside the page (real computed styles),
// buildTreeFromHtml builds it from fixtures through htmlVisible.ts. Keep the role, name, submit,
// footer and composer rules identical on both sides.
// The visibility rules are NOT retyped: VIS_SRC is cut out of the LinkedIn snapshot script, so both
// snapshots hide exactly the same things (a test pins the cut).
// Password-like inputs: the value is never read (the node carries secret:true and no value).
import { SNAPSHOT_SRC } from '../linkedin/snapshot.js';
import { parseHtml, findAll, visibleText, type HtmlNode } from '../linkedin/htmlVisible.js';
import { connectionStateOf } from './topCard.js';

export type BcRole =
  | 'button' | 'link' | 'textbox' | 'searchbox' | 'checkbox' | 'radio' | 'combobox' | 'menuitem' | 'tab'
  | 'option' | 'file' | 'heading' | 'dialog' | 'text';

export const ACTIONABLE_ROLES: ReadonlySet<BcRole> = new Set<BcRole>([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'option', 'file',
]);

// Where a node sits on a LinkedIn PROFILE page (url path /in/<slug>): the profile's own top card, a sidebar or
// recommendation card, the rest of the page, an open dialog, or an open menu. The top card is order-based, not
// container-based (LinkedIn's markup keeps changing): the page's own name heading (a heading whose text holds the
// name in the page title, else the first h1, else the first heading in main, else the first heading) plus every node
// after it in document order up to the next heading (About, Activity, ...), minus anything inside an aside or a card
// that links to another person's /in/ profile. A Connect in a sidebar or card sends an invitation directly; only the
// top card Connect opens the invite dialog. Not set on other pages.
export type Region = 'topcard' | 'sidebar' | 'main' | 'dialog' | 'menu';

export interface RawNode {
  /** Ordinal stamped as data-bc on the element (-1: an element found by point that was never stamped). */
  n: number;
  role: BcRole;
  name: string;            // accessible name, capped
  text: string;            // own text for role 'text', else ''
  value?: string;          // textbox current value (never for secret fields)
  href?: string;
  disabled: boolean;
  secret?: true;           // password-like field: value never read
  submit?: true;           // type=submit (or a form button without a type)
  inFooter?: true;         // inside a footer / action bar of its dialog
  composer?: true;         // free-text field meant for a message or note (not search, not password), or a button inside a composer form
  dialog?: number;         // ordinal of the enclosing dialog node
  dialogName?: string;     // accessible name of the enclosing dialog
  region?: Region;         // profile pages only, see Region
}
export interface RawTree { url: string; title: string; nodes: RawNode[]; truncated?: true }
/** A node re-read live at the moment of an action (same shape as a snapshot node). */
export type LiveNode = RawNode;

// Pages with a big filter sidebar (Naukri search) put hundreds of text nodes before the result cards, so the
// collection cap is generous; the render budget drops low-value text lines first, never controls.
export const MAX_NODES = 1500;
/** Menu rows still read past MAX_NODES: an open menu sits in a portal at the END of the body, behind the whole page. */
export const MENU_EXTRA = 60;
/** Nodes of an open dialog still read past MAX_NODES: the modal host sits at the END of the body, behind the whole page. */
export const DIALOG_EXTRA = 200;
export const MAX_NAME = 200;
export const MAX_TEXT = 300;
export const MAX_VALUE = 5000;
export const MAX_RENDER_CHARS = 6000;
/** Ordinals of nodes read through Patchright locators (dialogs and menus in a closed shadow root, see locatorDialogs.ts) start here. */
export const LOCATOR_BASE = 60000;

// ---- shared visibility rules cut out of the LinkedIn snapshot script ----
function cutVis(): string {
  const a = SNAPSHOT_SRC.indexOf('var HIDDEN_TAGS');
  const b = SNAPSHOT_SRC.indexOf('function vlines(root)');
  if (a < 0 || b < a) throw new Error('browserctl: cannot cut the visibility rules from the LinkedIn snapshot script');
  return SNAPSHOT_SRC.slice(a, b);
}
export const VIS_SRC = cutVis();

// ---- in-page script (a string on purpose, like linkedin/snapshot.ts) ----
const BODY_SRC = String.raw`
  var ACTION = { button:1, link:1, textbox:1, searchbox:1, checkbox:1, radio:1, combobox:1, menuitem:1, tab:1, option:1, file:1 };
  var ARIA = { button:'button', link:'link', textbox:'textbox', searchbox:'searchbox', checkbox:'checkbox', radio:'radio',
    combobox:'combobox', menuitem:'menuitem', tab:'tab', option:'option', heading:'heading', dialog:'dialog',
    alertdialog:'dialog', 'switch':'checkbox' };
  function norm(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; }
  function flatText(e) {
    var parts = [];
    (function walk(x) {
      for (var i = 0; i < x.childNodes.length; i++) {
        var c = x.childNodes[i];
        if (c.nodeType === 3) { parts.push(c.nodeValue || ''); continue; }
        if (c.nodeType !== 1 || ownHidden(c)) continue;
        parts.push(' '); walk(c); parts.push(' ');
      }
    })(e);
    return parts.join('');
  }
  // Accessible name from content: like flatText, but a descendant that carries its own aria-label contributes that label
  // instead of its text (LinkedIn More rows are <a><div aria-label="Personalize invite">...</div></a>: the <a> has none).
  function labelText(e) {
    var parts = [];
    (function walk(x) {
      for (var i = 0; i < x.childNodes.length; i++) {
        var c = x.childNodes[i];
        if (c.nodeType === 3) { parts.push(c.nodeValue || ''); continue; }
        if (c.nodeType !== 1 || ownHidden(c)) continue;
        var lb = norm(c.getAttribute ? c.getAttribute('aria-label') : '', 200);
        parts.push(' ');
        if (lb) parts.push(lb); else walk(c);
        parts.push(' ');
      }
    })(e);
    return parts.join('');
  }
  function par(e) {
    if (e.parentElement) return e.parentElement;
    var r = e.getRootNode ? e.getRootNode() : null;
    return r && r.host ? r.host : null;
  }
  function visD(e) {
    if (!e) return false;
    var chain = [], x = e;
    while (x && !allMemo.has(x)) { chain.push(x); x = par(x); }
    var res = x ? allMemo.get(x) : true;
    for (var i = chain.length - 1; i >= 0; i--) {
      res = res && !ownHidden(chain[i]);
      allMemo.set(chain[i], res);
    }
    return allMemo.get(e);
  }
  // Menu rows. An open popover (browser top layer: position fixed, offsetParent null) or a role=menu list is judged by its
  // own boxes and styles only, never by the page-wide hiding heuristics, so its rows stay readable while it is open.
  function inMenu(e, role) {
    for (var x = par(e); x; x = par(x)) {
      if (attr(x, 'role').trim().toLowerCase() === 'menu') return true;
      if (role === 'menuitem' && x.hasAttribute('popover')) return true;
    }
    return false;
  }
  function menuHiddenOwn(x) {
    if (x.hasAttribute('hidden')) return true;
    var ah = x.getAttribute('aria-hidden');
    if (ah && ah.trim().toLowerCase() === 'true') return true;
    var cs = getComputedStyle(x);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    var o = parseFloat(cs.opacity);
    return isNaN(o) || o < 0.05;
  }
  function menuShown(e) {
    try {
      if (!inMenu(e, roleOf(e))) return false;
      for (var x = e; x; x = par(x)) if (menuHiddenOwn(x)) return false;
      var r = e.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    } catch (err) { return false; }
  }
  // A node inside an open dialog (or the dialog itself).
  function inDlg(e) { return roleOf(e) === 'dialog' || !!enclosingDialog(e); }
  // Dialog content is judged by boxes and plain hiding only (hidden attribute, aria-hidden true, display, visibility,
  // opacity, a box, a tiny font), never by the page-wide colour and clipping heuristics, so a modal in a shadow root is not
  // dropped by a false positive. aria-hidden other than "true" (false, empty, absent) never hides.
  function dlgShown(e) {
    try {
      if (!inDlg(e)) return false;
      for (var x = e; x; x = par(x)) {
        if (menuHiddenOwn(x)) return false;
        var cs = getComputedStyle(x), f = parseFloat(cs.fontSize);
        if (!isNaN(f) && f < 6) return false;
        var ti = parseFloat(cs.textIndent);
        if (!isNaN(ti) && ti <= -200) return false;
      }
      var r = e.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    } catch (err) { return false; }
  }
  function shown(e) { return visD(e) || menuShown(e) || dlgShown(e); }
  // An iframe is entered only when it is itself visible and same-origin (a cross-origin contentDocument throws).
  function ifrOk(f) {
    try {
      var pp = par(f);
      if (pp && !visD(pp)) return false;
      var cs = getComputedStyle(f);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
      var r = f.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    } catch (err) { return false; }
  }
  // Every element under start in document order, entering OPEN shadow roots (their content comes right after
  // the host) and visible same-origin iframes. Closed shadow roots are invisible to script and stay unseen.
  function deepList(start) {
    var out = [], stack = [], LIM = 30000;
    function kids(node, into) {
      var ks = [];
      for (var c = node.firstElementChild; c; c = c.nextElementSibling) ks.push(c);
      for (var i = ks.length - 1; i >= 0; i--) into.push(ks[i]);
    }
    kids(start, stack);
    while (stack.length && out.length < LIM) {
      var e = stack.pop();
      out.push(e);
      kids(e, stack);
      if (String(e.tagName || '').toUpperCase() === 'IFRAME' && ifrOk(e)) {
        try { var idoc = e.contentDocument; if (idoc && idoc.body) kids(idoc.body, stack); } catch (err2) { /* cross-origin */ }
      }
      if (e.shadowRoot) kids(e.shadowRoot, stack);
    }
    return out;
  }
  function deepRoot() { return document.body || document.documentElement; }
  function attr(e, k) { var v = e.getAttribute(k); return v === null ? '' : String(v); }
  function roleOf(e) {
    var tag = String(e.tagName || '').toUpperCase();
    var ar = attr(e, 'role').trim().toLowerCase();
    if (ar && ARIA[ar]) return ARIA[ar];
    if (tag === 'A') return e.hasAttribute('href') ? 'link' : null;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'DIALOG') return 'dialog';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'INPUT') {
      var t = attr(e, 'type').trim().toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'file') return 'file';
      return 'textbox';
    }
    var ce = e.hasAttribute('contenteditable') ? attr(e, 'contenteditable').trim().toLowerCase() : null;
    if (ce !== null && ce !== 'false') return 'textbox';
    return null;
  }
  function isSecret(e) {
    if (String(e.tagName || '').toUpperCase() !== 'INPUT') return false;
    var t = attr(e, 'type').trim().toLowerCase();
    var ac = attr(e, 'autocomplete').toLowerCase();
    return t === 'password' || ac.indexOf('password') >= 0 || ac.indexOf('one-time-code') >= 0 || ac.indexOf('cc-') >= 0;
  }
  function nameOf(e, role) {
    var a = norm(attr(e, 'aria-label'), 200);
    if (a) return a;
    var tag = String(e.tagName || '').toUpperCase();
    if (tag === 'INPUT') {
      var t = attr(e, 'type').trim().toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') { var v = norm(attr(e, 'value'), 200); if (v) return v; }
      return norm(attr(e, 'placeholder') || attr(e, 'title') || attr(e, 'alt'), 200);
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      return norm(attr(e, 'placeholder') || attr(e, 'title'), 200);
    }
    var f = norm(labelText(e), 200);
    if (f) return f;
    var ti = norm(attr(e, 'title'), 200);
    if (ti) return ti;
    var img = e.querySelector ? e.querySelector('img[alt]') : null;
    return img ? norm(attr(img, 'alt'), 200) : '';
  }
  function dialogNameOf(d) {
    var a = norm(attr(d, 'aria-label'), 200);
    if (a) return a;
    var hs = deepList(d);
    for (var i = 0; i < hs.length; i++) {
      if (roleOf(hs[i]) !== 'heading' || !visD(hs[i])) continue;
      var h = norm(flatText(hs[i]), 200); if (h) return h;
    }
    return '';
  }
  function enclosingDialog(e) {
    for (var x = par(e); x; x = par(x)) if (roleOf(x) === 'dialog') return x;
    return null;
  }
  function inFooterOf(e, dlg) {
    if (!dlg) return false;
    for (var x = e; x && x !== dlg; x = par(x)) {
      if (String(x.tagName || '').toUpperCase() === 'FOOTER') return true;
      if (/footer|actionbar|action-bar/i.test(attr(x, 'class'))) return true;
    }
    return false;
  }
  function isSubmitEl(e) {
    var tag = String(e.tagName || '').toUpperCase();
    var t = attr(e, 'type').trim().toLowerCase();
    if (tag === 'INPUT') return t === 'submit' || t === 'image';
    if (tag !== 'BUTTON') return false;
    if (t === 'submit') return true;
    if (t) return false;
    for (var x = par(e); x; x = par(x)) if (String(x.tagName || '').toUpperCase() === 'FORM') return true;
    return false;
  }
  function isComposer(e, role, secret) {
    if (secret) return false;
    if (role === 'button' || role === 'menuitem') {
      for (var y = par(e); y; y = par(y)) if (/compose|msg-form|msg-overlay|chatbot|chat/i.test(attr(y, 'class'))) return true;
      return false;
    }
    if (role !== 'textbox') return false;
    var tag = String(e.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || (tag !== 'INPUT' && e.hasAttribute('contenteditable'))) return true;
    if (enclosingDialog(e)) return true;
    for (var x = par(e); x; x = par(x)) if (/compose|msg-form|msg-overlay|chatbot|chat/i.test(attr(x, 'class'))) return true;
    return false;
  }
  // ---- regions (profile pages only) ----
  var PSLUG = (function () { var m = /^\/in\/([^\/]+)/.exec(String(location.pathname || '')); return m ? m[1].toLowerCase() : ''; })();
  var RCTX = null;
  function slugOfHref(h) { var m = /\/in\/([^\/?#]+)/.exec(String(h || '')); return m ? m[1].toLowerCase() : ''; }
  function sideEl(x) {
    var t = String(x.tagName || '').toUpperCase(), r = attr(x, 'role').trim().toLowerCase();
    if (t === 'ASIDE' || r === 'complementary') return true;
    if (t === 'LI' || t === 'ARTICLE' || r === 'listitem' || r === 'article') {
      var ls = x.querySelectorAll ? x.querySelectorAll('a[href*="/in/"]') : [];
      for (var i = 0; i < ls.length && i < 20; i++) { var sg = slugOfHref(ls[i].getAttribute('href')); if (sg && sg !== PSLUG) return true; }
    }
    return false;
  }
  function inSide(e) { for (var x = e; x; x = par(x)) if (sideEl(x)) return true; return false; }
  function inMain(e) {
    for (var x = e; x; x = par(x)) if (String(x.tagName || '').toUpperCase() === 'MAIN' || attr(x, 'role').trim().toLowerCase() === 'main') return true;
    return false;
  }
  // The person's name in the page title: "(3) Jane Example | LinkedIn" -> "jane example"; '' when the title has no name.
  function titleName() {
    var t = norm(String(document.title || ''), 300).replace(/^\(\d+\)\s*/, '');
    var m = /^(.+?)\s+[|–—-]\s+/.exec(t);
    var n = m ? m[1].toLowerCase() : '';
    return n === 'linkedin' ? '' : n;
  }
  function buildRegionCtx(list) {
    if (!PSLUG) return null;
    var heads = [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (roleOf(x) === 'heading' && visD(x) && !enclosingDialog(x) && !inSide(x)) heads.push(x);
    }
    var tn = titleName(), h = null, k;
    if (tn) for (k = 0; k < heads.length && !h; k++) { var tx = norm(flatText(heads[k]), 200).toLowerCase(); if (tx && tx.indexOf(tn) >= 0) h = heads[k]; }
    for (k = 0; k < heads.length && !h; k++) if (String(heads[k].tagName || '').toUpperCase() === 'H1') h = heads[k];
    for (k = 0; k < heads.length && !h; k++) if (inMain(heads[k])) h = heads[k];
    if (!h) h = heads[0] || null;
    var pos = new Map();
    for (k = 0; k < list.length; k++) pos.set(list[k], k);
    return { h: h, fb: h ? (heads[heads.indexOf(h) + 1] || null) : null, pos: pos };
  }
  function regionOf(e, role) {
    if (!RCTX) return '';
    if (role === 'dialog' || enclosingDialog(e)) return 'dialog';
    if (inMenu(e, role)) return 'menu';
    var side = inSide(e), at = RCTX.pos.get(e);
    // Order of the walked list (shadow-safe, unlike compareDocumentPosition): from the name heading up to the next heading.
    if (RCTX.h && at !== undefined && at >= RCTX.pos.get(RCTX.h) && !(RCTX.fb && at >= RCTX.pos.get(RCTX.fb)) && !side) return 'topcard';
    return side ? 'sidebar' : 'main';
  }
  function stampOf(e) { var s = e.getAttribute('data-bc'); return s === null ? -1 : parseInt(s, 10); }
  function info(e, role, full) {
    var secret = role === 'textbox' && isSecret(e);
    var o = { n: stampOf(e), role: role, name: nameOf(e, role), text: '', disabled: e.hasAttribute('disabled') || attr(e, 'aria-disabled').toLowerCase() === 'true' };
    if (role === 'text') { o.text = norm(ownText(e), 300); o.name = ''; }
    if (role === 'heading') o.name = norm(flatText(e), 200);
    if (role === 'dialog') o.name = dialogNameOf(e);
    if (role === 'link') { var h = attr(e, 'href'); if (h) o.href = norm(h, 300); }
    if (secret) o.secret = true;
    else if (role === 'textbox' || role === 'searchbox') {
      var tg = String(e.tagName || '').toUpperCase();
      var val = (tg === 'INPUT' || tg === 'TEXTAREA') ? String(e.value || '') : String(e.innerText || e.textContent || '');
      o.value = val.length > (full ? 5000 : 300) ? val.slice(0, full ? 5000 : 300) : val;
    }
    if (isSubmitEl(e)) o.submit = true;
    var dlg = role === 'dialog' ? enclosingDialog(e) : enclosingDialog(e);
    if (inFooterOf(e, dlg)) o.inFooter = true;
    if (isComposer(e, role, secret)) o.composer = true;
    if (dlg) { o.dialog = stampOf(dlg); o.dialogName = dialogNameOf(dlg); }
    if (RCTX) o.region = regionOf(e, role);
    return o;
  }
  function ownText(e) {
    var s = '';
    for (var i = 0; i < e.childNodes.length; i++) { var c = e.childNodes[i]; if (c.nodeType === 3) s += ' ' + (c.nodeValue || ''); }
    return s;
  }
  function nearestActionable(e) {
    for (var i = 0, x = e; x && i < 8; i++, x = par(x)) { var r = roleOf(x); if (r && ACTION[r]) return [x, r]; }
    return null;
  }
  function underAction(e) {
    for (var x = par(e); x; x = par(x)) { var r = roleOf(x); if (r && ACTION[r]) return true; }
    return false;
  }
  if (MODE === 'snapshot') {
    var all = document.body ? deepList(document.body) : [];
    for (var oi = 0; oi < all.length; oi++) if (all[oi].hasAttribute('data-bc')) all[oi].removeAttribute('data-bc');
    RCTX = buildRegionCtx(all);
    var nodes = [], n = 0, truncated = false;
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      if (HIDDEN_TAGS[String(e.tagName || '').toUpperCase()]) continue;
      var role = roleOf(e);
      // Past the cap only the rows of an open menu and the content of an open dialog are still read (a few), so a portal or
      // modal host at the end of the body is never lost.
      if (nodes.length >= MAXN) {
        truncated = true;
        var over = nodes.length - MAXN;
        if (!((role && over < MENUX && inMenu(e, role)) || (over < MENUX + DLGX && inDlg(e)))) continue;
      }
      if (!shown(e)) continue;
      if (!role) {
        if (!/\S/.test(ownText(e)) || underAction(e)) continue;
        role = 'text';
      } else if (role === 'text') { continue; }
      e.setAttribute('data-bc', String(n));
      nodes.push(info(e, role, false));
      n++;
    }
    var res = { url: String(location.href || ''), title: norm(document.title, 300), nodes: nodes };
    if (truncated) res.truncated = true;
    return res;
  }
  if (MODE === 'diag') {
    var dall = document.body ? deepList(document.body) : [];
    var sr = 0, ifc = 0, chc = 0, dls = [], exo = [], ahc = null;
    for (var qi = 0; qi < dall.length; qi++) {
      var de = dall[qi], dtag = String(de.tagName || '').toUpperCase();
      // Controls that announce an open popup (a More button whose menu is open): tag and role names and counts only.
      if (attr(de, 'aria-expanded') === 'true' && exo.length < 4 && visD(de)) {
        var cid = attr(de, 'aria-controls'), cel = cid ? document.getElementById(cid) : null, kids = [];
        if (cel) { var cd = deepList(cel); for (var ki = 0; ki < cd.length && kids.length < 12; ki++) kids.push(String(cd[ki].tagName || '').toLowerCase() + '/' + (attr(cd[ki], 'role') || '-')); }
        // Where the label of each link row sits (counts only): on the <a>, on a descendant, in its text, or nowhere.
        var rows = { own: 0, desc: 0, text: 0, none: 0 }, cand = cel ? deepList(cel) : dall.slice(qi + 1, qi + 400);
        for (var ri = 0; ri < cand.length; ri++) {
          var ra = cand[ri];
          if (String(ra.tagName || '').toUpperCase() !== 'A' || !visD(ra)) continue;
          if (attr(ra, 'aria-label')) rows.own++;
          else if (ra.querySelector && ra.querySelector('[aria-label]')) rows.desc++;
          else if (/\S/.test(flatText(ra))) rows.text++;
          else rows.none++;
        }
        exo.push({ tag: dtag.toLowerCase(), role: attr(de, 'role') || '-', popup: attr(de, 'aria-haspopup') || '-', controls: cid ? 1 : 0, found: cel ? 1 : 0, kids: kids, rows: rows });
      }
      if (de.shadowRoot) sr++;
      else if (dtag.indexOf('-') > 0) chc++;
      if (dtag === 'IFRAME') ifc++;
      // aria-hidden values up the first dialog's chain (hidden or not): counts only.
      if (!ahc && roleOf(de) === 'dialog') {
        ahc = { true: 0, false: 0, absent: 0 };
        for (var ax = de, ai = 0; ax && ai < 60; ai++, ax = par(ax)) {
          var av = ax.getAttribute ? ax.getAttribute('aria-hidden') : null;
          if (av === null) ahc.absent++; else if (String(av).trim().toLowerCase() === 'true') ahc.true++; else ahc.false++;
        }
      }
      if (roleOf(de) === 'dialog' && visD(de) && dls.length < 6) {
        var bs = [], dd = deepList(de);
        for (var bi = 0; bi < dd.length && bs.length < 12; bi++) {
          var br = roleOf(dd[bi]);
          if ((br === 'button' || br === 'link') && visD(dd[bi])) bs.push(norm(nameOf(dd[bi], br), 60));
        }
        dls.push({ role: attr(de, 'role') || dtag.toLowerCase(), name: dialogNameOf(de).slice(0, 60), buttons: bs });
      }
    }
    return { shadowRoots: sr, iframes: ifc, closedHostCandidates: chc, dialogs: dls, expanded: exo, ariaHiddenChain: ahc || undefined };
  }
  if (MODE === 'describe') {
    var el = null, want = String(A.n | 0), dl = deepList(deepRoot());
    RCTX = buildRegionCtx(dl);
    for (var di = 0; di < dl.length; di++) if (dl[di].getAttribute('data-bc') === want) { el = dl[di]; break; }
    if (!el || !shown(el)) return null;
    var r0 = roleOf(el) || (/\S/.test(ownText(el)) ? 'text' : null);
    return r0 ? info(el, r0, true) : null;
  }
  if (MODE === 'at') {
    RCTX = buildRegionCtx(deepList(deepRoot()));
    var pe = document.elementFromPoint(A.x, A.y), px = A.x, py = A.y;
    for (var hop = 0; pe && hop < 6; hop++) {
      if (pe.shadowRoot && pe.shadowRoot.elementFromPoint) {
        var sp = pe.shadowRoot.elementFromPoint(px, py);
        if (sp && sp !== pe) { pe = sp; continue; }
      }
      if (String(pe.tagName || '').toUpperCase() === 'IFRAME') {
        try {
          var ir = pe.getBoundingClientRect(), idc = pe.contentDocument;
          var ip = idc && idc.elementFromPoint ? idc.elementFromPoint(px - ir.left, py - ir.top) : null;
          if (ip && ifrOk(pe)) { px -= ir.left; py -= ir.top; pe = ip; continue; }
        } catch (err3) { /* cross-origin */ }
      }
      break;
    }
    if (!pe || !shown(pe)) return null;
    var na = nearestActionable(pe);
    if (na) return info(na[0], na[1], true);
    var r1 = roleOf(pe) || 'text';
    return info(pe, r1, true);
  }
  if (MODE === 'focused') {
    RCTX = buildRegionCtx(deepList(deepRoot()));
    var fe = document.activeElement;
    for (var fh = 0; fe && fh < 6; fh++) {
      var inner = null;
      if (fe.shadowRoot && fe.shadowRoot.activeElement) inner = fe.shadowRoot.activeElement;
      else if (String(fe.tagName || '').toUpperCase() === 'IFRAME') { try { inner = fe.contentDocument && fe.contentDocument.activeElement; } catch (err4) { inner = null; } }
      if (!inner || inner === fe) break;
      fe = inner;
    }
    if (!fe || fe === document.body || !shown(fe)) return null;
    var r2 = roleOf(fe);
    return r2 ? info(fe, r2, true) : null;
  }
  return null;
`;

/** Build the in-page expression for one mode. Args are JSON-embedded numbers only (never model strings). */
export function bcScript(mode: 'snapshot' | 'describe' | 'at' | 'focused' | 'diag', args: { n?: number; x?: number; y?: number } = {}): string {
  const safe: Record<string, number> = {};
  for (const k of ['n', 'x', 'y'] as const) {
    const v = args[k];
    if (v !== undefined) {
      if (!Number.isFinite(v)) throw new Error('browserctl: non-numeric script argument');
      safe[k] = v;
    }
  }
  return `(function (MODE, A) { try { var MAXN = ${MAX_NODES}, MENUX = ${MENU_EXTRA}, DLGX = ${DIALOG_EXTRA};\n${VIS_SRC}\n${BODY_SRC}\n } catch (err) { return null; } })(${JSON.stringify(mode)}, ${JSON.stringify(safe)})`;
}

// ---- fixture side ----
const SHADOW_OPEN_RE = /<template\b[^>]*\bshadowrootmode\s*=\s*["']?open["']?[^>]*>/i;
const SRCDOC_RE = /<iframe\b[^>]*\bsrcdoc\s*=\s*"([^"]*)"[^>]*>(?:\s*<\/iframe>)?/gi;

// Fixture side of shadow roots and iframes: the in-page walker enters OPEN shadow roots and same-origin
// iframes, so fixtures spell them as <template shadowrootmode="open"> and <iframe srcdoc="...">. Both are
// unwrapped into plain wrapper elements here (other templates stay hidden, closed roots stay unseen).
export function flattenShadowFixture(html: string, depth = 0): string {
  const out = html.replace(SRCDOC_RE, (_m, doc: string) => {
    if (depth > 3) return '';
    const inner = doc.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return `<div data-bc-frame="1">${flattenShadowFixture(inner, depth + 1)}</div>`;
  });
  // Walk <template> open and close tokens with a stack so a plain nested template keeps its own close tag.
  const tok = /<template\b[^>]*>|<\/template\s*>/gi;
  const stack: boolean[] = [];
  let res = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tok.exec(out)) !== null) {
    res += out.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0][1] === '/') {
      res += stack.pop() ? '</div>' : m[0];
    } else {
      const shadow = SHADOW_OPEN_RE.test(m[0]);
      stack.push(shadow);
      res += shadow ? '<div data-bc-shadow="1">' : m[0];
    }
  }
  return res + out.slice(last);
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const flatOf = (nd: HtmlNode) => visibleText(nd).replace(/\s+/g, ' ').trim();
// Fixture side of labelText (in-page): a descendant element with its own aria-label contributes the label, not its text.
function labelOf(nd: HtmlNode): string {
  const parts: string[] = [];
  const walk = (x: HtmlNode): void => {
    for (const c of x.children) {
      if (c.tag === '#text') { parts.push(c.hidden ? '' : (c.text ?? '')); continue; }
      if (c.hidden) continue;
      const lb = (c.attrs['aria-label'] ?? '').replace(/\s+/g, ' ').trim();
      parts.push(' ');
      if (lb) parts.push(lb); else walk(c);
      parts.push(' ');
    }
  };
  walk(nd);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
const cls = (nd: HtmlNode) => nd.attrs['class'] ?? '';

function hideClosedDialogs(n: HtmlNode, parentHidden = false): void {
  const closed = n.tag === 'dialog' && !('open' in n.attrs);
  if (closed || parentHidden) n.hidden = true;
  for (const c of n.children) hideClosedDialogs(c, n.hidden);
}

const ARIA_ROLES: Record<string, BcRole> = {
  button: 'button', link: 'link', textbox: 'textbox', searchbox: 'searchbox', checkbox: 'checkbox', radio: 'radio',
  combobox: 'combobox', menuitem: 'menuitem', tab: 'tab', option: 'option', heading: 'heading', dialog: 'dialog',
  alertdialog: 'dialog', switch: 'checkbox',
};

function roleOfNode(nd: HtmlNode): BcRole | null {
  const ar = (nd.attrs['role'] ?? '').trim().toLowerCase();
  if (ar && ARIA_ROLES[ar]) return ARIA_ROLES[ar];
  const t = nd.tag;
  if (t === 'a') return 'href' in nd.attrs ? 'link' : null;
  if (t === 'button') return 'button';
  if (t === 'textarea') return 'textbox';
  if (t === 'select') return 'combobox';
  if (t === 'dialog') return 'dialog';
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'input') {
    const ty = (nd.attrs['type'] ?? '').trim().toLowerCase();
    if (ty === 'hidden') return null;
    if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
    if (ty === 'checkbox') return 'checkbox';
    if (ty === 'radio') return 'radio';
    if (ty === 'search') return 'searchbox';
    if (ty === 'file') return 'file';
    return 'textbox';
  }
  if ('contenteditable' in nd.attrs) {
    const ce = (nd.attrs['contenteditable'] ?? '').trim().toLowerCase();
    if (ce !== 'false') return 'textbox';
  }
  return null;
}

function secretNode(nd: HtmlNode): boolean {
  if (nd.tag !== 'input') return false;
  const ty = (nd.attrs['type'] ?? '').trim().toLowerCase();
  const ac = (nd.attrs['autocomplete'] ?? '').toLowerCase();
  return ty === 'password' || ac.includes('password') || ac.includes('one-time-code') || ac.includes('cc-');
}

function ownTextOf(nd: HtmlNode): string {
  return nd.children.filter((c) => c.tag === '#text').map((c) => c.text ?? '').join(' ');
}

function nameOfNode(nd: HtmlNode, role: BcRole): string {
  const a = (nd.attrs['aria-label'] ?? '').replace(/\s+/g, ' ').trim();
  if (a) return cap(a, MAX_NAME);
  const clean = (s: string | undefined) => cap((s ?? '').replace(/\s+/g, ' ').trim(), MAX_NAME);
  if (nd.tag === 'input') {
    const ty = (nd.attrs['type'] ?? '').trim().toLowerCase();
    if (ty === 'submit' || ty === 'button' || ty === 'reset') { const v = clean(nd.attrs['value']); if (v) return v; }
    return clean(nd.attrs['placeholder'] || nd.attrs['title'] || nd.attrs['alt']);
  }
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return clean(nd.attrs['placeholder'] || nd.attrs['title']);
  const f = clean(labelOf(nd));
  if (f) return f;
  const ti = clean(nd.attrs['title']);
  if (ti) return ti;
  const img = findAll(nd, (x) => x.tag === 'img' && 'alt' in x.attrs && !x.hidden)[0];
  return img ? clean(img.attrs['alt']) : '';
}

// ---- fixture side of the regions (same rules as the in-page script: keep them identical) ----
const slugOfHref = (h: string | undefined): string => { const m = /\/in\/([^/?#]+)/.exec(h ?? ''); return m ? m[1]!.toLowerCase() : ''; };
const profileSlugOf = (url: string): string => {
  try { const m = /^\/in\/([^/]+)/.exec(new URL(url).pathname); return m ? m[1]!.toLowerCase() : ''; } catch { return ''; }
};
const lowRole = (nd: HtmlNode): string => (nd.attrs['role'] ?? '').trim().toLowerCase();

interface RegionCtx {
  slug: string;
  h: HtmlNode | null;
  fb: HtmlNode | null;
  index: Map<HtmlNode, number>;
  parentOf: Map<HtmlNode, HtmlNode | null>;
}

function ancestorsOf(c: RegionCtx, nd: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (let p = c.parentOf.get(nd) ?? null; p; p = c.parentOf.get(p) ?? null) out.push(p);
  return out;
}

function sideNode(nd: HtmlNode, slug: string): boolean {
  const r = lowRole(nd);
  if (nd.tag === 'aside' || r === 'complementary') return true;
  if (nd.tag === 'li' || nd.tag === 'article' || r === 'listitem' || r === 'article') {
    return findAll(nd, (a) => a.tag === 'a' && (a.attrs['href'] ?? '').includes('/in/')).slice(0, 20)
      .some((a) => { const sg = slugOfHref(a.attrs['href']); return sg !== '' && sg !== slug; });
  }
  return false;
}

const inSideOf = (c: RegionCtx, nd: HtmlNode): boolean => [nd, ...ancestorsOf(c, nd)].some((a) => sideNode(a, c.slug));

/** The person's name in the page title: "(3) Jane Example | LinkedIn" gives "jane example"; '' when the title has no name. */
function titleNameOf(title: string): string {
  const m = /^(.+?)\s+[|–—-]\s+/.exec(title.replace(/^\(\d+\)\s*/, ''));
  const n = m ? m[1]!.toLowerCase() : '';
  return n === 'linkedin' ? '' : n;
}

function buildRegionCtx(body: HtmlNode, slug: string, title: string): RegionCtx {
  const index = new Map<HtmlNode, number>();
  const parentOf = new Map<HtmlNode, HtmlNode | null>();
  const order: HtmlNode[] = [];
  const visit = (nd: HtmlNode, parent: HtmlNode | null): void => {
    if (nd.tag === '#text') return;
    index.set(nd, order.length);
    order.push(nd);
    parentOf.set(nd, parent);
    for (const c of nd.children) visit(c, nd);
  };
  visit(body, null);
  const c: RegionCtx = { slug, h: null, fb: null, index, parentOf };
  const heads = order.filter((nd) => roleOfNode(nd) === 'heading' && !nd.hidden
    && !ancestorsOf(c, nd).some((a) => roleOfNode(a) === 'dialog') && !inSideOf(c, nd));
  const tn = titleNameOf(title);
  const inMain = (nd: HtmlNode) => [nd, ...ancestorsOf(c, nd)].some((a) => a.tag === 'main' || lowRole(a) === 'main');
  c.h = (tn ? heads.find((nd) => flatOf(nd).toLowerCase().includes(tn)) : undefined)
    ?? heads.find((nd) => nd.tag === 'h1') ?? heads.find(inMain) ?? heads[0] ?? null;
  c.fb = c.h ? heads[heads.indexOf(c.h) + 1] ?? null : null;
  return c;
}

/** A node under a role=menu list, or a menuitem under a popover: a row of an open menu (same rule as the in-page script). */
const underMenu = (ancestors: HtmlNode[], role: BcRole | null): boolean =>
  ancestors.some((a) => lowRole(a) === 'menu' || (role === 'menuitem' && 'popover' in a.attrs));

function regionOfNode(c: RegionCtx, nd: HtmlNode, role: BcRole, inDlg: boolean): Region {
  if (role === 'dialog' || inDlg) return 'dialog';
  if (underMenu(ancestorsOf(c, nd), role)) return 'menu';
  const side = inSideOf(c, nd);
  const at = c.index.get(nd) ?? -1;
  const after = (x: HtmlNode | null) => x !== null && at >= (c.index.get(x) ?? Infinity);
  if (c.h && after(c.h) && !after(c.fb) && !side) return 'topcard';
  return side ? 'sidebar' : 'main';
}

/** Fixture side. Sees inline styles and attributes only: stylesheet/class hiding is the in-page script's job. */
export function buildTreeFromHtml(html: string, url: string): RawTree {
  const out: RawTree = { url, title: '', nodes: [] };
  try {
    const root = parseHtml(flattenShadowFixture(html));
    hideClosedDialogs(root);
    const titleNode = findAll(root, (n) => n.tag === 'title')[0];
    if (titleNode) out.title = cap(titleNode.children.map((c) => c.text ?? '').join('').replace(/\s+/g, ' ').trim(), 300);
    const body = findAll(root, (n) => n.tag === 'body')[0] ?? root;
    let n = 0;
    const slug = profileSlugOf(url);
    const rctx = slug ? buildRegionCtx(body, slug, out.title) : null;
    const stamp = new Map<HtmlNode, number>();
    const dialogName = (d: HtmlNode): string => {
      const a = (d.attrs['aria-label'] ?? '').replace(/\s+/g, ' ').trim();
      if (a) return cap(a, MAX_NAME);
      const h = findAll(d, (x) => !x.hidden && (/^h[1-4]$/.test(x.tag) || (x.attrs['role'] ?? '').toLowerCase() === 'heading'))
        .map((x) => cap(flatOf(x), MAX_NAME)).find(Boolean);
      return h ?? '';
    };
    const walk = (nd: HtmlNode, parents: HtmlNode[]) => {
      if (nd.tag !== '#text' && nd !== body && nd.tag !== 'html' && !nd.hidden) {
        const own = roleOfNode(nd);
        let role = own;
        const underAction = parents.some((p) => { const r = roleOfNode(p); return r !== null && ACTIONABLE_ROLES.has(r); });
        if (!role && /\S/.test(ownTextOf(nd)) && !underAction) role = 'text';
        // Past the cap only the rows of an open menu are still read (a few), like the in-page script.
        const pastCap = out.nodes.length >= MAX_NODES;
        if (pastCap) out.truncated = true;
        const over = out.nodes.length - MAX_NODES;
        const keepPast = (own !== null && over < MENU_EXTRA && underMenu(parents, own))
          || (over < MENU_EXTRA + DIALOG_EXTRA && (own === 'dialog' || parents.some((p) => roleOfNode(p) === 'dialog')));
        if (role && !(pastCap && !keepPast)) {
          stamp.set(nd, n);
          const dlgNode = [...parents].reverse().find((p) => roleOfNode(p) === 'dialog');
          const secret = role === 'textbox' && secretNode(nd);
          const node: RawNode = {
            n, role, name: '', text: '',
            disabled: 'disabled' in nd.attrs || (nd.attrs['aria-disabled'] ?? '').toLowerCase() === 'true',
          };
          node.name = role === 'text' ? '' : role === 'heading' ? cap(flatOf(nd), MAX_NAME) : role === 'dialog' ? dialogName(nd) : nameOfNode(nd, role);
          if (role === 'text') node.text = cap(ownTextOf(nd).replace(/\s+/g, ' ').trim(), MAX_TEXT);
          if (role === 'link' && nd.attrs['href']) node.href = cap(nd.attrs['href'], 300);
          if (secret) node.secret = true;
          else if (role === 'textbox' || role === 'searchbox') {
            const v = nd.tag === 'input' ? (nd.attrs['value'] ?? '') : nd.tag === 'textarea' ? visibleText({ ...nd, hidden: false }) : flatOf(nd);
            node.value = cap(v, 300);
          }
          const ty = (nd.attrs['type'] ?? '').trim().toLowerCase();
          if (nd.tag === 'input' ? (ty === 'submit' || ty === 'image')
            : nd.tag === 'button' ? (ty === 'submit' || (!ty && parents.some((p) => p.tag === 'form'))) : false) node.submit = true;
          if (dlgNode) {
            const chain = [...parents].reverse();
            const upTo = chain.slice(0, chain.indexOf(dlgNode));
            if ([nd, ...upTo].some((x) => x.tag === 'footer' || /footer|actionbar|action-bar/i.test(cls(x)))) node.inFooter = true;
            node.dialog = stamp.get(dlgNode) ?? -1;
            node.dialogName = dialogName(dlgNode);
          }
          const classComposer = parents.some((p) => /compose|msg-form|msg-overlay|chatbot|chat/i.test(cls(p)));
          const composer = (role === 'button' || role === 'menuitem') ? classComposer
            : role === 'textbox' && !secret && (nd.tag === 'textarea' || (nd.tag !== 'input' && 'contenteditable' in nd.attrs)
              || !!dlgNode || classComposer);
          if (composer) node.composer = true;
          if (rctx) node.region = regionOfNode(rctx, nd, role, !!dlgNode);
          out.nodes.push(node);
          n++;
        }
      }
      for (const c of nd.children) walk(c, nd.tag === '#text' ? parents : [...parents, nd]);
    };
    walk(body, []);
  } catch {
    out.nodes = [];
  }
  return out;
}

// ---- render ----
// Profile pages: controls show where they sit (@topcard, @sidebar, @main), so the operator never picks a sidebar Connect.
const REGION_TAGGED: ReadonlySet<BcRole> = new Set<BcRole>(['button', 'link', 'menuitem']);
const MARKER = /<<<PAGE_TEXT|PAGE_TEXT>>>/g;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');
function clean(s: string): string {
  return s.replace(MARKER, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Compact text of a tree for the model: one line per node, `[s<E>.<n>] role "name"`, dialog content
 * indented. The caller wraps and screens it (screenUntrusted 'read') before it reaches a model.
 * Password-like fields show `secret` and never a value. Text past maxChars is cut with a marker.
 */
export function renderTree(tree: RawTree, epoch: number, maxChars = MAX_RENDER_CHARS): string {
  const head: string[] = [`url: ${clean(tree.url.split(/[?#]/)[0]).slice(0, 110)}`];
  if (tree.title) head.push(`title: ${clean(tree.title).slice(0, 120)}`);
  const cs = connectionStateOf(tree);
  if (cs) head.push(`connect_state: ${cs.state} (${cs.reason})`);
  const lines: string[] = [];
  for (const nd of tree.nodes) {
    const ref = `[s${epoch}.${nd.n}]`;
    const ind = nd.dialog !== undefined ? '  ' : '';
    let l: string;
    if (nd.role === 'text') l = `${ind}${ref} text "${clean(nd.text)}"`;
    else {
      l = `${ind}${ref} ${nd.role}`;
      if (nd.name) l += ` "${clean(nd.name)}"`;
      if (nd.region && REGION_TAGGED.has(nd.role) && (nd.region === 'topcard' || nd.region === 'sidebar' || nd.region === 'main')) l += ` @${nd.region}`;
      if (nd.role === 'dialog') l += ' (open)';
      if (nd.secret) l += ' secret';
      else if (nd.value) l += ` value="${clean(nd.value).slice(0, 120)}"`;
      if (nd.disabled) l += ' disabled';
    }
    lines.push(l);
  }
  const total = (ls: string[]) => head.join('\n').length + ls.reduce((a, l) => a + l.length + 1, 0);
  const keep = lines.map(() => true);
  if (total(lines) > maxChars) {
    // Over budget: dialog content and open menus rank first (they sit at the END of the tree, and an open
    // dialog or menu is what the operator must act on). Plain text next to a control (a card's company, location) ranks
    // second, other text last, and page controls only after all text is gone. Drop the lowest rank from the end of
    // the page backwards until it fits, so the top of the page and every dialog control stay.
    const nodes = tree.nodes;
    const rank = nodes.map((nd, i) => {
      if (nd.dialog !== undefined || nd.role === 'dialog' || nd.n >= LOCATOR_BASE || nd.region === 'menu') return 0;
      if (nd.role !== 'text') return 3;
      const near = [i - 2, i - 1, i + 1, i + 2].some((j) => nodes[j] !== undefined && nodes[j]!.role !== 'text');
      return near ? 1 : 2;
    });
    let size = total(lines);
    for (const r of [2, 1, 3]) {
      for (let i = lines.length - 1; i >= 0 && size > maxChars; i--) {
        if (rank[i] === r && keep[i]) { keep[i] = false; size -= lines[i]!.length + 1; }
      }
    }
  }
  const dropped = keep.filter((k) => !k).length;
  const out = [...head, ...lines.filter((_, i) => keep[i])];
  if (dropped) out.push(`(${dropped} lines omitted)`);
  if (tree.truncated) out.push('(page truncated)');
  let text = out.join('\n');
  if (text.length > maxChars + 60) text = text.slice(0, maxChars) + '\n(truncated)';
  return text;
}

/** Wrap rendered tree text as untrusted data with the epoch header. */
export function formatTree(tree: RawTree, epoch: number, maxChars = MAX_RENDER_CHARS): string {
  return `epoch: ${epoch}\n<<<PAGE_TEXT\n${renderTree(tree, epoch, maxChars)}\nPAGE_TEXT>>>`;
}
