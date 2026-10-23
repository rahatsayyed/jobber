// Email contacts for a LinkedIn hiring post: the address the author wrote in the post (source `post`) plus, only when the
// company is known and not uncertain, the usual company email search. The post address is data from untrusted text: it is
// returned as a contact only, verified only when the normal verification path passes, and a free-mail host is never
// probed and never verified. Nothing here sends anything.
import { classify } from './emails.js';
import { verifyEmail } from './verify.js';
import { POST_SOURCE } from './postSignals.js';
import type { Contact } from '../db.js';

export interface PostEmailJob {
  source?: string | null;
  apply_email?: string | null;
  company?: string | null;
  company_confidence?: string | null;
}
export type Verify = (email: string, opts?: { trusted?: boolean }) => Promise<boolean>;

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me',
  'protonmail.com', 'aol.com', 'gmx.com', 'mail.com', 'yandex.com', 'rediffmail.com', 'zoho.com',
]);

/** The post author's address as a contact (source `post`), or null when the job is not a post or has no usable address. */
export async function postEmailContact(job: PostEmailJob | null | undefined, company: string, verify: Verify = verifyEmail): Promise<Contact | null> {
  if (!job || job.source !== POST_SOURCE) return null;
  const email = String(job.apply_email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) return null;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const free = FREE_MAIL.has(domain);
  // Normal verification path (MX, then SMTP probe); never trusted. A free-mail host is not probed.
  const verified = free ? false : await verify(email, { trusted: false });
  return { company, email, type: classify(email), verified, source: 'post', confidence: verified ? 0.85 : 0.2 };
}

/** A post job whose company is empty or marked uncertain: no company email search may run for it. */
export function companyUnresolved(job: PostEmailJob | null | undefined, company: string): boolean {
  if (!job || job.source !== POST_SOURCE) return false;
  return !company.trim() || job.company_confidence === 'low';
}

export interface ComposeResult { contacts: unknown[]; company_check: 'ok' | 'company_unresolved' }

/**
 * Post email first, then the company search (`gather`) only when the company is known. Verified entries come first and
 * the post address is not repeated when the search found the same one.
 */
export async function composePostContacts(
  job: PostEmailJob,
  company: string,
  gather: () => Promise<unknown[]>,
  verify: Verify = verifyEmail,
): Promise<ComposeResult> {
  const post = await postEmailContact(job, company, verify);
  const unresolved = companyUnresolved(job, company);
  const found = unresolved ? [] : await gather();
  const rest = post ? found.filter((c) => String((c as { email?: string }).email ?? '').toLowerCase() !== post.email) : found;
  const all = post ? [post, ...rest] : rest;
  const anyVerified = all.some((c) => (c as Contact).verified === true);
  const contacts = all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Number((b.c as Contact).verified === true) - Number((a.c as Contact).verified === true) || a.i - b.i)
    .map((x) => x.c);
  const flagged = !anyVerified && contacts.length > 0 ? [{ ...(contacts[0] as object), note: 'unverified - flag to human' }] : contacts;
  return { contacts: flagged, company_check: unresolved ? 'company_unresolved' : 'ok' };
}
