// src/settings/schemas/discovery.ts
// Structural schema for the LinkedIn discovery file (config/discover-linkedin.json, successor config/linkedin-discovery.json).
// Consumer: src/discover/linkedin-jobs.ts (DiscoverLinkedInConfig: jobs[] + posts{role, geo, limit}); it does JSON.parse
// with no validation, so a wrong type surfaces only at run time. Written from that reader and the shipped file.
import { z } from 'zod';
import { type SchemaResult, zodErrors } from './util.js';

const job = z
  .object({
    name: z.string().min(1).max(100),
    search_url: z.string().max(2000).optional(),
    keyword: z.string().max(200).optional(),
    location: z.string().max(200).optional(),
    posted_within_seconds: z.number().int().positive().max(31_536_000).optional(),
    remote_only: z.boolean().optional(),
    easy_apply_only: z.boolean().optional(),
    experience_level: z.enum(['internship', 'entry', 'associate', 'mid-senior', 'director', 'executive']).optional(),
    limit: z.number().int().min(1).max(100),
  })
  .refine((j) => !!(j.search_url?.trim() || j.keyword?.trim()), { message: 'needs a search_url or a keyword', path: ['search_url'] });

const schema = z.object({
  jobs: z.array(job).max(50),
  posts: z.object({ role: z.string().min(1).max(200), geo: z.string().min(1).max(20), limit: z.number().int().min(1).max(100) }),
});

export function validateDiscovery(raw: unknown): SchemaResult {
  const r = schema.safeParse(raw);
  if (!r.success) return { errors: zodErrors(r.error), warnings: [] };
  const warnings: string[] = [];
  r.data.jobs.forEach((j, i) => {
    if (j.search_url && /REPLACE_WITH/i.test(j.search_url)) warnings.push(`jobs[${i}].search_url: still a placeholder`);
    else if (j.search_url && !/^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(j.search_url)) warnings.push(`jobs[${i}].search_url: not a linkedin.com address`);
  });
  return { errors: [], warnings };
}
