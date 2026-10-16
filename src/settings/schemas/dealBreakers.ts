// src/settings/schemas/dealBreakers.ts
// config/deal-breakers.json. Consumer: src/vetoes.ts loadDealBreakers (reads `keywords`, keeps trimmed non-blank strings,
// returns [] on any problem, so a mistake silently disables the veto). The editor therefore requires a string array.
import { z } from 'zod';
import { type SchemaResult, zodErrors } from './util.js';

const schema = z.object({ keywords: z.array(z.string().max(200)).max(500) });

export function validateDealBreakers(raw: unknown): SchemaResult {
  const r = schema.safeParse(raw);
  if (!r.success) return { errors: zodErrors(r.error), warnings: [] };
  const warnings: string[] = [];
  r.data.keywords.forEach((k, i) => {
    if (!k.trim()) warnings.push(`keywords[${i}]: blank, the loader drops it`);
  });
  return { errors: [], warnings };
}
