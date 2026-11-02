// Careers listing pages: reading the role links of a page that only LISTS many roles (pure code, no browser) and judging in code whether a
// role fits the owner. Owner decision 2026-11-02: the apply-operator tries its best to find the roles that fit the resume and applies to those;
// only when it finds none does the job go to the owner (reason `no_relevant_role`).
// Everything here works on page text, so every string is untrusted: cleaned, capped and screened by the caller before a model sees it.
import { cleanText } from '../dash/clean.js';
import type { RawLink } from '../webcore/formModel.js';
import { hostAllowed } from '../webcore/runtime.js';
import { findRestriction } from '../remotePolicy.js';
import { DEFAULT_TARGET_REGIONS, loadTargetRegionsStatus, mentionedTargetRegion, specificTargets, type TargetRegions } from '../targetRegions.js';

export const MAX_ROLES = 60;
export const MAX_ROLES_PER_LISTING = 3;
export type RoleKind = 'role' | 'maybe';
export interface ListedRole { role_id: string; title: string; location: string; href: string; kind: RoleKind }

const TITLE_MAX = 120;
const LOCATION_MAX = 80;
const GENERIC_LABEL = /^(apply( now| here)?|view( all)?( open)?( jobs| roles| openings| positions)?|see (all|more)( jobs| roles| openings)?|learn more|read more|home|about( us)?|contact( us)?|blog|news|careers?|jobs?|open (roles|positions|jobs)|all (jobs|roles|openings)|our (team|story|values|culture)|benefits|login|log in|sign in|sign up|register|privacy( policy)?|terms( of (use|service))?|cookie( policy| settings)?|accessibility|press|investors?|products?|pricing|support|help|faq|back( to (jobs|all jobs|listings))?|next|previous|filter|search|skip to (main )?content|menu|[a-z]{2}|\d+)$/i;
const ROLE_NOUN = /\b(engineer|developer|programmer|architect|designer|analyst|scientist|manager|lead|specialist|consultant|intern|administrator|officer|executive|associate|director|recruiter|writer|researcher)\b/i;
const JOB_PATH = /\/(?:jobs?|positions?|openings?|roles?|vacanc(?:y|ies)|postings?|opportunit(?:y|ies)|requisitions?|careers?|apply|o|j)\/[^/?#]{3,}/i;
const ID_IN_PATH = /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-/i;
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|pdf|docx?|zip|css|js|ico)(?:$|\?)/i;

const clean = (s: string, max: number): string => cleanText(s, max).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();

const withoutHash = (u: string): string => { try { const x = new URL(u); x.hash = ''; return x.href.replace(/\/$/, ''); } catch { return u; } };

/**
 * The role links of a listing page. Same-host anchors only (`allowedHosts` is the open job's host set): a link to another host is never
 * listed and so can never be opened. Role-looking links only (a job-like path or an id in the path, or a title with a job noun); navigation,
 * legal and "apply" buttons are dropped. Ordered as on the page, deduplicated by address, capped at MAX_ROLES. role_id is the ordinal r1..rN
 * of THIS page state.
 */
export function extractRoles(links: RawLink[] | undefined, pageUrl: string, allowedHosts: string[]): ListedRole[] {
  const out: ListedRole[] = [];
  const seen = new Set<string>();
  const here = withoutHash(pageUrl);
  for (const l of links ?? []) {
    const label = clean(l.label ?? '', TITLE_MAX + 40);
    if (label.length < 3 || label.length > TITLE_MAX || label.split(' ').length > 16 || GENERIC_LABEL.test(label)) continue;
    let u: URL;
    try { u = new URL(l.href); } catch { continue; }
    if (!hostAllowed(u.href, allowedHosts)) continue;
    const addr = withoutHash(u.href);
    if (addr === here || seen.has(addr) || ASSET.test(u.pathname + u.search)) continue;
    const jobLike = JOB_PATH.test(u.pathname) || ID_IN_PATH.test(u.pathname);
    const kind: RoleKind | null = jobLike ? 'role' : ROLE_NOUN.test(label) ? 'maybe' : null;
    if (!kind) continue;
    seen.add(addr);
    // The card text holds the title and, around it, the location. What is left after the title is the location (cleaned, capped).
    const ctx = clean(l.context ?? '', 300);
    const rest = ctx.includes(label) ? ctx.replace(label, ' ') : '';
    const location = clean(rest.replace(/\b(apply( now)?|view( role| job)?|learn more|full[- ]time|part[- ]time|contract)\b/gi, ' '), LOCATION_MAX);
    out.push({ role_id: '', title: label, location, href: u.href, kind });
    if (out.length >= MAX_ROLES) break;
  }
  return out.map((r, i) => ({ ...r, role_id: `r${i + 1}` }));
}

// ---- relevance: does this role fit the owner (title, seniority, location)? A coarse code floor; the operator judges the rest ----

const TITLE_POSITIVE = /(?<![a-z0-9])(?:full[\s-]?stack|react(?:\.?js)?|front[\s-]?end|mern|web (?:developer|engineer)|software (?:developer|engineer)|javascript|typescript|next\.?js|node(?:\.?js)?)(?![a-z0-9])/i;
const TITLE_NEGATIVE = /(?<![a-z0-9])(?:intern(?:ship)?|trainee|apprentice|director|vp|vice president|head of|chief|principal|manager|sales|marketing|recruit(?:er|ment)?|talent|hr|human resources|finance|accountant|legal|counsel|support|customer|designer|writer|scientist|analyst|devops|sre|qa|tester|test engineer|android|ios|mobile|embedded|firmware|hardware|security|network|sap|salesforce)(?![a-z0-9])/i;
const INDIA_PLACES = /(?<![a-z0-9])(?:india|bangalore|bengaluru|pune|mumbai|delhi|ncr|noida|gurgaon|gurugram|hyderabad|chennai|kolkata|ahmedabad|jaipur|kochi|indore|chandigarh|coimbatore|trivandrum|thiruvananthapuram|nagpur|surat|vadodara|bhubaneswar|lucknow|mysore|mysuru)(?![a-z0-9])/i;
const FOREIGN = /(?<![a-z0-9])(?:usa|united states|u\.s\.a?|united kingdom|uk|canada|germany|berlin|munich|london|paris|france|spain|madrid|barcelona|netherlands|amsterdam|ireland|dublin|poland|warsaw|portugal|lisbon|italy|sweden|stockholm|australia|sydney|melbourne|new zealand|singapore|japan|tokyo|china|brazil|mexico|argentina|europe|emea|latam|north america|new york|san francisco|seattle|austin|boston|chicago|toronto|vancouver)(?![a-z0-9])/i;
const REMOTE = /(?<![a-z0-9])(?:remote(?:ly)?|work from home|wfh|anywhere|distributed)(?![a-z0-9])/i;
const GENERIC_HEAD = new Set(['developer', 'engineer', 'software', 'senior', 'junior', 'staff', 'lead', 'stack', 'full', 'web', 'the', 'and', 'null']);

export interface RoleVerdict { ok: boolean; reason?: 'title_not_relevant' | 'title_excluded' | 'location_outside' }

/** Title words that mark the owner's own field: the resume headline and the top skills (a skill counts only with developer or engineer in the title). */
function ownTerms(resume: Record<string, unknown> | null): { head: string[]; skills: string[] } {
  const head = String(resume?.jobTitle ?? '').toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length >= 4 && !GENERIC_HEAD.has(w));
  const skills = (Array.isArray(resume?.skills) ? (resume!.skills as Array<{ items?: unknown }>) : [])
    .flatMap((s) => (Array.isArray(s?.items) ? (s.items as unknown[]) : [])).map((x) => String(x).toLowerCase().trim()).filter((x) => x.length >= 3 && x.length <= 20).slice(0, 25);
  return { head, skills };
}

export function roleRelevance(
  r: { title: string; location: string }, resume: Record<string, unknown> | null,
  regions: TargetRegions = loadTargetRegionsStatus().config ?? DEFAULT_TARGET_REGIONS,
): RoleVerdict {
  const title = String(r.title ?? '').toLowerCase();
  if (TITLE_NEGATIVE.test(title)) return { ok: false, reason: 'title_excluded' };
  const own = ownTerms(resume);
  const hasWord = (w: string): boolean => new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(title);
  const fits = TITLE_POSITIVE.test(title) || own.head.some(hasWord)
    || (/\b(developer|engineer)\b/.test(title) && own.skills.some(hasWord));
  if (!fits) return { ok: false, reason: 'title_not_relevant' };
  const loc = String(r.location ?? '').toLowerCase();
  if (loc.trim()) {
    const homeOrTarget = INDIA_PLACES.test(loc) || regions.home.some((h) => loc.includes(h.toLowerCase())) || mentionedTargetRegion(loc, specificTargets(regions.targets)) !== null;
    if (!homeOrTarget) {
      if (REMOTE.test(loc)) {
        if (!regions.remote || (!regions.remote_anywhere && FOREIGN.test(loc)) || findRestriction(loc, { scope: 'location', targets: [...regions.home, ...specificTargets(regions.targets)] })) return { ok: false, reason: 'location_outside' };
      } else if (FOREIGN.test(loc)) return { ok: false, reason: 'location_outside' };
    }
  }
  return { ok: true };
}
