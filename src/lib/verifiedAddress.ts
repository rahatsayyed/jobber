import type BetterSqlite3 from 'better-sqlite3';

/** The bare lower-case address (the part inside angle brackets when present), or null when it is not one address. */
export function addrOf(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const t = addr.trim().toLowerCase();
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(t);
  const a = m ? m[1] : t;
  return /^[^@\s]+@[^@\s]+$/.test(a) ? a : null;
}

/** Refusal code used by every send path when an address has no verified contact. */
export const UNVERIFIED_ADDRESS = 'unverified_address';

/**
 * Safety rule 1, fail closed: an address is sendable only when a `contacts` row for that exact address (case-insensitive) has verified = 1.
 * No row, only unverified rows, an unreadable table or a malformed address all mean NOT verified. A verified `post` contact (an address written
 * in a hiring post, verified by contacts.find_company_emails) is stored in the same table, so the same check covers it.
 */
export function isVerifiedAddress(db: BetterSqlite3.Database, address: string | null | undefined): boolean {
  const a = addrOf(address);
  if (!a) return false;
  try {
    return db.prepare('SELECT 1 FROM contacts WHERE lower(trim(email)) = ? AND verified = 1 LIMIT 1').get(a) !== undefined;
  } catch {
    return false;
  }
}
