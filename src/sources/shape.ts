// Shape checks for the script-first source runner: does the raw vendor payload still look like what the provider was written for?
// Pure and offline. Only key paths and zod issue paths/messages ever leave this module, never item values.
import { createHash } from 'node:crypto';
import type { z } from 'zod';

export interface ShapeReport { ok: boolean; hash: string; problems: string[] }

const MAX_ITEMS = 5;
const MAX_DEPTH = 4;
const MAX_ARRAY_PROBE = 3;
const MAX_PATHS = 500;
const MAX_PROBLEMS = 10;

function collectPaths(v: unknown, prefix: string, depth: number, out: Set<string>): void {
  if (depth > MAX_DEPTH || out.size >= MAX_PATHS) return;
  if (Array.isArray(v)) {
    const p = `${prefix}[]`;
    out.add(p);
    for (const el of v.slice(0, MAX_ARRAY_PROBE)) collectPaths(el, p, depth + 1, out);
    return;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      collectPaths((v as Record<string, unknown>)[k], p, depth + 1, out);
    }
  }
}

/** Parses up to 5 raw items with `spec`; the hash is the sha256 of the sorted, de-duplicated key paths of those items ('' for an empty sample). */
export function checkShape(spec: z.ZodTypeAny, sample: unknown[]): ShapeReport {
  const items = (Array.isArray(sample) ? sample : []).slice(0, MAX_ITEMS);
  if (!items.length) return { ok: true, hash: '', problems: [] };
  const paths = new Set<string>();
  const problems: string[] = [];
  items.forEach((item, i) => {
    collectPaths(item, '', 0, paths);
    const r = spec.safeParse(item);
    if (r.success) return;
    for (const issue of r.error.issues) {
      if (problems.length >= MAX_PROBLEMS) break;
      const where = issue.path.length ? issue.path.join('.') : '(item)';
      problems.push(`item ${i}: ${where}: ${issue.message}`.slice(0, 200));
    }
  });
  const hash = createHash('sha256').update([...paths].sort().join('\n')).digest('hex');
  return { ok: problems.length === 0, hash, problems };
}
