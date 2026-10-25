// Wellfound company extraction, ALL GUESSES IN ONE PLACE. UNVERIFIED LIVE: no real Wellfound page was ever
// captured for these shapes. Root cause of the first live run (20 jobs, all with an empty company): the old page
// script took `card.querySelector('a[href*="/company/"], h2')` text, and a logo-only anchor or a different
// card structure gave ''. The page scripts in src/mcp/wellfound.ts now return raw ingredients only (company
// anchors with href and text or image alt, the document title, JSON-LD blobs) and THIS module decides:
//   1. an anchor to /company/<slug>: its text, else a readable name from the slug
//   2. the title pattern "<role> at <company>" (job page <title>, usually "... | Wellfound")
//   3. JSON-LD JobPosting.hiringOrganization.name
// Pure, no I/O. The result is still run through the field gate by the caller.

export const WELLFOUND_SOURCE = 'wellfound';
/** Soft gate flag for a Wellfound job saved with no company (vetoes.ts); outreach is thin without one. */
export const NO_COMPANY_FLAG = 'no company identified';
export const NO_COMPANY_REASON = 'wellfound job has no identifiable company or role';

export interface CompanyHints {
  /** Company text the page script itself read (kept for older callers and fixtures). */
  company?: unknown;
  /** Anchors to /company/<slug> found in the card or page: `[{href, text}]` (text may be an image alt or empty). */
  links?: unknown;
  /** document.title of a job page. */
  pageTitle?: unknown;
  /** Raw JSON-LD script bodies of the page. */
  jsonld?: unknown;
}

export type CompanyFrom = 'selector' | 'link_text' | 'link_slug' | 'title' | 'jsonld' | 'none';
export interface PickedCompany { name: string; from: CompanyFrom; /** https URL of the /company/<slug> page when an anchor gave one. */ link?: string }

// Anchor texts that are page chrome, not a company name.
const GENERIC_TEXT = /^(?:view|see|visit|follow|apply|share|save|company|jobs?|all jobs|company profile|view company|view profile|learn more|more|hiring|new|remote|logo)\b/i;
const NAME_MAX = 100;

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function validName(s: string): boolean {
  if (!s || s.length < 2 || s.length > 80) return false;
  if (GENERIC_TEXT.test(s)) return false;
  return /[A-Za-z]/.test(s);
}

/** The `<slug>` of a `/company/<slug>` URL on wellfound.com (absolute or site-relative), with its absolute URL, or null. */
export function companyLinkOf(href: unknown): { slug: string; url: string } | null {
  const h = str(href);
  if (!h) return null;
  try {
    const u = new URL(h, 'https://wellfound.com/');
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || (host !== 'wellfound.com' && host !== 'www.wellfound.com')) return null;
    const m = /^\/company\/([A-Za-z0-9][A-Za-z0-9._-]{0,80})(?:\/|$)/.exec(u.pathname);
    if (!m) return null;
    return { slug: m[1], url: `https://wellfound.com/company/${m[1]}` };
  } catch {
    return null;
  }
}

/** "acme-robotics" -> "Acme Robotics". A slug with no letters (an id) gives ''. */
export function companyFromSlug(slug: string): string {
  const words = slug.replace(/^\d+-/, '').split(/[-_.]+/).filter(Boolean);
  if (!words.some((w) => /[A-Za-z]/.test(w))) return '';
  return words.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w)).join(' ').slice(0, NAME_MAX);
}

/** "<role> at <company> | Wellfound" -> company (last " at "; site suffix and trailing "jobs"/"careers" words dropped). */
export function companyFromTitle(title: unknown): string {
  let t = str(title);
  if (!t) return '';
  t = t.replace(/\s*[|–—-]\s*(?:wellfound|angellist)[^|]*$/i, '').replace(/\s*[|]\s*wellfound.*$/i, '');
  const i = t.toLowerCase().lastIndexOf(' at ');
  if (i < 1) return '';
  let name = t.slice(i + 4).replace(/\s*[|–—].*$/, '').replace(/\s+-\s+.*$/, '').trim();
  name = name.replace(/\s+(?:jobs?|careers?)$/i, '').trim();
  return validName(name) ? name.slice(0, NAME_MAX) : '';
}

/** JSON-LD JobPosting.hiringOrganization.name (also inside @graph or an array); '' when absent or unparsable. */
export function companyFromJsonLd(blobs: unknown): string {
  const list = Array.isArray(blobs) ? blobs.slice(0, 6) : [];
  const visit = (n: unknown, depth: number): string => {
    if (!n || typeof n !== 'object' || depth > 4) return '';
    if (Array.isArray(n)) { for (const x of n.slice(0, 20)) { const r = visit(x, depth + 1); if (r) return r; } return ''; }
    const o = n as Record<string, unknown>;
    const org = o.hiringOrganization;
    if (org) {
      const name = typeof org === 'string' ? str(org) : str((org as Record<string, unknown>).name);
      if (validName(name)) return name.slice(0, NAME_MAX);
    }
    return visit(o['@graph'], depth + 1);
  };
  for (const b of list) {
    if (typeof b !== 'string' || b.length > 200000) continue;
    try { const r = visit(JSON.parse(b), 0); if (r) return r; } catch { /* not JSON */ }
  }
  return '';
}

/** Best company for a card or a job page, in the documented order. `name` is '' with from 'none' when nothing worked. */
export function pickCompany(h: CompanyHints | null | undefined): PickedCompany {
  if (!h || typeof h !== 'object') return { name: '', from: 'none' };
  const links = (Array.isArray(h.links) ? h.links : []).slice(0, 8).map((l) => {
    const o = (l && typeof l === 'object' ? l : {}) as { href?: unknown; text?: unknown };
    return { link: companyLinkOf(o.href), text: str(o.text) };
  }).filter((l) => l.link);
  const link = links[0]?.link?.url;
  const withLink = (name: string, from: CompanyFrom): PickedCompany => ({ name, from, ...(link ? { link } : {}) });
  const direct = str(h.company);
  if (validName(direct)) return withLink(direct.slice(0, NAME_MAX), 'selector');
  for (const l of links) if (validName(l.text)) return withLink(l.text.slice(0, NAME_MAX), 'link_text');
  for (const l of links) { const n = companyFromSlug(l.link!.slug); if (n) return withLink(n, 'link_slug'); }
  const t = companyFromTitle(h.pageTitle);
  if (t) return withLink(t, 'title');
  const j = companyFromJsonLd(h.jsonld);
  if (j) return withLink(j, 'jsonld');
  return { name: '', from: 'none' };
}
