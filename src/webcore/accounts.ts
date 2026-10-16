// Site accounts (plan 8G task 6, D13): secrets/site-accounts.json, 0600 in a 0700 dir, one unique
// code-generated password per host. Read only by typed tools inside the MCP process; a password is
// never returned from any function that is exposed as a tool. The owner's main passwords are never read.
import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_ACCOUNTS_PATH = path.join(ROOT, 'secrets', 'site-accounts.json');
const MAX_BYTES = 1024 * 1024;

export const AccountSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(8).max(200),
  created_at: z.string().min(1).max(40),
  source: z.enum(['owner', 'agent']),
  verified: z.boolean(),
});
export type SiteAccount = z.infer<typeof AccountSchema>;
const FileSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,119}$/), AccountSchema);
export type AccountsFile = z.infer<typeof FileSchema>;

export type AccountsLoad = { ok: true; accounts: AccountsFile } | { ok: false; reason: string };

/** Validates the file and its directory on every read, like checkSessionFile. A missing file is an empty store. */
export function loadAccounts(p: string = DEFAULT_ACCOUNTS_PATH, opts: { platform?: NodeJS.Platform } = {}): AccountsLoad {
  const platform = opts.platform ?? process.platform;
  const dir = path.dirname(p);
  try {
    const d = lstatSync(dir);
    if (d.isSymbolicLink()) return { ok: false, reason: 'accounts directory is a symlink' };
    if (!d.isDirectory()) return { ok: false, reason: 'accounts directory is not a directory' };
    if (platform !== 'win32' && (d.mode & 0o077) !== 0) return { ok: false, reason: 'accounts directory permissions too open (chmod 700)' };
  } catch { return { ok: true, accounts: {} }; }
  let st;
  try { st = lstatSync(p); } catch { return { ok: true, accounts: {} }; }
  if (st.isSymbolicLink()) return { ok: false, reason: 'accounts file is a symlink' };
  if (!st.isFile()) return { ok: false, reason: 'accounts file is not a regular file' };
  if (st.size > MAX_BYTES) return { ok: false, reason: 'accounts file too large' };
  if (platform !== 'win32' && (st.mode & 0o077) !== 0) return { ok: false, reason: 'accounts file permissions too open (chmod 600)' };
  try {
    const parsed = FileSchema.safeParse(JSON.parse(readFileSync(p, 'utf8')));
    if (!parsed.success) return { ok: false, reason: 'accounts file has an invalid shape' };
    return { ok: true, accounts: parsed.data };
  } catch { return { ok: false, reason: 'accounts file is not valid JSON' }; }
}

/** Normalizes a host to the key form; null when it cannot be a key. */
export function accountKey(host: string): string | null {
  const h = String(host ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.-]{0,119}$/.test(h) && h.includes('.') ? h : null;
}

/** Exact host first, then each parent down to two labels (a tenant host keeps its own entry). */
export function lookupAccount(accounts: AccountsFile, host: string): { key: string; account: SiteAccount } | null {
  const k = accountKey(host);
  if (!k) return null;
  const labels = k.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const cand = labels.slice(i).join('.');
    const a = accounts[cand];
    if (a) return { key: cand, account: a };
  }
  return null;
}

export function getAccount(host: string, p: string = DEFAULT_ACCOUNTS_PATH): { key: string; account: SiteAccount } | null {
  const l = loadAccounts(p);
  return l.ok ? lookupAccount(l.accounts, host) : null;
}

/** Atomic write: temp file 0600 in a 0700 directory, then rename. Throws a fixed message, never file content. */
export function writeAccounts(accounts: AccountsFile, p: string = DEFAULT_ACCOUNTS_PATH): void {
  const dir = path.dirname(p);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('refusing to write accounts into a symlink or non-directory');
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  const tmp = `${p}.tmp-${process.pid}`;
  try { unlinkSync(tmp); } catch { /* none */ }
  try {
    writeFileSync(tmp, JSON.stringify(accounts), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  } catch {
    if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* ignore */ } }
    throw new Error('could not write the accounts file');
  }
}

export function saveAccount(host: string, account: SiteAccount, p: string = DEFAULT_ACCOUNTS_PATH): void {
  const k = accountKey(host);
  if (!k) throw new Error('invalid account host');
  const l = loadAccounts(p);
  if (!l.ok) throw new Error(l.reason);
  writeAccounts({ ...l.accounts, [k]: AccountSchema.parse(account) }, p);
}

export function removeAccount(host: string, p: string = DEFAULT_ACCOUNTS_PATH): boolean {
  const k = accountKey(host);
  const l = loadAccounts(p);
  if (!k || !l.ok || !l.accounts[k]) return false;
  const { [k]: _gone, ...rest } = l.accounts;
  writeAccounts(rest, p);
  return true;
}

export function markVerified(host: string, p: string = DEFAULT_ACCOUNTS_PATH): boolean {
  const l = loadAccounts(p);
  const hit = l.ok ? lookupAccount(l.accounts, host) : null;
  if (!l.ok || !hit) return false;
  writeAccounts({ ...l.accounts, [hit.key]: { ...hit.account, verified: true } }, p);
  return true;
}

/** Listing for the owner CLI and status: never includes a password. */
export function listAccounts(p: string = DEFAULT_ACCOUNTS_PATH): Array<{ host: string; email: string; source: string; verified: boolean; created_at: string }> | null {
  const l = loadAccounts(p);
  if (!l.ok) return null;
  return Object.entries(l.accounts).map(([host, a]) => ({ host, email: a.email, source: a.source, verified: a.verified, created_at: a.created_at }));
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+?';

/** Unique per-site password from crypto randomness. strict: longer, at least two of every class. */
export function generatePassword(strict = false): string {
  const len = strict ? 28 : 20;
  const pick = (set: string) => set[randomInt(set.length)];
  const chars: string[] = [];
  const perClass = strict ? 2 : 1;
  for (const set of [LOWER, UPPER, DIGIT, SYMBOL]) for (let i = 0; i < perClass; i++) chars.push(pick(set));
  const all = LOWER + UPPER + DIGIT + SYMBOL;
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
