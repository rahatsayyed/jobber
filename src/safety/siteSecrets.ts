// Literal secrets held in secrets/site-accounts.json (account emails and passwords), for redaction.
// Lenient on purpose (no validation, never throws): redaction must work even on a damaged file.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function siteAccountLiterals(env: NodeJS.ProcessEnv = process.env): string[] {
  const p = env.SITE_ACCOUNTS_FILE || path.join(ROOT, 'secrets', 'site-accounts.json');
  const out: string[] = [];
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, { email?: unknown; password?: unknown }>;
    for (const a of Object.values(j ?? {})) {
      for (const v of [a?.email, a?.password]) if (typeof v === 'string' && v.length >= 8) out.push(v);
    }
  } catch { /* missing or unreadable: nothing to add */ }
  return out;
}
