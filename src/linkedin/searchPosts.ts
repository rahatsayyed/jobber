// Typed discovery: one NAMED hiring-post search. A hiring post becomes a `linkedin-posts` job whose url is the POST
// permalink (id from the activity URN, so the same post dedupes); the author is the poster and is registered in
// `people` (category `hiring_manager`: the cadence Category enum has no poster value and its role_ask sequence fits)
// only when the profile URL verifies and the post is about hiring for the role. Page-shape guesses are unverified.
import type { Job } from '../db.js';
import { POST_SOURCE } from '../lib/postSignals.js';
import { upsertPerson } from '../outreach/people.js';
import { buildPostsSearchUrl, loadDiscoveryConfig } from './discoveryConfig.js';
import { gateCardField, runDiscovery, type DiscoverResult, type Parsed } from './discoverCommon.js';
import { canonicalProfile } from './findProfiles.js';
import {
  classifyPost, extractApplyRoute, extractCompany, extractLocation, extractRole, fallbackTitle, postRefFrom, relativeToIso, splitCardLines,
} from './postExtract.js';
import { profileKeyOf } from './urls.js';
import { verifyProfileUrl } from './verify.js';
import type { RawSnapshot } from './types.js';
import type { ToolDeps } from './toolDeps.js';
import type { SearchArgs, SearchOpts } from './searchJobs.js';

const STOP = new Set(['and', 'the', 'for', 'with', 'engineer', 'senior', 'junior']);

/** Words of the role definition (3+ chars) that a hiring post must mention at least one of. */
export function roleTokens(role: string): string[] {
  return role.toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

export function mentionsRole(text: string, role: string): boolean {
  const low = text.toLowerCase();
  return roleTokens(role).some((t) => low.includes(t));
}

const absolute = (href: string): string => (href.startsWith('/') && !href.startsWith('//') ? `https://www.linkedin.com${href}` : href);

/**
 * One job per hiring post. The job URL is the post permalink (never the author profile); the author is the
 * poster (a contact, registered in `people`), kept in `poster_url`. Each card line passes the input gate
 * before anything is parsed; a blocked line drops the card and flags injection.
 */
export function parsePostCards(snap: RawSnapshot, limit: number, role: string, now: Date = new Date()): Parsed {
  const cards = (snap.postCards ?? []).slice(0, limit);
  const jobs: Job[] = [];
  const authors: Parsed['authors'] = [];
  const ids = new Set<string>();
  const text: string[] = [];
  let skipped = 0;
  let injection = false;
  for (const c of cards) {
    const profile = canonicalProfile(String(c.profileHref ?? '').trim());
    if (!profile) { skipped++; continue; }
    const author = gateCardField(c.authorName, 80);
    const structured = !!(c.lines && c.lines.length);
    const gated = (structured ? c.lines! : [String(c.text ?? '')]).map((l) => gateCardField(l, structured ? 400 : 3000));
    if (author.blocked || gated.some((g) => g.blocked)) { injection = true; skipped++; continue; }
    const lines = gated.map((g) => g.text).filter(Boolean);
    const layout = structured ? splitCardLines(lines, author.text) : { headline: '', timeText: '', bodyLines: lines };
    const body = layout.bodyLines.join('\n').slice(0, 3000);
    if (!body.trim() || !classifyPost(body).hiring) { skipped++; continue; }
    const ref = postRefFrom(c.permalinkHref, c.urn);
    if (!ref || ids.has(ref.id)) { skipped++; continue; }
    ids.add(ref.id);

    const co = extractCompany(body, layout.headline);
    const roleTitle = extractRole(layout.bodyLines);
    const loc = extractLocation(layout.bodyLines);
    const route = extractApplyRoute(body);
    const posted = relativeToIso(layout.timeText, now);
    // Same first-line convention as board jobs, so the location gates and the matcher see it.
    const locLine = loc ? `Location: ${[loc.location, loc.remote ? '(remote)' : ''].filter(Boolean).join(' ')}\n\n` : '';
    const job: Job = {
      id: ref.id, source: POST_SOURCE, title: roleTitle || fallbackTitle(author.text), company: co.company,
      url: ref.url, apply_url: ref.url, description: (locLine + body).slice(0, 8000), poster_url: `${profile}/`,
    };
    if (posted) job.posted_at = posted;
    if (route.email) job.apply_email = route.email;
    if (route.link) job.apply_link = route.link;
    jobs.push(job);
    text.push(`${author.text}\n${layout.headline}\n${body}`);
    if (author.text && mentionsRole(body, role) && verifyProfileUrl(profile, absolute(String(c.profileHref))).ok) {
      authors.push({ profileKey: profileKeyOf(profile), name: author.text, headline: layout.headline, company: co.company });
    }
  }
  return { jobs, authors, fetched: cards.length, skipped, injection, screenText: text.join('\n') };
}

export async function searchPosts(a: SearchArgs, deps: ToolDeps, opts: SearchOpts = {}): Promise<DiscoverResult> {
  const def = (opts.config ?? loadDiscoveryConfig()).posts.find((p) => p.name === a?.search);
  if (!def) return { status: 'failed', code: 'unknown_search', fetched: 0, new: 0, skipped: 0, seen: 0, job_ids: [] };
  return runDiscovery({
    tool: 'search_posts', deps, url: buildPostsSearchUrl(def), expectKind: 'search', searchName: def.name,
    parse: (snap) => parsePostCards(snap, def.limit, def.role, deps.now()),
    afterSave: (p) => {
      for (const au of p.authors) {
        upsertPerson(deps.db, {
          platform: 'linkedin', profileKey: au.profileKey, name: au.name, headline: au.headline, company: au.company ?? '', category: 'hiring_manager',
        });
      }
      return p.authors.length;
    },
  });
}
