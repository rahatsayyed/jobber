// Literal secrets held in secrets/site-accounts.json, for redaction. Passwords are secrets
// everywhere (secretValuesFromEnv); account emails are redact-only (redactSecrets), because the
// owner's own email is legitimate in outbound text. Lenient (never throws), cached by
// (path, mtimeMs, size) with one lstat per call, and a file that is a symlink or readable by
// group/other is not read at all.
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PATH = path.join(ROOT, 'secrets', 'site-accounts.json');
let pathOverride: string | null | undefined;

/** Test seam: point the reader at a temp file (or at nothing with null). undefined restores the default. */
export function setSiteAccountsPathForTests(p: string | null | undefined): void { pathOverride = p; cache = null; }

export interface SiteLiterals { emails: string[]; passwords: string[] }
const EMPTY: SiteLiterals = { emails: [], passwords: [] };
let cache: { key: string; value: SiteLiterals } | null = null;
let warned = false;
/** Test seam: forget that the loose-file warning was printed. */
export function resetSiteSecretsWarningForTests(): void { warned = false; }

export function siteAccountLiterals(env: NodeJS.ProcessEnv = process.env): SiteLiterals {
  // Under vitest the default path is never read unless a test sets one (env override or setter).
  const underTest = !!env.VITEST || !!process.env.VITEST;
  const p = pathOverride !== undefined ? pathOverride : (env.SITE_ACCOUNTS_FILE || (underTest ? null : DEFAULT_PATH));
  if (!p) return EMPTY;
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) {
      if (!warned) {
        warned = true;
        console.error('[safety] WARNING: the site accounts file is a symlink, not a regular file, or readable by others (chmod 600). It is NOT being read, so site account passwords and emails are NOT masked in logs and outbound checks. Fix it with: chmod 600 secrets/site-accounts.json');
      }
      return EMPTY;
    }
    const key = `${p}|${st.mtimeMs}|${st.size}`;
    if (cache?.key === key) return cache.value;
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, { email?: unknown; password?: unknown }>;
    const value: SiteLiterals = { emails: [], passwords: [] };
    for (const a of Object.values(j ?? {})) {
      if (typeof a?.email === 'string' && a.email.length >= 8) value.emails.push(a.email);
      if (typeof a?.password === 'string' && a.password.length >= 8) value.passwords.push(a.password);
    }
    cache = { key, value };
    return value;
  } catch { return EMPTY; }
}
