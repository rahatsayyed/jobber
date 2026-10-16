// Typed discovery: one NAMED hiring-post search. Posts become `linkedin-posts` jobs with company ''
// and the author profile as url. The author is registered in `people` only when the profile URL
// verifies and the post is about hiring for the role (closes G4); category `peer` because the
// cadence Category enum has no `hiring_post_author` value (ruling in the task report).
import type { Job } from '../db.js';
import { upsertPerson } from '../outreach/people.js';
import { buildPostsSearchUrl, loadDiscoveryConfig } from './discoveryConfig.js';
import { gateCardField, runDiscovery, type DiscoverResult, type Parsed } from './discoverCommon.js';
import { canonicalProfile } from './findProfiles.js';
import { buildSyntheticPostId, isHiringIntent } from './jobIds.js';
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

export function parsePostCards(snap: RawSnapshot, limit: number, role: string): Parsed {
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
    const body = gateCardField(c.text, 1500);
    const author = gateCardField(c.authorName, 80);
    if (body.blocked || author.blocked) { injection = true; skipped++; continue; }
    if (!body.text || !isHiringIntent(body.text)) { skipped++; continue; }
    // Same inputs as the old code (src/discover/linkedin-posts.ts): the stored profile url form
    // (`.../in/<slug>/`, trailing slash) and the raw card text, so old rows dedupe.
    const storedUrl = `${profile}/`;
    const id = buildSyntheticPostId(storedUrl, String(c.text ?? ''));
    if (ids.has(id)) { skipped++; continue; }
    ids.add(id);
    jobs.push({
      id, source: 'linkedin-posts', title: author.text || 'LinkedIn hiring post', company: '',
      url: storedUrl, apply_url: storedUrl, description: body.text,
    });
    text.push(`${author.text}\n${body.text}`);
    if (author.text && mentionsRole(body.text, role) && verifyProfileUrl(profile, absolute(String(c.profileHref))).ok) {
      authors.push({ profileKey: profileKeyOf(profile), name: author.text });
    }
  }
  return { jobs, authors, fetched: cards.length, skipped, injection, screenText: text.join('\n') };
}

export async function searchPosts(a: SearchArgs, deps: ToolDeps, opts: SearchOpts = {}): Promise<DiscoverResult> {
  const def = (opts.config ?? loadDiscoveryConfig()).posts.find((p) => p.name === a?.search);
  if (!def) return { status: 'failed', code: 'unknown_search', fetched: 0, new: 0, skipped: 0, seen: 0, job_ids: [] };
  return runDiscovery({
    tool: 'search_posts', deps, url: buildPostsSearchUrl(def), expectKind: 'search', searchName: def.name,
    parse: (snap) => parsePostCards(snap, def.limit, def.role),
    afterSave: (p) => {
      for (const au of p.authors) {
        upsertPerson(deps.db, { platform: 'linkedin', profileKey: au.profileKey, name: au.name, company: '', category: 'peer' });
      }
      return p.authors.length;
    },
  });
}
