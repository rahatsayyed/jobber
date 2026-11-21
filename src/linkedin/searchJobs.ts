// Typed discovery: one NAMED LinkedIn jobs search from config/linkedin-discovery.json. The model
// supplies only the name; the URL is built in code. New jobs are persisted in code (source
// `linkedin-jobs`); the result carries counts and new job ids, never page text.
//
// Two card layouts: the older one has a /jobs/view link per card (id from the link); the newer one (seen live 14 Nov 2026) has NO job
// link and one button per card (see buttonCard.ts). For that layout the id comes, in this order, from (a) a DOM attribute of the card
// (generic scan done by the snapshot script) and (b) the real page URL after an ordinary card click (`currentJobId=<digits>`), at most
// LINKEDIN_JOB_CLICKS_PER_SEARCH clicks per search (0: the old id-only behaviour, at most 10) and never for a company+title that is already
// stored. A card with no id is counted with a reason.
//
// The same click reads the job description from the right-hand pane (jobIdResolve.ts, paneJd.ts), so a job needs no later page load for it:
// a card whose job already has a full description is not clicked at all. The left list is scrolled first (LINKEDIN_JOB_SCROLL_ROUNDS).
import { type Job } from '../db.js';
import { companyKey, titleIdentityKey } from '../reposts.js';
import { buildJobsSearchUrl, loadDiscoveryConfig, type DiscoveryConfig } from './discoveryConfig.js';
import { bump, gateCardField, runDiscovery, scrollRoundsFor, type DiscoverResult, type EnrichOut, type IdCard, type Parsed, type PendingCard } from './discoverCommon.js';
import { needsJdFetch } from '../jdComplete.js';
import { jobActedSql } from '../jdStore.js';
import { writePaneDiag } from './discoverDiag.js';
import { descriptionOf, parseButtonCard } from './buttonCard.js';
import { clickCards, jobClicksPerSearchFor, reasonCounts, resolveIdsByClick, type ClickTarget } from './jobIdResolve.js';
import { canonicalJobUrl, extractLinkedInJobId, linkedInJobDbId } from './jobIds.js';
import { cleanJobTitle } from '../lib/jobTitle.js';
import type { RawSnapshot } from './types.js';
import type { ToolDeps } from './toolDeps.js';

export interface SearchArgs { search: string }
export interface SearchOpts { config?: DiscoveryConfig }

export function parseJobCards(snap: RawSnapshot, limit: number): Parsed {
  const cards = (snap.jobCards ?? []).slice(0, limit);
  const jobs: Job[] = [];
  const pending: PendingCard[] = [];
  const idCards: IdCard[] = [];
  const ids = new Set<string>();
  const text: string[] = [];
  const rejected: Record<string, number> = {};
  const idFrom: Record<string, number> = {};
  let skipped = 0;
  let injection = false;
  const reject = (reason: string): void => { skipped++; bump(rejected, reason); };
  for (const [pos, c] of cards.entries()) {
    let title: { text: string; blocked: boolean };
    let company: { text: string; blocked: boolean };
    let snippet: { text: string; blocked: boolean };
    let from = 'link';
    let num = extractLinkedInJobId(String(c.href ?? ''));
    if (typeof c.cardName === 'string' && c.cardName) {
      // Card-as-button layout: every field comes from the accessible name.
      const bc = parseButtonCard(c.cardName, String(c.title ?? ''), c.cardLines ?? []);
      if (!bc) { reject('unparsed_card'); continue; }
      title = gateCardField(cleanJobTitle(bc.title), 160);
      company = gateCardField(bc.company, 100);
      // Each part passes the input gate on its own (the gate collapses whitespace, so the description is joined after it with
      // real newlines: its first line must stay "Location: ...", the board convention the location gates read).
      const parts = [gateCardField(bc.location, 100), gateCardField(bc.salary, 80), gateCardField(bc.meta, 300)];
      snippet = {
        blocked: parts.some((g) => g.blocked),
        text: descriptionOf({ ...bc, location: parts[0].text, salary: parts[1].text, meta: parts[2].text }).slice(0, 1500),
      };
      const hint = String(c.idHint ?? '');
      num = /^\d{6,25}$/.test(hint) ? hint : null;
      from = 'attr';
    } else {
      title = gateCardField(cleanJobTitle(c.title), 160);
      company = gateCardField(c.company, 100);
      snippet = gateCardField(c.snippet, 1500);
    }
    if (title.blocked || company.blocked || snippet.blocked) { injection = true; reject('injection'); continue; }
    if (!title.text) { reject('no_title'); continue; }
    const desc = snippet.text;
    text.push(`${title.text}\n${company.text}\n${snippet.text}`);
    if (!num) {
      if (typeof c.cardName === 'string' && c.cardName && Number.isInteger(c.cardIdx)) {
        pending.push({ cardIdx: c.cardIdx as number, title: title.text, company: company.text, description: desc, pos });
      } else reject('no_link');
      continue;
    }
    const id = linkedInJobDbId(num);
    if (ids.has(id)) { reject('duplicate'); continue; }
    ids.add(id);
    bump(idFrom, from);
    idCards.push({ id, num, ...(Number.isInteger(c.cardIdx) ? { cardIdx: c.cardIdx as number } : {}), title: title.text, pos });
    const url = canonicalJobUrl(num);
    jobs.push({ id, source: 'linkedin-jobs', title: title.text, company: company.text, url, apply_url: url, description: desc });
  }
  return { jobs, authors: [], fetched: cards.length, skipped, injection, screenText: text.join('\n'), rejected, pending, idFrom, idCards };
}

/** True when a job with this company and title is already stored (any source): such a card is never clicked. */
function knownByKeys(deps: ToolDeps, company: string, title: string): boolean {
  const ck = companyKey(company);
  const tk = titleIdentityKey(title);
  if (!ck || !tk) return false;
  return deps.db.prepare('SELECT 1 FROM jobs WHERE company_key = ? AND title_key = ? LIMIT 1').get(ck, tk) !== undefined;
}

/** True when the job has no row yet, or has one that still waits for a JD (a snippet-only description, not vetoed, not acted on). */
function jdWanted(deps: ToolDeps, id: string): boolean {
  const row = deps.db.prepare(
    `SELECT source, description, excluded_reason AS ex, status, ${jobActedSql('jobs')} AS acted FROM jobs WHERE id = ?`,
  ).get(id) as { source: string; description: string | null; ex: string | null; status: string | null; acted: number } | undefined;
  if (!row) return true;
  return needsJdFetch(row.source, row.description) && !row.ex && !row.acted && row.status !== 'duplicate' && row.status !== 'repeat_contact';
}

/**
 * Click the cards (list order), take the id of a card that has none and the description from the right-hand pane. Skips before any click:
 * a card whose job already has a full description, and a card with no id whose company+title is already stored. With
 * LINKEDIN_JOB_CLICKS_PER_SEARCH=0 only cards without an id are clicked (at most 10) and no pane is read. Failures are counted by reason.
 */
export async function resolvePending(deps: ToolDeps, p: Parsed, rand: () => number = Math.random, search = ''): Promise<EnrichOut> {
  const pending = p.pending ?? [];
  const out: EnrichOut = { jobs: [], known: 0, no_id: 0, no_id_reasons: {}, id_from: {}, clicks: 0 };
  const todo: PendingCard[] = [];
  for (const c of pending) {
    if (knownByKeys(deps, c.company, c.title)) out.known++; else todo.push(c);
  }
  const perSearch = jobClicksPerSearchFor(deps.env);
  const targets: ClickTarget[] = [];
  if (perSearch > 0) {
    for (const c of p.idCards ?? []) {
      if (!jdWanted(deps, c.id)) { out.jd_known_skipped = (out.jd_known_skipped ?? 0) + 1; continue; }
      targets.push({ pos: c.pos, id: c.num, ...(c.cardIdx !== undefined ? { cardIdx: c.cardIdx } : {}), title: c.title });
    }
  }
  for (const c of todo) targets.push({ pos: c.pos ?? 0, cardIdx: c.cardIdx, title: c.title });
  targets.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  const r = perSearch > 0
    ? await clickCards(deps, targets, { paneReads: true, maxClicks: perSearch, ceiling: true }, rand)
    : await resolveIdsByClick(deps, targets, rand);
  out.clicks = r.clicks;
  const seen = new Set((p.jobs ?? []).map((j) => j.id));
  for (const c of todo) {
    const num = r.ids.get(c.cardIdx);
    if (!num) continue;
    const id = linkedInJobDbId(num);
    if (seen.has(id)) continue;
    seen.add(id);
    bump(out.id_from, 'click');
    const url = canonicalJobUrl(num);
    out.jobs.push({ id, source: 'linkedin-jobs', title: c.title, company: c.company, url, apply_url: url, description: c.description });
  }
  out.no_id = r.failed.size;
  out.no_id_reasons = reasonCounts(r.failed);
  if (perSearch > 0) {
    out.active = true;
    out.click_failed = r.clickFailed;
    out.jd_pane_reasons = r.paneReasons;
    out.panes = [...r.panes.entries()].map(([num, pn]) => ({ id: linkedInJobDbId(num), text: pn.text, signals: pn.signals }));
    if (r.stopped) out.stopped = r.stopped;
    if (r.noPaneEver) {
      const d = await writePaneDiag({ now: deps.now, page: deps.rt.page(), ...(deps.diagDir ? { diagDir: deps.diagDir } : {}) }, { tool: 'search_jobs', search, clicks: r.clicks });
      if (d) out.pane_diag = d;
    }
  }
  return out;
}

export async function searchJobs(a: SearchArgs, deps: ToolDeps, opts: SearchOpts = {}): Promise<DiscoverResult> {
  const def = (opts.config ?? loadDiscoveryConfig()).jobs.find((j) => j.name === a?.search);
  if (!def) return { status: 'failed', code: 'unknown_search', fetched: 0, new: 0, skipped: 0, seen: 0, job_ids: [] };
  return runDiscovery({
    tool: 'search_jobs', deps, url: buildJobsSearchUrl(def), expectKind: 'jobs', searchName: def.name,
    scrollRounds: scrollRoundsFor(deps.env, 'LINKEDIN_JOB_SCROLL_ROUNDS'), scrollLimit: def.limit,
    parse: (snap) => parseJobCards(snap, def.limit),
    enrich: (p) => resolvePending(deps, p, Math.random, def.name),
  });
}
