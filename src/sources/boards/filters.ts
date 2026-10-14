// Adapted from career-ops-hq/career-ops title-keywords.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostMatches } from '../../lib/hostClass.js';
import { findRestriction, LOCATION_ONSITE, REGION_WORD, REMOTE_WORD } from '../../remotePolicy.js';

// Company-board vendors: one board per tracked company. Each vendor has a provider in src/sources/boards/ and an entry in registry.ts.
export const COMPANY_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio', 'workday', 'smartrecruiters'] as const;
export type CompanyAts = (typeof COMPANY_ATS)[number];
// Aggregators: one board-wide feed with many employers. They are configured in the "aggregators" object of portals.json (not in
// tracked_companies), run through the same fetch loop, caps, filters and board_status, but are never part of BOARD_SOURCES (index.ts).
export const AGGREGATOR_ATS = ['hackernews', 'himalayas', 'weworkremotely'] as const;
export type AggregatorAts = (typeof AGGREGATOR_ATS)[number];
export type Ats = CompanyAts | AggregatorAts;
export const AGGREGATOR_DEFAULTS: Record<AggregatorAts, { name: string; slug: string }> = {
  hackernews: { name: 'Hacker News Who is hiring', slug: 'whoishiring' },
  himalayas: { name: 'Himalayas', slug: 'himalayas' },
  weworkremotely: { name: 'We Work Remotely', slug: 'weworkremotely' },
};
export interface TrackedCompany {
  name: string; ats: Ats; slug: string; enabled: boolean; region?: 'eu';
  // personio: tenant host TLD (default "de")
  domain?: 'de' | 'com';
  // workday: instance label (for example "wd5"), career site name, optional server-side search text
  wd?: string; site?: string; search?: string;
  // smartrecruiters and workday: most posting detail requests per fetch; workday and himalayas: most list pages per fetch
  max_detail?: number; max_pages?: number;
}
export interface PortalsConfig {
  tracked_companies: TrackedCompany[];
  title_filter: { positive: string[]; negative: string[] };
  location_filter: { allow: string[]; global: string[]; remote_anywhere?: boolean };
}

const fold = (s: string) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Cap applied by board fetchers to each plain-text description. */
export const MAX_DESCRIPTION_CHARS = 8000;

// ---- slugs and vendor URLs ----
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export function isValidSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s) && s !== '.' && s !== '..';
}
export function assertSlug(s: string): void {
  if (!isValidSlug(s)) throw new Error(`invalid board slug ${JSON.stringify(s)}`);
}

// Vendor-specific slug rules on top of SLUG_RE. Vendors that put the slug in a hostname (recruitee, personio, workday) accept
// only lowercase letters, digits and "-" so the slug can never smuggle a dot, a path or a second host into the URL.
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const VENDOR_SLUG_RULES: Record<string, { re: RegExp; hint: string; max?: number }> = {
  workable: { re: TOKEN_SLUG_RE, hint: 'letters, digits, "_" and "-"' },
  smartrecruiters: { re: TOKEN_SLUG_RE, hint: 'letters, digits, "_" and "-"' },
  recruitee: { re: HOST_LABEL_RE, hint: 'lowercase letters, digits and inner "-", not starting or ending with "-" (the tenant subdomain)' },
  personio: { re: HOST_LABEL_RE, hint: 'lowercase letters, digits and inner "-", not starting or ending with "-" (the tenant subdomain)' },
  workday: { re: HOST_LABEL_RE, hint: 'lowercase letters, digits and inner "-", not starting or ending with "-" (the tenant), at most 40 characters', max: 40 },
};
/** null when the slug is fine for this vendor, else a short reason. */
export function slugProblem(ats: string, slug: unknown): string | null {
  if (!isValidSlug(slug)) return 'invalid slug';
  const rule = VENDOR_SLUG_RULES[ats];
  if (rule && (!rule.re.test(slug) || (rule.max !== undefined && slug.length > rule.max))) return `invalid slug (${rule.hint})`;
  return null;
}
/** Providers call this first: throws "invalid board slug ..." which settleBoard reports as a labelled error. */
export function assertVendorSlug(c: { ats: string; slug: string }): void {
  if (slugProblem(c.ats, c.slug)) throw new Error(`invalid board slug ${JSON.stringify(c.slug)}`);
}

export const WD_RE = /^wd\d{1,3}$/;
export const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** Validates the optional vendor fields of one tracked_companies entry; null when fine. */
export function extraConfigProblem(c: any): string | null {
  if (c.ats === 'workday' || c.wd !== undefined) {
    if (typeof c.wd !== 'string' || !WD_RE.test(c.wd)) return c.ats === 'workday' ? 'workday needs wd like "wd5"' : 'wd must look like "wd5"';
  }
  if (c.ats === 'workday' || c.site !== undefined) {
    if (typeof c.site !== 'string' || !SITE_RE.test(c.site)) return c.ats === 'workday' ? 'workday needs site (letters, digits, "_" and "-", at most 40)' : 'site must be letters, digits, "_" and "-", at most 40';
  }
  if ((c.ats === 'personio' || (AGGREGATOR_ATS as readonly string[]).includes(c.ats)) && c.domain !== undefined && c.domain !== 'de' && c.domain !== 'com') return 'domain must be "de" or "com"';
  if (c.search !== undefined && (typeof c.search !== 'string' || c.search.length > 100 || /[\u0000-\u001f]/.test(c.search))) return 'search must be a string of at most 100 characters';
  for (const [k, max] of [['max_detail', 100], ['max_pages', 50]] as const) {
    if (c[k] !== undefined && (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > max)) return `${k} must be an integer from 1 to ${max}`;
  }
  return null;
}
/** Keep a response-supplied URL only if it is https and on the vendor's own domain; otherwise use the canonical one. */
export function safeVendorUrl(candidate: unknown, apex: string, fallback: string): string {
  return typeof candidate === 'string' && /^https:\/\//i.test(candidate) && hostMatches(candidate, apex) ? candidate : fallback;
}

// ---- title filter ----
// A "whole word" for word:/lead: also refuses a hyphenated compound continuation ("staff" vs "staff-augmentation").
const wordRe = (k: string) => new RegExp(`(?<![a-z0-9])${esc(k)}(?![a-z0-9]|-[a-z0-9])`);
// Lead segment = text before the first "(", ",", ":", "|" or spaced dash.
const leadSegment = (t: string) => t.split(/\s[-–—|]\s|[(,:|]/)[0].trim();

function keywordMatches(title: string, raw: string): boolean {
  const k = fold(raw).trim();
  if (!k) return false;
  if (k.startsWith('lead:')) { const w = k.slice(5).trim(); return !!w && wordRe(w).test(leadSegment(title)); }
  if (k.startsWith('word:')) { const w = k.slice(5).trim(); return !!w && wordRe(w).test(title); }
  if (k.startsWith('stem:')) { const w = k.slice(5).trim(); return !!w && new RegExp(`(?<![a-z0-9])${esc(w)}`).test(title); }
  if (k.length <= 3) return new RegExp(`(?<![a-z0-9])${esc(k)}(?![a-z0-9])`).test(title);
  return title.includes(k);
}

export function titlePasses(title: string, f: { positive: string[]; negative: string[] }): boolean {
  const t = fold(title);
  if (f.negative.some((n) => keywordMatches(t, n))) return false;
  const pos = f.positive.filter((p) => p.trim());
  if (!pos.length) return true;
  return pos.some((p) => p.split('+').map((x) => x.trim()).filter(Boolean).every((part) => keywordMatches(t, part)));
}

// ---- location filter: allow term, or a bare/global remote segment ----
const wordIn = (hay: string, term: string) => new RegExp(`(?<![a-z0-9])${esc(fold(term).trim())}(?![a-z0-9])`).test(hay);
const EXCLUDER = /(?<![a-z])(?:excl|excluding|except|outside)(?![a-z])/;
const FILLER = ['only', 'fully', 'based'];

function isBareGlobal(seg: string, globals: string[]): boolean {
  let rest = seg;
  for (const g of [...globals, ...FILLER].filter((x) => x.trim()).sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(`(?<![a-z0-9])${esc(fold(g).trim())}(?![a-z0-9])`, 'g'), ' ');
  }
  return rest.replace(/[^a-z0-9]+/g, '') === '';
}

// With remote_anywhere on, "not open to India" and "other than India" also exclude a segment even though it names an allowed place.
const INDIA_EXCLUDER = /(?<![a-z])(?:(?:other than|no|not|excluding)\s+india|not (?:open|available) (?:to|in)\s+(?:[a-z]+\s+){0,3}?india)/;

/**
 * `f.remote_anywhere` (default false): a remote posting (the `remote` flag or a remote word in the segment) based in any other place passes
 * unless the segment carries a restriction marker (src/remotePolicy.ts, shared with the veto backstop). Off = the plan 4 behaviour exactly.
 */
export function locationAllowed(locations: string[] | null | undefined, remote: boolean, f: { allow: string[]; global: string[]; remote_anywhere?: boolean }): boolean {
  let segs = (Array.isArray(locations) && locations.length ? locations : ['']).flatMap((l) => fold(l).split(';')).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) segs = [''];
  if (f.remote_anywhere !== true) {
    for (const seg of segs) {
      if (EXCLUDER.test(seg)) continue;
      if (f.allow.some((a) => a.trim() && wordIn(seg, a))) return true;
      if (remote && isBareGlobal(seg, f.global)) return true;
    }
    return false;
  }
  // remote_anywhere on. 1) an allow-listed segment that is not an exclusion passes. 2) An exclusion segment ("excl. India", "not India")
  // or an on-site/office/HQ/hybrid word in ANY segment vetoes everything else ("Remote; Berlin; Onsite", "Remote-first, Berlin HQ").
  // 3) otherwise a bare remote segment passes, and so does a remote segment naming another place unless it carries a restriction
  // marker (shared with the veto backstop; allow-listed places cancel a marker) or is a bare continent/region ("Remote, Europe").
  const bad = (s: string) => EXCLUDER.test(s) || INDIA_EXCLUDER.test(s);
  for (const seg of segs) if (!bad(seg) && f.allow.some((a) => a.trim() && wordIn(seg, a))) return true;
  if (segs.some((s) => bad(s) || LOCATION_ONSITE.test(s))) return false;
  for (const seg of segs) if (remote && isBareGlobal(seg, f.global)) return true;
  const open = (s: string) => !/(?<![a-z])(?:worldwide|global|anywhere in the world)(?![a-z])/.test(s);
  return segs.some((seg) => (remote || REMOTE_WORD.test(seg)) && !findRestriction(seg, { scope: 'location', targets: f.allow }) && !(REGION_WORD.test(seg) && open(seg)));
}

// ---- HTML to text ----
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
};
/** One regex pass: decodes numeric and the named entities above; unknown or invalid ones are left as written. */
export function decodeOnce(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,15}));/gi, (m, d, h, n) => {
    if (d !== undefined || h !== undefined) {
      const cp = d !== undefined ? parseInt(d, 10) : parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[String(n).toLowerCase()];
    return v === undefined ? m : v;
  });
}
const MAX_HTML_CHARS = 200000;
const MAX_TAG_CHARS = 2000;
const lowerAscii = (x: string) => x.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/** Linear check: is there an escaped tag ("&lt;" + letter or "/" ... "&gt;" within MAX_TAG_CHARS)? */
function hasEscapedTag(h: string): boolean {
  let gt = -2; // cached position of the next "&gt;" at or after the scan point
  let i = h.indexOf('&lt;');
  while (i !== -1) {
    const c = h[i + 4] ?? '';
    if (isLetter(c) || c === '/') {
      if (gt < i) { gt = h.indexOf('&gt;', i); if (gt === -1) return false; }
      if (gt - i <= MAX_TAG_CHARS) return true;
    }
    i = h.indexOf('&lt;', i + 4);
  }
  return false;
}

/** Single-pass tag stripper. A "<" opens a tag only before a letter, "/", "!" or "?" and a ">" within MAX_TAG_CHARS; script/style content is dropped. */
function stripTags(h: string): string {
  const low = lowerAscii(h);
  let out = '';
  let gt = -2;
  let noGt = false; // once no ">" exists after some position, none exists after any later one: cache that so unmatched "<" runs stay linear
  let i = 0;
  while (i < h.length) {
    const c = h[i];
    if (c !== '<') { out += c; i++; continue; }
    const n = h[i + 1] ?? '';
    if (!(isLetter(n) || n === '/' || n === '!' || n === '?')) { out += c; i++; continue; }
    if (noGt) { out += c; i++; continue; }
    if (gt < i) { gt = h.indexOf('>', i); if (gt === -1) { noGt = true; out += c; i++; continue; } }
    if (gt - i > MAX_TAG_CHARS) { out += c; i++; continue; }
    const m = /^<(script|style)(?![a-z0-9])/.exec(low.slice(i, i + 10));
    if (m) {
      const close = low.indexOf(`</${m[1]}`, gt + 1);
      if (close === -1) { out += ' '; break; }
      const end = low.indexOf('>', close);
      out += ' ';
      i = end === -1 ? h.length : end + 1;
      continue;
    }
    out += ' ';
    i = gt + 1;
  }
  return out;
}

/** Greenhouse `content` is escaped HTML: remove that escaping layer once, strip tags, then decode the text's entities once. Linear time. */
export function htmlToPlain(s: string): string {
  let html = String(s ?? '').slice(0, MAX_HTML_CHARS);
  if (hasEscapedTag(html)) html = decodeOnce(html);
  return decodeOnce(stripTags(html)).replace(/\s+/g, ' ').trim();
}

// ---- config ----
const defaultPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'config', 'portals.json');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const DEFAULT_GLOBAL = ['remote', 'anywhere', 'worldwide', 'global'];

/** `warnings` has one string per dropped invalid tracked_companies entry (present only when a config was parsed). */
export function loadPortals(file: string = defaultPath): { config: PortalsConfig | null; error: string | null; warnings?: string[] } {
  if (!existsSync(file)) return { config: null, error: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const bad = (why: string) => ({ config: null, error: `config/portals.json: ${why}` });
    const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(raw)) return bad('top level must be an object');
    if (!Array.isArray(raw.tracked_companies)) return bad('tracked_companies must be an array');
    if (!isObj(raw.title_filter) || !Array.isArray(raw.title_filter.positive) || !Array.isArray(raw.title_filter.negative)) return bad('title_filter.positive and title_filter.negative must be arrays');
    if (!strs(raw.title_filter.positive).some((x) => x.trim())) return bad('title_filter.positive must not be empty');
    if (!isObj(raw.location_filter) || !Array.isArray(raw.location_filter.allow)) return bad('location_filter.allow must be an array');
    if (!strs(raw.location_filter.allow).some((x) => x.trim())) return bad('location_filter.allow must not be empty');
    if (raw.location_filter.global !== undefined && !Array.isArray(raw.location_filter.global)) return bad('location_filter.global must be an array');
    const warnings: string[] = [];
    const tracked = (Array.isArray(raw?.tracked_companies) ? raw.tracked_companies : [])
      .filter((c: any, i: number) => {
        const label = `config/portals.json: tracked_companies[${i}]${c && typeof c.name === 'string' ? ` (${c.name.slice(0, 60)})` : ''} skipped`;
        if (!c || typeof c.name !== 'string') { warnings.push(`${label}: missing name`); return false; }
        if (!(COMPANY_ATS as readonly string[]).includes(c.ats)) { warnings.push(`${label}: unknown ats ${JSON.stringify(c.ats)}`); return false; }
        const sp = typeof c.slug === 'string' ? slugProblem(c.ats, c.slug.trim()) : 'invalid slug';
        if (sp) { warnings.push(`${label}: ${sp}`); return false; }
        const xp = extraConfigProblem(c);
        if (xp) { warnings.push(`${label}: ${xp}`); return false; }
        return true;
      })
      .map((c: any): TrackedCompany => ({
        name: c.name, ats: c.ats as Ats, slug: c.slug.trim(), enabled: c.enabled === true,
        ...(c.region === 'eu' ? { region: 'eu' as const } : {}),
        ...(c.domain === 'de' || c.domain === 'com' ? { domain: c.domain as 'de' | 'com' } : {}),
        ...(typeof c.wd === 'string' ? { wd: c.wd } : {}),
        ...(typeof c.site === 'string' ? { site: c.site } : {}),
        ...(typeof c.search === 'string' && c.search.trim() ? { search: c.search.trim() } : {}),
        ...(Number.isInteger(c.max_detail) ? { max_detail: c.max_detail as number } : {}),
        ...(Number.isInteger(c.max_pages) ? { max_pages: c.max_pages as number } : {}),
      }));
    // "aggregators": { "<name>": { "enabled": true, "max_pages"?: n } } becomes one pseudo company per known aggregator.
    const aggs: TrackedCompany[] = [];
    if (raw.aggregators !== undefined) {
      if (!isObj(raw.aggregators)) warnings.push('config/portals.json: aggregators must be an object, ignored');
      else {
        for (const [key, v] of Object.entries(raw.aggregators)) {
          const label = `config/portals.json: aggregators.${key.slice(0, 40)} skipped`;
          if (!(AGGREGATOR_ATS as readonly string[]).includes(key)) { warnings.push(`${label}: unknown aggregator`); continue; }
          if (!isObj(v)) { warnings.push(`${label}: must be an object`); continue; }
          const xp = extraConfigProblem({ ...v, ats: key });
          if (xp) { warnings.push(`${label}: ${xp}`); continue; }
          aggs.push({ ...AGGREGATOR_DEFAULTS[key as AggregatorAts], ats: key as Ats, enabled: v.enabled === true, ...(Number.isInteger(v.max_pages) ? { max_pages: v.max_pages as number } : {}) });
        }
      }
    }
    return {
      config: {
        tracked_companies: [...tracked, ...aggs],
        title_filter: { positive: strs(raw?.title_filter?.positive), negative: strs(raw?.title_filter?.negative) },
        location_filter: {
          allow: strs(raw?.location_filter?.allow),
          global: Array.isArray(raw?.location_filter?.global) ? strs(raw.location_filter.global) : DEFAULT_GLOBAL,
          // only the boolean true turns it on; absent or invalid = false
          remote_anywhere: raw?.location_filter?.remote_anywhere === true,
        },
      },
      error: null,
      warnings,
    };
  } catch (e: any) {
    return { config: null, error: `config/portals.json: ${e?.message ?? e}` };
  }
}
