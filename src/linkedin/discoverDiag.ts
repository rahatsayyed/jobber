// Evidence file for a search page that has results but yielded 0 cards (a layout change the parsers did not
// survive). One JSON file under .jobber/diag (dir 0700, file 0600): the url path without query, counts, and a trimmed
// structural dump of the live page (tag, role, aria-label, href path without query, class tokens, child count) so the
// next parser fix, or the semantic fallback's tuning, can be done from real structure. No page prose, no field values,
// no cookies, nothing typed; anything email- or phone-like is redacted by safeName. Writing never throws.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeName } from '../browserctl/diag.js';
import { PROJECT_ROOT } from '../layout/config.js';
import type { LiPage, RawSnapshot } from './types.js';

export const DISCOVER_DIAG_MAX_BYTES = 48 * 1024;
const DUMP_MAX_NODES = 320;

/** In-page expression: breadth-first structural outline of the body. Reads attributes only, never text. */
export const DUMP_SRC = String.raw`(function () {
  var out = [], q = [[document.body, 0]], skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, PATH: 1, SVG: 1 };
  function path(h) { h = String(h || ''); var i = h.search(/[?#]/); return (i >= 0 ? h.slice(0, i) : h).slice(0, 90); }
  while (q.length && out.length < ${DUMP_MAX_NODES}) {
    var it = q.shift(), e = it[0], d = it[1];
    if (!e || d > 14) continue;
    var tag = String(e.tagName || '').toUpperCase();
    if (skip[tag]) continue;
    var cl = String(e.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).map(function (c) { return c.slice(0, 28); });
    var kids = e.children ? e.children.length : 0;
    var interesting = kids > 1 || tag === 'A' || tag === 'LI' || tag === 'BUTTON' || e.getAttribute('role') || e.getAttribute('aria-label') || e.getAttribute('data-urn');
    if (interesting) {
      out.push([d, tag.toLowerCase(), String(e.getAttribute('role') || '').slice(0, 20), String(e.getAttribute('aria-label') || '').slice(0, 60),
        tag === 'A' ? path(e.getAttribute('href')) : '', cl.join(' '), kids, e.getAttribute('data-urn') ? 1 : 0]);
    }
    for (var i = 0; i < kids; i++) q.push([e.children[i], d + 1]);
  }
  return out;
})()`;

export interface DiscoverDiagInput {
  tool: string;
  search: string;
  url: string;
  snapshot: RawSnapshot;
  layout: string;
  reason: string;
}
export interface DiscoverDiagDeps { now: () => Date; page: LiPage | null; diagDir?: string }

const pathOf = (url: string): string => { try { return new URL(url).pathname.slice(0, 120); } catch { return 'unknown'; } };

type DumpRow = [number, string, string, string, string, string, number, number];

async function readDump(page: LiPage | null): Promise<DumpRow[] | null> {
  if (!page) return null;
  try {
    const r = await page.evaluate<unknown>(DUMP_SRC);
    if (!Array.isArray(r)) return null;
    return r.slice(0, DUMP_MAX_NODES).map((x) => {
      const a = Array.isArray(x) ? x : [];
      return [Number(a[0]) || 0, safeName(a[1]), safeName(a[2]), safeName(a[3]), safeName(a[4]), safeName(a[5]), Number(a[6]) || 0, a[7] ? 1 : 0] as DumpRow;
    });
  } catch {
    return null;
  }
}

/** Write the evidence file. Returns the path relative to the project, or null when it could not be written. */
export async function writeDiscoverDiag(deps: DiscoverDiagDeps, i: DiscoverDiagInput): Promise<string | null> {
  try {
    const dump = await readDump(deps.page);
    const s = i.snapshot;
    const file = {
      kind: 'discover_no_cards',
      at: deps.now().toISOString(),
      tool: i.tool,
      search: safeName(i.search),
      reason: i.reason,
      url_path: pathOf(i.url),
      title: safeName(s.title),
      layout: safeName(i.layout),
      card_parser: s.cardParser ?? 'none',
      link_evidence: s.linkEvidence ?? null,
      body_chars: s.bodyText.length,
      structure: s.structure ?? null,
      columns: ['depth', 'tag', 'role', 'aria_label', 'href_path', 'class_tokens', 'children', 'has_data_urn'],
      dump,
      dump_available: dump !== null,
    };
    let text = JSON.stringify(file);
    if (text.length > DISCOVER_DIAG_MAX_BYTES && file.dump) {
      // Shrink the outline until the file fits; the counts above always stay.
      const rows = file.dump.slice();
      while (rows.length > 20 && JSON.stringify({ ...file, dump: rows }).length > DISCOVER_DIAG_MAX_BYTES) rows.length = Math.floor(rows.length * 0.8);
      text = JSON.stringify({ ...file, dump: rows });
    }
    const dir = deps.diagDir ?? path.join(PROJECT_ROOT, '.jobber', 'diag');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
    let target = path.join(dir, `linkedin-discover-${i.tool}-${stamp}.json`);
    for (let n = 1; existsSync(target) && n < 100; n++) target = path.join(dir, `linkedin-discover-${i.tool}-${stamp}-${n}.json`);
    writeFileSync(target, text, { mode: 0o600 });
    try { chmodSync(target, 0o600); } catch { /* best effort */ }
    const rel = path.relative(PROJECT_ROOT, target);
    return rel.startsWith('..') ? target : rel;
  } catch {
    return null;
  }
}
