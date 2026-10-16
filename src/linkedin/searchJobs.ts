// Typed discovery: one NAMED LinkedIn jobs search from config/linkedin-discovery.json. The model
// supplies only the name; the URL is built in code. New jobs are persisted in code (source
// `linkedin-jobs`); the result carries counts and new job ids, never page text.
import type { Job } from '../db.js';
import { buildJobsSearchUrl, loadDiscoveryConfig, type DiscoveryConfig } from './discoveryConfig.js';
import { gateCardField, runDiscovery, type DiscoverResult, type Parsed } from './discoverCommon.js';
import { canonicalJobUrl, extractLinkedInJobId, linkedInJobDbId } from './jobIds.js';
import type { RawSnapshot } from './types.js';
import type { ToolDeps } from './toolDeps.js';

export interface SearchArgs { search: string }
export interface SearchOpts { config?: DiscoveryConfig }

export function parseJobCards(snap: RawSnapshot, limit: number): Parsed {
  const cards = (snap.jobCards ?? []).slice(0, limit);
  const jobs: Job[] = [];
  const ids = new Set<string>();
  const text: string[] = [];
  let skipped = 0;
  let injection = false;
  for (const c of cards) {
    const num = extractLinkedInJobId(String(c.href ?? ''));
    if (!num) { skipped++; continue; }
    const id = linkedInJobDbId(num);
    if (ids.has(id)) { skipped++; continue; }
    const title = gateCardField(c.title, 160);
    const company = gateCardField(c.company, 100);
    const snippet = gateCardField(c.snippet, 1500);
    if (title.blocked || company.blocked || snippet.blocked) { injection = true; skipped++; continue; }
    if (!title.text) { skipped++; continue; }
    ids.add(id);
    const url = canonicalJobUrl(num);
    jobs.push({ id, source: 'linkedin-jobs', title: title.text, company: company.text, url, apply_url: url, description: snippet.text });
    text.push(`${title.text}\n${company.text}\n${snippet.text}`);
  }
  return { jobs, authors: [], fetched: cards.length, skipped, injection, screenText: text.join('\n') };
}

export async function searchJobs(a: SearchArgs, deps: ToolDeps, opts: SearchOpts = {}): Promise<DiscoverResult> {
  const def = (opts.config ?? loadDiscoveryConfig()).jobs.find((j) => j.name === a?.search);
  if (!def) return { status: 'failed', code: 'unknown_search', fetched: 0, new: 0, skipped: 0, seen: 0, job_ids: [] };
  return runDiscovery({
    tool: 'search_jobs', deps, url: buildJobsSearchUrl(def), expectKind: 'jobs', searchName: def.name,
    parse: (snap) => parseJobCards(snap, def.limit),
  });
}
