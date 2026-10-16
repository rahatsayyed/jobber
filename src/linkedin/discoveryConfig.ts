// Named LinkedIn discovery searches (config/linkedin-discovery.json). The typed tools take only a
// search NAME; the URL is built here from the structured definition, never from model input.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const SEARCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;
const name = z.string().regex(SEARCH_NAME_RE);
const EXPERIENCE = ['internship', 'entry', 'associate', 'mid-senior', 'director', 'executive'] as const;

const jobDef = z.object({
  name,
  keyword: z.string().min(1).max(150),
  location: z.string().max(100).optional(),
  posted_within_seconds: z.number().int().min(60).max(31_536_000).optional(),
  remote_only: z.boolean().optional(),
  easy_apply_only: z.boolean().optional(),
  experience_level: z.enum(EXPERIENCE).optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
const postDef = z.object({
  name,
  role: z.string().min(1).max(150),
  geo: z.string().max(60).default(''),
  limit: z.number().int().min(1).max(50).default(25),
});
const configSchema = z.object({ jobs: z.array(jobDef).default([]), posts: z.array(postDef).default([]) });

export type JobSearchDef = z.infer<typeof jobDef>;
export type PostSearchDef = z.infer<typeof postDef>;
export type DiscoveryConfig = z.infer<typeof configSchema>;

const EXPERIENCE_CODES: Record<(typeof EXPERIENCE)[number], string> = {
  internship: '1', entry: '2', associate: '3', 'mid-senior': '4', director: '5', executive: '6',
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DISCOVERY_CONFIG_PATH = path.join(projectRoot, 'config', 'linkedin-discovery.json');

/** Parse and validate; a missing or invalid file yields an empty config (the tools then report unknown_search). */
export function loadDiscoveryConfig(file: string = DISCOVERY_CONFIG_PATH): DiscoveryConfig {
  try {
    return configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    console.error(`[linkedin] discovery config unusable: ${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 160)}`);
    return { jobs: [], posts: [] };
  }
}

export function buildJobsSearchUrl(d: JobSearchDef): string {
  const p = new URLSearchParams();
  p.set('keywords', d.keyword);
  if (d.location) p.set('location', d.location);
  if (d.posted_within_seconds !== undefined) p.set('f_TPR', `r${d.posted_within_seconds}`);
  if (d.remote_only) p.set('f_WT', '2');
  if (d.easy_apply_only) p.set('f_AL', 'true');
  if (d.experience_level) p.set('f_E', EXPERIENCE_CODES[d.experience_level]);
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

export function buildPostsSearchUrl(d: PostSearchDef): string {
  const keywords = `(hiring OR "we're hiring" OR "we are hiring" OR "join our team") (${d.role}) ${d.geo}`.trim();
  const p = new URLSearchParams({ keywords, origin: 'GLOBAL_SEARCH_HEADER', sortBy: '"date_posted"' });
  return `https://www.linkedin.com/search/results/content/?${p.toString()}`;
}
