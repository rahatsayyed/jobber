// Host hops of the browser applier (owner decision 2026-11-06). Many companies keep the careers page on one host and the application form on
// another (careers.acme.com -> boards.greenhouse.io, www.acme.com -> apply.acme.com). The page can reach the new host only through its OWN
// navigation (a click on a control the state listed, or a redirect of the stored apply URL); no tool takes a URL from the model (Safety rule 17).
// This module only DECIDES, in code, from the final page URL: pure, no I/O. The session side (updating the open job, caps, parking) is in hostGuard.ts.
//
// Allowed hop (the session continues on the new host): https, no credentials, no port, a real host name (not an IP), and either
//   (1) a known ATS vendor host: the registry apexes (src/apply/registry.ts) plus a short hop-only list of other well known vendors
//       (matched as apex or sub-domain on the parsed host name, so `greenhouse.io.evil.com` and look-alikes never match), or
//   (2) the same registrable domain (eTLD+1) as the host the job is on now (`registrableDomain`, which keeps multi-tenant hosting suffixes such as
//       github.io whole, so `a.github.io` and `b.github.io` are different).
//   (3) the hiring company's OFFICIAL site (a vendor listing that sends the applicant to persistent.com): the new host is not a vendor look-alike,
//       has no punycode label, is not a multi-tenant hosting host, and is tied to the job's company in code by at least one of
//       (a) its registrable-domain label matches the normalised company name (companyNameMatchesHost), (b) its registrable domain is a company
//       domain already on file (ctx.domains, built from contacts and earlier jobs of the same company), or (c) it is on the owner list
//       user-data/apply-hosts.json (ctx.ownerHosts; always allowed for any job).
// Anything else is refused. At most HOP_MAX (4) hops per application. Only the page the session is on NOW is judged (redirect chains and interstitials
// are given a moment to settle first, see settleTransit in hostGuard.ts): an unknown host in the middle of a chain that ends on an allowed host is fine.
// After a hop the page itself is judged too (unsafeApplyPage): payment, bank or government ID questions park the job as unsafe_apply_page. The page's own navigation is the only way a hop happens (Safety rule 17).
import { ATS_REGISTRY } from '../apply/registry.js';
import { hostMatches } from '../lib/hostClass.js';
import { isMultiTenantHost, registrableDomain } from '../lib/postingDomains.js';

export const HOP_MAX = 4;

/** Other well known ATS vendors a form is often hosted on. Used ONLY to accept a hop; a job whose own URL is on one of these is still classified by the registry. */
export const HOP_ONLY_VENDOR_APEXES: readonly string[] = [
  'icims.com', 'bamboohr.com', 'teamtailor.com', 'jobvite.com', 'breezy.hr', 'applytojob.com', 'taleo.net', 'successfactors.com',
  'successfactors.eu', 'pinpointhq.com', 'comeet.com', 'join.com', 'dayforcehcm.com', 'paylocity.com', 'rippling.com', 'gem.com',
];

export const vendorApexes = (): string[] => [...ATS_REGISTRY.flatMap((a) => a.apexes), ...HOP_ONLY_VENDOR_APEXES];

/** Registry platform id (greenhouse, lever, ...) when the host is a registry vendor host, else null. */
export function registryPlatformOfHost(host: string): string | null {
  const url = `https://${host}/`;
  return ATS_REGISTRY.find((a) => a.apexes.some((x) => hostMatches(url, x)))?.id ?? null;
}

/** The vendor apex a host belongs to (registry first), or null. */
export function vendorApexOfHost(host: string): string | null {
  const url = `https://${host}/`;
  return vendorApexes().find((x) => hostMatches(url, x)) ?? null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** What the code knows about the job's company; all optional, all filled by hostGuard from the db and user-data. Registrable domains, lower case. */
export interface HostCtx { company?: string | null; domains?: string[]; ownerHosts?: string[] }

const LEGAL_WORDS = new Set([
  'inc', 'incorporated', 'ltd', 'limited', 'pvt', 'private', 'technologies', 'technology', 'systems', 'solutions', 'llp', 'llc', 'plc', 'corp', 'corporation', 'co', 'company', 'gmbh',
]);
/** Words a company site often adds after the name (persistentsystems.com). The name label may be followed by exactly one of them, never by arbitrary text. */
const NAME_SUFFIX_WORDS = new Set([
  'systems', 'technologies', 'technology', 'tech', 'solutions', 'software', 'services', 'group', 'global', 'india', 'labs', 'corp', 'inc', 'ltd', 'limited', 'pvt', 'private',
  'holdings', 'digital', 'consulting', 'infotech', 'networks',
]);
const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Company name tokens without legal words and punctuation; if stripping leaves nothing the plain tokens are kept. */
export function companyNameParts(name: string | null | undefined): { full: string; core: string } {
  const tokens = fold(String(name ?? '')).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const core = tokens.filter((t) => !LEGAL_WORDS.has(t));
  return { full: tokens.join(''), core: (core.length > 0 ? core : tokens).join('') };
}

/** The first label of a registrable domain (persistent.com -> persistent, acme.co.uk -> acme), hyphens removed, or '' when it cannot be trusted as a name. */
function nameLabelOf(host: string): string {
  if (isMultiTenantHost(host)) return '';
  const reg = registrableDomain(host);
  const first = reg.split('.')[0] ?? '';
  return first.replace(/-/g, '');
}

/**
 * Does the registrable-domain label of `host` match the company name? Exact label (persistent = persistent.com), or the name followed by ONE known
 * suffix word (persistentsystems.com), or the plain full name (persistentsystems). The name needs at least 4 characters, so short words never match,
 * and `sage` does not match `sage-evil.com` (label sageevil, remainder `evil` is not a suffix word) or `message.com`.
 */
export function companyNameMatchesHost(company: string | null | undefined, host: string): boolean {
  const { full, core } = companyNameParts(company);
  const label = nameLabelOf(host);
  if (core.length < 4 || label.length < 4) return false;
  if (label === core || label === full) return true;
  for (const base of new Set([core, full])) {
    if (base.length >= 4 && label.startsWith(base) && NAME_SUFFIX_WORDS.has(label.slice(base.length))) return true;
    if (base.length >= 4 && label.endsWith(base) && NAME_SUFFIX_WORDS.has(label.slice(0, label.length - base.length))) return true;
  }
  return false;
}

/** A host that carries a vendor name without being that vendor (greenhouse.io.evil.com, my-icims-careers.net). Names of 5+ letters only. */
export function vendorLookAlike(host: string): boolean {
  if (vendorApexOfHost(host)) return false;
  const h = host.toLowerCase();
  return vendorApexes().some((a) => {
    const label = a.split('.')[0];
    return label.length >= 5 && h.includes(label);
  }) || /(^|[^a-z0-9])lever([^a-z0-9]|$)/.test(h);
}

export type HostVerdict =
  | { kind: 'same' }
  | { kind: 'allowed'; host: string; via: 'vendor' | 'same_domain' | 'company_name' | 'company_domain' | 'owner_list'; platform: string | null; allowedHosts: string[] }
  | { kind: 'refused'; host: string; why: 'bad_url' | 'not_https' | 'credentials' | 'port' | 'ip' | 'unknown_host' | 'too_many_hops' };

/** The host-name-only form that may be shown in a result or a note: a valid lower-case host name, else "invalid". */
export function safeHostName(h: string): string {
  const x = String(h ?? '').toLowerCase();
  return x.length <= 253 && HOST_NAME.test(x) ? x : 'invalid';
}

/**
 * Judge the page URL against the host the open job is on now. `same` means keep going as today; `allowed` is a hop the caller applies;
 * `refused` is parked by the caller (needs_owner, unknown_apply_host). Never throws.
 */
export function evaluateHost(job: { host: string; hops?: number }, pageUrl: string, ctx: HostCtx = {}): HostVerdict {
  let u: URL;
  try { u = new URL(pageUrl); } catch { return { kind: 'refused', host: 'invalid', why: 'bad_url' }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host !== '' && host === job.host) return { kind: 'same' };
  const shown = safeHostName(host);
  if (u.protocol !== 'https:') return { kind: 'refused', host: shown, why: 'not_https' };
  if (u.username || u.password) return { kind: 'refused', host: shown, why: 'credentials' };
  if (u.port !== '') return { kind: 'refused', host: shown, why: 'port' };
  if (IPV4.test(host) || host.includes(':') || host.startsWith('[')) return { kind: 'refused', host: shown, why: 'ip' };
  if (!HOST_NAME.test(host)) return { kind: 'refused', host: shown, why: 'unknown_host' };
  const apex = vendorApexOfHost(host);
  let allowed: HostVerdict | null = null;
  if (apex) {
    allowed = { kind: 'allowed', host, via: 'vendor', platform: registryPlatformOfHost(host), allowedHosts: [apex] };
  } else {
    const reg = registrableDomain(host);
    const cur = registrableDomain(job.host);
    if (reg.includes('.') && cur.includes('.') && reg === cur) allowed = { kind: 'allowed', host, via: 'same_domain', platform: null, allowedHosts: [host] };
    else if (reg.includes('.') && (ctx.ownerHosts ?? []).includes(reg)) allowed = { kind: 'allowed', host, via: 'owner_list', platform: null, allowedHosts: [host] };
    else if (reg.includes('.') && !isMultiTenantHost(host) && !host.split('.').some((l) => l.startsWith('xn--')) && !vendorLookAlike(host)) {
      if (companyNameMatchesHost(ctx.company, host)) allowed = { kind: 'allowed', host, via: 'company_name', platform: null, allowedHosts: [host] };
      else if ((ctx.domains ?? []).includes(reg)) allowed = { kind: 'allowed', host, via: 'company_domain', platform: null, allowedHosts: [host] };
    }
  }
  if (!allowed) return { kind: 'refused', host: shown, why: 'unknown_host' };
  if ((job.hops ?? 0) >= HOP_MAX) return { kind: 'refused', host: shown, why: 'too_many_hops' };
  return allowed;
}

const UNSAFE_FIELD: Array<[RegExp, string]> = [
  [/\b(credit|debit)\s*card|card\s*(number|no\b)|\bcvv\b|\bcvc\b|security\s*code|expir(y|ation)\s*date|cc-number|cc-csc|cc-exp|\bupi\b|payment|billing/i, 'payment'],
  [/aadhaar|aadhar|\bpan\s*(card|number|no)?\b|\bssn\b|social\s*security|passport\s*(number|no)|national\s*(id|identity)|government\s*id|tax\s*id|driver'?s?\s*licen[cs]e|voter\s*id/i, 'government_id'],
  [/bank\s*account|account\s*number|\bifsc\b|routing\s*number|\biban\b|\bswift\b|sort\s*code/i, 'bank'],
];

/**
 * After a host hop: does the page ask for something an application never needs? Payment card, government ID number (Aadhaar, PAN, SSN, passport,
 * national id) or bank details, judged on the visible field labels, names and autocomplete hints (never on page prose). Returns the kind or null.
 * Passwords are not judged here: a login wall or sign-up is handled by the existing needs_human rules (site_login with a stored account only).
 */
export function unsafeApplyPage(raw: { fields?: Array<{ label?: string; name?: string; autocomplete?: string; hidden?: boolean; type?: string }> } | null | undefined): string | null {
  for (const f of raw?.fields ?? []) {
    if (f.hidden || f.type === 'hidden') continue;
    const text = `${f.label ?? ''} ${f.name ?? ''} ${f.autocomplete ?? ''}`;
    for (const [re, kind] of UNSAFE_FIELD) if (re.test(text)) return kind;
  }
  return null;
}
