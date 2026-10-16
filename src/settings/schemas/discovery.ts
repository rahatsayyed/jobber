// src/settings/schemas/discovery.ts
// Schema for config/linkedin-discovery.json (named LinkedIn job and hiring-post searches). It is the loader's own zod schema
// (src/linkedin/discoveryConfig.ts), so the editor accepts exactly what the typed tools accept. The old
// config/discover-linkedin.json was removed in plan 8G Task 14.
import { discoveryConfigSchema } from '../../linkedin/discoveryConfig.js';
import { type SchemaResult, zodErrors } from './util.js';

export function validateDiscovery(raw: unknown): SchemaResult {
  const r = discoveryConfigSchema.safeParse(raw);
  if (!r.success) return { errors: zodErrors(r.error), warnings: [] };
  return { errors: [], warnings: [] };
}
