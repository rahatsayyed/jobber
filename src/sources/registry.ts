// Platform registry: one list of every job source (config/platforms.json). Tenants and company entries stay in
// config/portals.json; `enabled` for a tenant board is still decided per company there (exactly `true`).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type PlatformKind = 'board' | 'aggregator' | 'api' | 'search' | 'linkedin' | 'naukri' | 'generated';
export interface PlatformDef {
  id: string; kind: PlatformKind; label: string;
  /** Module path under src/sources, or null for operator-only sources (LinkedIn). */
  provider: string | null;
  /** script: a deterministic provider exists; agent: operator-only. */
  tier: 'script' | 'agent';
  enabled: boolean; stability: 'unverified' | 'fixture' | 'live_ok' | 'flaky';
  attribution?: { source: string; license: string; url: string };
}

const rowSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  kind: z.enum(['board', 'aggregator', 'api', 'search', 'linkedin', 'naukri', 'generated']),
  label: z.string().min(1).max(100),
  provider: z.string().min(1).max(100).nullable(),
  tier: z.enum(['script', 'agent']),
  enabled: z.boolean(),
  stability: z.enum(['unverified', 'fixture', 'live_ok', 'flaky']),
  attribution: z.object({ source: z.string(), license: z.string(), url: z.string() }).strict().optional(),
}).strict().refine((r) => r.tier !== 'script' || r.provider !== null, { message: 'a script platform needs a provider' });

export const DEFAULT_REGISTRY_PATH = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'config', 'platforms.json');

/** Never throws: a bad file or row becomes an entry in `errors`; valid rows still load. */
export function loadRegistry(file: string = DEFAULT_REGISTRY_PATH): { platforms: PlatformDef[]; errors: string[] } {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e: any) {
    return { platforms: [], errors: [`config/platforms.json: ${String(e?.message ?? e).slice(0, 200)}`] };
  }
  if (!raw || !Array.isArray(raw.platforms)) return { platforms: [], errors: ['config/platforms.json: "platforms" must be an array'] };
  const platforms: PlatformDef[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.platforms.forEach((row: unknown, i: number) => {
    const id = row && typeof (row as any).id === 'string' ? (row as any).id.slice(0, 40) : '?';
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) {
      errors.push(`config/platforms.json: platforms[${i}] (${id}) skipped: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      return;
    }
    if (seen.has(parsed.data.id)) { errors.push(`config/platforms.json: platforms[${i}] (${id}) skipped: duplicate id`); return; }
    seen.add(parsed.data.id);
    platforms.push(parsed.data as PlatformDef);
  });
  return { platforms, errors };
}
