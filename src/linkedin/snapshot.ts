// Two builders of the same RawSnapshot: SNAPSHOT_SRC runs inside the page (real computed styles),
// buildSnapshotFromHtml builds it from fixtures through htmlVisible.ts. Hidden text never reaches
// any field, bodyText included. Keep the section rules identical on both sides.
import type { RawSnapshot, RawProfile, RawResult, RawInvitation, RawMessage } from './types.js';
import { parseHtml, findAll, visibleText, type HtmlNode } from './htmlVisible.js';
import { extractAboutText } from './verify.js';

/**
 * In-page expression (a string on purpose, like naukri.ts: tsx/esbuild keepNames would inject
 * helpers that do not exist in the browser). Only reads the DOM. An element is invisible when it, or
 * any ancestor, is display:none, visibility hidden/collapse, opacity < 0.05, zero width or height,
 * font-size < 6px, more than 200px left of or above the page, aria-hidden="true", hidden, a closed
 * dialog, text-indent <= -200px, clipped to nothing, or has text colour equal to (within 8 per
 * channel) its resolved background. Anything computed that cannot be read fails closed (hidden).
 */
export const SNAPSHOT_SRC = String.raw`(function () {
  function empty(title, url) {
    return { url: url, title: title, profile: null, results: [], invitations: [], messages: [],
      messageHeaderName: null, notices: [], dialogText: null, hasPasswordInput: false, bodyText: '' };
  }
  var url = '', title = '';
  try {
    url = String(location.href || '');
    title = String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    var body = document.body;
    if (!body) return empty(title, url);
    var HIDDEN_TAGS = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1, HEAD: 1, SVG: 1, IFRAME: 1 };
    var BLOCK = { ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BODY: 1, BR: 1, DD: 1, DETAILS: 1, DIALOG: 1, DIV: 1,
      DL: 1, DT: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
      HEADER: 1, HR: 1, HTML: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, TABLE: 1, TR: 1, UL: 1,
      BUTTON: 1, OPTION: 1, TD: 1, TH: 1 };
    var ownMemo = new Map();
    var allMemo = new Map();
    function parseRgb(c) {
      var m = /^rgba?\(([^)]*)\)$/.exec(String(c || '').trim());
      if (!m) return null;
      var p = m[1].split(/[ ,\/]+/).filter(Boolean);
      if (p.length < 3) return null;
      var r = parseFloat(p[0]), g = parseFloat(p[1]), b = parseFloat(p[2]), a = p.length > 3 ? parseFloat(p[3]) : 1;
      if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return null;
      return [r, g, b, a];
    }
    function resolveBg(e) {
      for (var x = e; x; x = x.parentElement) {
        var cs = getComputedStyle(x);
        if (!cs) return null;
        var b = parseRgb(cs.backgroundColor);
        if (!b) return null;
        if (b[3] > 0.05) return b;
      }
      return [255, 255, 255, 1];
    }
    function hasOwnText(e) {
      for (var i = 0; i < e.childNodes.length; i++) {
        var c = e.childNodes[i];
        if (c.nodeType === 3 && /\S/.test(c.nodeValue || '')) return true;
      }
      return false;
    }
    function computeOwn(e) {
      var tag = String(e.tagName || '').toUpperCase();
      if (HIDDEN_TAGS[tag]) return true;
      if (e.hasAttribute('hidden')) return true;
      var ah = e.getAttribute('aria-hidden');
      if (ah && ah.trim().toLowerCase() === 'true') return true;
      if (tag === 'INPUT' && String(e.getAttribute('type') || '').toLowerCase() === 'hidden') return true;
      if (tag === 'DIALOG' && !e.hasAttribute('open')) return true;
      var cs = getComputedStyle(e);
      if (!cs) return true;
      if (cs.display === 'none') return true;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
      var o = parseFloat(cs.opacity);
      if (isNaN(o) || o < 0.05) return true;
      var f = parseFloat(cs.fontSize);
      if (isNaN(f) || f < 6) return true;
      var ti = parseFloat(cs.textIndent);
      if (!isNaN(ti) && ti <= -200) return true;
      var own = hasOwnText(e);
      var cp = String(cs.clipPath || 'none').trim().toLowerCase();
      if (cp !== 'none') return true;
      if (cp.indexOf('inset(100%') === 0) return true;
      var clp = String(cs.clip || 'auto').trim().toLowerCase();
      if (clp !== 'auto') return true;
      var r = e.getBoundingClientRect();
      if (!r) return true;
      if (tag !== 'HTML' && tag !== 'BODY' && (r.width <= 0 || r.height <= 0)) return true;
      var ovs = String(cs.overflow || '') + ' ' + String(cs.overflowX || '') + ' ' + String(cs.overflowY || '');
      if ((ovs.indexOf('hidden') >= 0 || ovs.indexOf('clip') >= 0) && (r.width <= 2 || r.height <= 2)) return true;
      var sx = window.scrollX || 0, sy = window.scrollY || 0;
      if (r.right + sx < -200 || r.bottom + sy < -200) return true;
      if (own) {
        var bg = resolveBg(e);
        if (!bg) return true;
        var fill = cs.webkitTextFillColor;
        if (fill === undefined && cs.getPropertyValue) fill = cs.getPropertyValue('-webkit-text-fill-color');
        var cols = [cs.color];
        if (fill) cols.push(fill);
        for (var ci = 0; ci < cols.length; ci++) {
          var c = parseRgb(cols[ci]);
          if (!c) return true;
          if (c[3] < 0.05) return true;
          if (Math.abs(c[0] - bg[0]) <= 8 && Math.abs(c[1] - bg[1]) <= 8 && Math.abs(c[2] - bg[2]) <= 8) return true;
        }
      }
      return false;
    }
    function ownHidden(e) {
      if (ownMemo.has(e)) return ownMemo.get(e);
      var h;
      try { h = computeOwn(e); } catch (err) { h = true; }
      ownMemo.set(e, h);
      return h;
    }
    function vis(e) {
      if (!e) return false;
      var chain = [], x = e;
      while (x && !allMemo.has(x)) { chain.push(x); x = x.parentElement; }
      var res = x ? allMemo.get(x) : true;
      for (var i = chain.length - 1; i >= 0; i--) {
        res = res && !ownHidden(chain[i]);
        allMemo.set(chain[i], res);
      }
      return allMemo.get(e);
    }
    function vlines(root) {
      var parts = [];
      (function walk(n) {
        var ch = n.childNodes;
        for (var i = 0; i < ch.length; i++) {
          var c = ch[i];
          if (c.nodeType === 3) { parts.push(c.nodeValue || ''); continue; }
          if (c.nodeType !== 1) continue;
          if (ownHidden(c)) continue;
          var b = BLOCK[String(c.tagName || '').toUpperCase()];
          if (b) parts.push('\n');
          walk(c);
          if (b) parts.push('\n');
        }
      })(root);
      var out = [];
      var ls = parts.join('').split('\n');
      for (var k = 0; k < ls.length; k++) { var l = ls[k].replace(/\s+/g, ' ').trim(); if (l) out.push(l); }
      return out;
    }
    function lines(e) {
      if (!vis(e)) return [];
      return vlines(e);
    }
    function flat(e) { return lines(e).join(' ').replace(/\s+/g, ' ').trim(); }
    function qs(root, sel) {
      var out = [], list = root.querySelectorAll(sel);
      for (var i = 0; i < list.length; i++) if (vis(list[i])) out.push(list[i]);
      return out;
    }
    function cap(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
    function uniq(a) { var o = []; for (var i = 0; i < a.length; i++) if (a[i] && o.indexOf(a[i]) < 0) o.push(a[i]); return o; }

    var pathname = String(location.pathname || '');
    var main = qs(document, 'main')[0] || null;

    var profile = null;
    if (main && /^\/in\//.test(pathname)) {
      var heads = qs(main, 'h1,h2'), name = '';
      for (var hi = 0; hi < heads.length; hi++) {
        var ht = flat(heads[hi]);
        if (ht && ht.toLowerCase() !== 'about') { name = ht; break; }
      }
      var header = qs(main, 'section')[0] || null;
      if (name && header) {
        var hl = lines(header), degree = null, i2;
        for (i2 = 0; i2 < hl.length; i2++) {
          var dm = /^(?:·\s*)?(1st|2nd|3rd)$/.exec(hl[i2]);
          if (dm) { degree = dm[1]; break; }
        }
        var actions = [], acts = qs(header, 'a,button');
        for (i2 = 0; i2 < acts.length; i2++) actions.push(cap(flat(acts[i2]), 60));
        actions = uniq(actions).slice(0, 20);
        var hn = qs(header, '.headline')[0], ln = qs(header, '.loc')[0];
        var headline = hn ? flat(hn) : '', location_ = ln ? flat(ln) : '';
        var rest = [];
        for (i2 = 0; i2 < hl.length; i2++) {
          var t = hl[i2];
          if (t === name || t === headline || t === location_ || /^(?:·\s*)?(1st|2nd|3rd)$/.test(t)) continue;
          if (actions.indexOf(t) >= 0 || t.length > 200) continue;
          rest.push(t);
        }
        if (!headline) headline = rest.shift() || '';
        if (!location_) location_ = rest.shift() || '';
        var about = null, secs = qs(main, 'section');
        for (i2 = 0; i2 < secs.length && about === null; i2++) {
          var h2s = qs(secs[i2], 'h2'), isAbout = false;
          for (var j = 0; j < h2s.length; j++) if (flat(h2s[j]) === 'About') isAbout = true;
          if (isAbout) {
            var raw = lines(secs[i2]).join('\n').replace(/^about\s*/i, '').trim();
            about = raw ? cap(raw, 4000) : null;
          }
        }
        var bells = qs(document, 'a'), hasBell = false, pending = false;
        for (i2 = 0; i2 < bells.length; i2++) {
          var al = String(bells[i2].getAttribute('aria-label') || '').toLowerCase();
          if (al.indexOf('manage notifications about') === 0) hasBell = true;
          if (al.indexOf('pending') === 0) pending = true;
        }
        profile = { name: cap(name, 200), headline: cap(headline, 300), degree: degree, location: cap(location_, 200),
          about: about, actions: actions, pending: pending, hasBell: hasBell, hasMessageButton: actions.indexOf('Message') >= 0 };
      }
    }

    var results = [], cards = qs(document, '[role=listitem]');
    for (var ci = 0; ci < cards.length && results.length < 12; ci++) {
      var links = qs(cards[ci], 'a'), link = null;
      for (var li2 = 0; li2 < links.length; li2++) {
        var hrefv = links[li2].getAttribute('href') || '';
        if (hrefv.indexOf('/in/') >= 0) { link = links[li2]; break; }
      }
      if (!link) continue;
      var nm = lines(link)[0] || '';
      var rl = lines(cards[ci]), hd = '';
      for (var r2 = 0; r2 < rl.length; r2++) if (rl[r2] !== nm) { hd = rl[r2]; break; }
      results.push({ name: cap(nm, 200), headline: cap(hd, 300), href: cap(link.getAttribute('href') || '', 500) });
    }

    var rows = [], lis = qs(document, 'li');
    for (var ri = 0; ri < lis.length; ri++) {
      var btns = qs(lis[ri], 'a,button'), hasAccept = false;
      for (var bi = 0; bi < btns.length; bi++) if (flat(btns[bi]).toLowerCase() === 'accept') hasAccept = true;
      if (hasAccept) rows.push(lis[ri]);
    }
    var invitations = [];
    for (var vi = 0; vi < rows.length && invitations.length < 20; vi++) {
      var inner = false;
      for (var wi = 0; wi < rows.length; wi++) if (wi !== vi && rows[vi].contains(rows[wi])) inner = true;
      if (inner) continue;
      var il = qs(rows[vi], 'a'), ilink = null;
      for (var xi = 0; xi < il.length; xi++) if ((il[xi].getAttribute('href') || '').indexOf('/in/') >= 0) { ilink = il[xi]; break; }
      var iname = ilink ? (lines(ilink)[0] || '') : '';
      var ilines = lines(rows[vi]), ihead = '';
      for (var yi = 0; yi < ilines.length; yi++) {
        var lt = ilines[yi].toLowerCase();
        if (ilines[yi] !== iname && lt !== 'accept' && lt !== 'ignore') { ihead = ilines[yi]; break; }
      }
      invitations.push({ index: invitations.length, name: cap(iname, 200), headline: cap(ihead, 300),
        href: cap(ilink ? (ilink.getAttribute('href') || '') : '', 500) });
    }

    var messages = [], mlists = qs(document, '.msg-s-message-list');
    if (mlists.length) {
      var mli = qs(mlists[0], 'li');
      for (var mi = 0; mi < mli.length; mi++) {
        var mc = mli[mi].classList;
        var who = mc.contains('me') ? 'me' : (mc.contains('them') ? 'them' : null);
        if (!who) continue;
        var mt = flat(mli[mi]);
        if (mt) messages.push({ from: who, text: cap(mt, 1000) });
      }
      messages = messages.slice(-6);
    }

    var messageHeaderName = null, mall = qs(document, '[class*="msg-"]');
    for (var gi = 0; gi < mall.length && messageHeaderName === null; gi++) {
      var toks = String(mall[gi].getAttribute('class') || '').split(/\s+/), isMsg = false;
      for (var ti2 = 0; ti2 < toks.length; ti2++) if (toks[ti2].indexOf('msg-') === 0) isMsg = true;
      if (!isMsg) continue;
      var hh = qs(mall[gi], 'header h2');
      for (var hj = 0; hj < hh.length; hj++) { var hv = flat(hh[hj]); if (hv) { messageHeaderName = cap(hv, 200); break; } }
    }

    var notices = uniq(qs(document, '[role=alert],[role=status],.artdeco-toast-item').map(function (e) { return cap(flat(e), 200); })).slice(0, 5);
    var dlg = qs(document, 'dialog,[role=dialog]')[0] || null;
    var dialogText = dlg ? (lines(dlg).join('\n') || null) : null;
    if (dialogText) dialogText = cap(dialogText, 2000);
    var pw = qs(document, 'input[type=password]');
    var bodyText = vis(body) ? cap(vlines(body).join('\n'), 60000) : '';
    return { url: url, title: title, profile: profile, results: results, invitations: invitations, messages: messages,
      messageHeaderName: messageHeaderName, notices: notices, dialogText: dialogText, hasPasswordInput: pw.length > 0, bodyText: bodyText };
  } catch (err) {
    return empty(title, url);
  }
})()`;

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const uniq = (a: string[]) => a.filter((x, i) => x && a.indexOf(x) === i);
const cls = (n: HtmlNode) => (n.attrs['class'] ?? '').split(/\s+/).filter(Boolean);
const vq = (root: HtmlNode, pred: (n: HtmlNode) => boolean) => findAll(root, (n) => n.tag !== '#text' && !n.hidden && pred(n));
const tagIn = (...t: string[]) => (n: HtmlNode) => t.includes(n.tag);
const linesOf = (n: HtmlNode) => (n.hidden ? [] : visibleText(n).split('\n').filter(Boolean));
const flat = (n: HtmlNode) => linesOf(n).join(' ').replace(/\s+/g, ' ').trim();
const DEGREE = /^(?:·\s*)?(1st|2nd|3rd)$/;

function hideClosedDialogs(n: HtmlNode, parentHidden = false): void {
  const closed = n.tag === 'dialog' && !('open' in n.attrs);
  if (closed || parentHidden) n.hidden = true;
  for (const c of n.children) hideClosedDialogs(c, n.hidden);
}

/** Fixture side. Sees inline styles and attributes only: stylesheet/class hiding needs a layout engine and is the in-page script's job. */
export function buildSnapshotFromHtml(html: string, url: string): RawSnapshot {
  const out: RawSnapshot = {
    url, title: '', profile: null, results: [], invitations: [], messages: [],
    messageHeaderName: null, notices: [], dialogText: null, hasPasswordInput: false, bodyText: '',
  };
  try {
    const root = parseHtml(html);
    hideClosedDialogs(root);
    const titleNode = findAll(root, (n) => n.tag === 'title')[0];
    if (titleNode) out.title = cap(titleNode.children.map((c) => c.text ?? '').join('').replace(/\s+/g, ' ').trim(), 300);
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch { /* leave empty */ }
    const body = findAll(root, (n) => n.tag === 'body')[0] ?? root;
    out.bodyText = cap(body.hidden ? '' : visibleText(body), 60000);
    const main = vq(root, tagIn('main'))[0];

    if (main && /^\/in\//.test(pathname)) {
      const name = vq(main, tagIn('h1', 'h2')).map(flat).find((t) => t && t.toLowerCase() !== 'about') ?? '';
      const header = vq(main, tagIn('section'))[0];
      if (name && header) {
        const hl = linesOf(header);
        const degree = (hl.map((l) => DEGREE.exec(l)).find(Boolean)?.[1] ?? null) as RawProfile['degree'];
        const actions = uniq(vq(header, tagIn('a', 'button')).map((n) => cap(flat(n), 60))).slice(0, 20);
        const hn = vq(header, (n) => cls(n).includes('headline'))[0];
        const ln = vq(header, (n) => cls(n).includes('loc'))[0];
        let headline = hn ? flat(hn) : '';
        let location = ln ? flat(ln) : '';
        const rest = hl.filter((t) => t !== name && t !== headline && t !== location && !DEGREE.test(t) && !actions.includes(t) && t.length <= 200);
        if (!headline) headline = rest.shift() ?? '';
        if (!location) location = rest.shift() ?? '';
        let about: string | null = null;
        for (const sec of vq(main, tagIn('section'))) {
          if (vq(sec, tagIn('h2')).some((h) => flat(h) === 'About')) {
            const a = extractAboutText(linesOf(sec).join('\n'));
            about = a ? cap(a, 4000) : null;
            break;
          }
        }
        const anchors = vq(root, tagIn('a')).map((a) => (a.attrs['aria-label'] ?? '').toLowerCase());
        out.profile = {
          name: cap(name, 200), headline: cap(headline, 300), degree, location: cap(location, 200), about, actions,
          pending: anchors.some((l) => l.startsWith('pending')),
          hasBell: anchors.some((l) => l.startsWith('manage notifications about')),
          hasMessageButton: actions.includes('Message'),
        };
      }
    }

    const results: RawResult[] = [];
    for (const card of vq(root, (n) => n.attrs['role'] === 'listitem')) {
      if (results.length >= 12) break;
      const link = vq(card, (n) => n.tag === 'a' && (n.attrs['href'] ?? '').includes('/in/'))[0];
      if (!link) continue;
      const nm = linesOf(link)[0] ?? '';
      const hd = linesOf(card).find((l) => l !== nm) ?? '';
      results.push({ name: cap(nm, 200), headline: cap(hd, 300), href: cap(link.attrs['href'] ?? '', 500) });
    }
    out.results = results;

    const rows = vq(root, tagIn('li')).filter((li) => vq(li, tagIn('a', 'button')).some((b) => flat(b).toLowerCase() === 'accept'));
    const invitations: RawInvitation[] = [];
    for (const row of rows) {
      if (invitations.length >= 20) break;
      if (rows.some((o) => o !== row && findAll(row, (n) => n === o).length > 0)) continue;
      const link = vq(row, (n) => n.tag === 'a' && (n.attrs['href'] ?? '').includes('/in/'))[0];
      const nm = link ? linesOf(link)[0] ?? '' : '';
      const hd = linesOf(row).find((l) => l !== nm && !['accept', 'ignore'].includes(l.toLowerCase())) ?? '';
      invitations.push({ index: invitations.length, name: cap(nm, 200), headline: cap(hd, 300), href: cap(link?.attrs['href'] ?? '', 500) });
    }
    out.invitations = invitations;

    const list = vq(root, (n) => cls(n).includes('msg-s-message-list'))[0];
    if (list) {
      const msgs: RawMessage[] = [];
      for (const li of vq(list, tagIn('li'))) {
        const c = cls(li);
        const from = c.includes('me') ? 'me' : c.includes('them') ? 'them' : null;
        const t = flat(li);
        if (from && t) msgs.push({ from, text: cap(t, 1000) });
      }
      out.messages = msgs.slice(-6);
    }
    for (const m of vq(root, (n) => cls(n).some((c) => c.startsWith('msg-')))) {
      const h = vq(m, tagIn('header')).flatMap((hd) => vq(hd, tagIn('h2'))).map(flat).find(Boolean);
      if (h) { out.messageHeaderName = cap(h, 200); break; }
    }

    out.notices = uniq(
      vq(root, (n) => n.attrs['role'] === 'alert' || n.attrs['role'] === 'status' || cls(n).includes('artdeco-toast-item')).map((n) => cap(flat(n), 200)),
    ).slice(0, 5);
    const dlg = vq(root, (n) => n.tag === 'dialog' || n.attrs['role'] === 'dialog')[0];
    if (dlg) {
      const t = linesOf(dlg).join('\n');
      out.dialogText = t ? cap(t, 2000) : null;
    }
    out.hasPasswordInput = vq(root, (n) => n.tag === 'input' && (n.attrs['type'] ?? '').toLowerCase() === 'password').length > 0;
  } catch {
    // fail closed: return what was built so far; bodyText stays visible-only
  }
  return out;
}
