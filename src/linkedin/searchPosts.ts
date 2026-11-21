// Typed discovery: one NAMED hiring-post search. A hiring post becomes a `linkedin-posts` job whose id is the post id from the
// activity URN when the page has one, else a hash of the author and the first 120 characters of the text (content search shows no
// permalink, so the same post still dedupes); the author is the poster and is registered in
// `people` (category `hiring_manager`: the cadence Category enum has no poster value and its role_ask sequence fits)
// only when the profile URL verifies and the post is about hiring for the role. Page-shape guesses are unverified.
import type { Job } from '../db.js';
import { isFreeMail } from '../lib/postEmail.js';
import { POST_SOURCE } from '../lib/postSignals.js';
import { upsertPerson } from '../outreach/people.js';
import { buildPostsSearchUrl, loadDiscoveryConfig } from './discoveryConfig.js';
import { bump, gateCardField, runDiscovery, scrollRoundsFor, type DiscoverResult, type Parsed } from './discoverCommon.js';
import { canonicalProfile } from './findProfiles.js';
import {
  classifyPost, extractApplyRoute, extractCompany, extractLocation, extractRole, fallbackTitle, postRefFrom, relativeToIso, splitCardLines,
  syntheticPostRef,
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

// An author page that is a job board or an aggregator account, never a company hiring for itself.
const BOARD_AUTHOR = /\b(?:jobs?|careers?|openings?|vacanc(?:y|ies)|job ?(?:board|alerts?|updates?|portal)|hiring (?:alerts?|updates?)|walk-?ins?)\b/i;
// More outbound links than this in one post means a list of jobs (an aggregator), not one hiring post.
export const AGGREGATOR_LINKS = 5;
const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
// "Jane Doe, Hiring Verified Profile 2nd" and similar tails that an accessible name adds to the author.
const cleanAuthor = (n: string): string => n.replace(/,?\s*(?:hiring\b.*|verified profile.*|\d(?:st|nd|rd)\+?)$/i, '').replace(/\s+/g, ' ').trim();

/**
 * One job per hiring post. The post identity is the permalink or urn when the page has one, else a hash of the author and the
 * first 120 characters of the text. The author is a person (registered as the poster) or a company page (company only). The poster
 * is kept in `poster_url`. Each card line passes the input gate before anything is parsed; a blocked line drops the card and flags
 * injection. Every dropped card is counted by reason in `rejected` (no_profile, injection, aggregator, empty_body, seeker,
 * not_hiring, no_role, duplicate).
 */
export function parsePostCards(snap: RawSnapshot, limit: number, role: string, now: Date = new Date()): Parsed {
  const cards = (snap.postCards ?? []).slice(0, limit);
  const jobs: Job[] = [];
  const authors: Parsed['authors'] = [];
  const ids = new Set<string>();
  const text: string[] = [];
  const rejected: Record<string, number> = {};
  let skipped = 0;
  let injection = false;
  const reject = (reason: string): void => { skipped++; bump(rejected, reason); };
  for (const c of cards) {
    const href = String(c.profileHref ?? '').trim();
    const profile = canonicalProfile(href);
    const companySlug = !profile ? /^(?:https:\/\/(?:[a-z0-9-]+\.)?linkedin\.com)?\/company\/([^/?#]+)/i.exec(href)?.[1] : undefined;
    if (!profile && !companySlug) { reject('no_profile'); continue; }
    const authorUrl = profile ?? `https://www.linkedin.com/company/${companySlug}`;
    const author = gateCardField(cleanAuthor(String(c.authorName ?? '')), 80);
    const cName = gateCardField(c.companyName, 100);
    const structured = !!(c.lines && c.lines.length);
    const gated = (structured ? c.lines! : [String(c.text ?? '')]).map((l) => gateCardField(l, structured ? 400 : 3000));
    if (author.blocked || cName.blocked || gated.some((g) => g.blocked)) { injection = true; reject('injection'); continue; }
    // An aggregator (a list of job links, or a job-board page as the author) is not one hiring post.
    if ((c.outLinks ?? 0) > AGGREGATOR_LINKS || (!profile && BOARD_AUTHOR.test(author.text || cName.text))) { reject('aggregator'); continue; }
    const lines = gated.map((g) => g.text).filter(Boolean);
    const layout = structured ? splitCardLines(lines, author.text) : { headline: '', timeText: '', bodyLines: lines };
    const body = layout.bodyLines.join('\n').slice(0, 3000);
    if (!body.trim()) { reject('empty_body'); continue; }
    const verdict = classifyPost(body);
    // A Hiring badge on the author lifts a plain "not hiring" verdict, but only when the post still names a role (seekers stay out).
    const lifted = !verdict.hiring && verdict.reason === 'not_hiring' && !!c.hiringBadge && !!extractRole(layout.bodyLines);
    if (!verdict.hiring && !lifted) { reject(verdict.hiring ? 'not_hiring' : verdict.reason); continue; }
    const ref = postRefFrom(c.permalinkHref, c.urn) ?? syntheticPostRef(authorUrl, body);
    if (ids.has(ref.id)) { reject('duplicate'); continue; }
    ids.add(ref.id);

    // Company: a company page's own name; for a person the post text, then the headline, then a company link on the card.
    const fromText = extractCompany(body, layout.headline);
    const company = !profile ? (cName.text || author.text) : (fromText.company || cName.text);
    const roleTitle = extractRole(layout.bodyLines);
    const loc = extractLocation(layout.bodyLines);
    const route = extractApplyRoute(body);
    const posted = relativeToIso(layout.timeText, now);
    // Same first-line convention as board jobs, so the location gates and the matcher see it.
    const locLine = loc ? `Location: ${[loc.location, loc.remote ? '(remote)' : ''].filter(Boolean).join(' ')}\n\n` : '';
    const job: Job = {
      id: ref.id, source: POST_SOURCE, title: roleTitle || fallbackTitle(author.text), company,
      url: ref.url, apply_url: ref.url, description: (locLine + body).slice(0, 8000),
      ...(profile ? { poster_url: `${profile}/` } : {}),
    };
    if (posted) job.posted_at = posted;
    // Emails: mailto links of the card first (a non-free-mail one before a free-mail one), then the first address in the text.
    const mails = (c.mailtos ?? [])
      .map((m) => gateCardField(m, 120))
      .filter((g) => !g.blocked)
      .map((g) => g.text.trim().toLowerCase())
      .filter((m) => EMAIL_SHAPE.test(m));
    const email = mails.find((m) => !isFreeMail(m)) ?? mails[0] ?? route.email;
    if (email) job.apply_email = email;
    if (route.link) job.apply_link = route.link;
    jobs.push(job);
    text.push(`${author.text}\n${layout.headline}\n${body}`);
    if (profile && author.text && mentionsRole(body, role) && verifyProfileUrl(profile, absolute(href)).ok) {
      authors.push({ profileKey: profileKeyOf(profile), name: author.text, headline: layout.headline, company });
    }
  }
  return { jobs, authors, fetched: cards.length, skipped, injection, screenText: text.join('\n'), rejected };
}

export async function searchPosts(a: SearchArgs, deps: ToolDeps, opts: SearchOpts = {}): Promise<DiscoverResult> {
  const def = (opts.config ?? loadDiscoveryConfig()).posts.find((p) => p.name === a?.search);
  if (!def) return { status: 'failed', code: 'unknown_search', fetched: 0, new: 0, skipped: 0, seen: 0, job_ids: [] };
  return runDiscovery({
    tool: 'search_posts', deps, url: buildPostsSearchUrl(def), expectKind: 'search', searchName: def.name, narrow: def.narrow === true,
    scrollRounds: scrollRoundsFor(deps.env), scrollLimit: def.limit,
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
