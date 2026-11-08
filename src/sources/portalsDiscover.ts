// Company seeding / ATS auto-discovery (idea from career-ops company seeding, own implementation).
// Resolves a company name or a careers URL to its public ATS board by probing the vendors with slug guesses through the SAME hardened
// board providers (https only, vendor host allow-lists, body caps) and prints the tracked_companies entry. A slug is kept ONLY when the
// probe returned a board with at least one posting; nothing is ever guessed into the output. Preview by default; the config is written
// only by appendPortalEntries (validated, deduped). No LLM, no database.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extraConfigProblem, slugProblem, type CompanyAts, type TrackedCompany } from './boards/filters.js';
import type { BoardFetcher } from './boards/greenhouse.js';

/** Probe order: the vendors most common for the India / Gulf / remote-first tech target first. */
export const PROBE_VENDORS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'personio'] as const;
export type ProbeVendor = (typeof PROBE_VENDORS)[number];

const COMPANY_SUFFIX = /\b(?:inc|llc|ltd|limited|pvt|private|corp|corporation|co|company|gmbh|technologies|technology|labs|software|solutions|systems|india|fzco|fze|llp)\b\.?/g;

/** Candidate slugs for a company name, most likely first. Pure; every candidate is later checked by the vendor slug rule. */
export function slugGuesses(name: string): string[] {
  const base = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const core = base.replace(COMPANY_SUFFIX, ' ').replace(/\s+/g, ' ').trim() || base;
  const out: string[] = [];
  const add = (s: string) => { if (s && !out.includes(s)) out.push(s); };
  add(core.replace(/ /g, ''));
  add(core.replace(/ /g, '-'));
  add(base.replace(/ /g, ''));
  add(base.replace(/ /g, '-'));
  return out.slice(0, 4);
}

export interface UrlHint { ats: ProbeVendor; slug: string; domain?: 'de' | 'com' }

/** Reads the vendor and slug out of an ATS or careers URL (https only). null for any other URL. Pure. */
export function parseCareersUrl(raw: string): UrlHint | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  const segRaw = u.pathname.split('/').filter(Boolean)[0];
  if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') && seg) return { ats: 'greenhouse', slug: seg };
  if ((host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') && seg) return { ats: 'lever', slug: seg };
  if (host === 'jobs.ashbyhq.com' && segRaw) return { ats: 'ashby', slug: segRaw };
  if (host === 'apply.workable.com' && seg) return { ats: 'workable', slug: seg };
  if ((host === 'careers.smartrecruiters.com' || host === 'jobs.smartrecruiters.com') && segRaw) return { ats: 'smartrecruiters', slug: segRaw };
  let m = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host);
  if (m && m[1] !== 'www') return { ats: 'recruitee', slug: m[1] };
  m = /^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/.exec(host);
  if (m) return { ats: 'personio', slug: m[1], domain: m[2] as 'de' | 'com' };
  return null;
}

export function looksLikeUrl(s: string): boolean { return /^https?:\/\//i.test(s.trim()); }

/** A probe is one (vendor, slug[, domain]) attempt. */
export interface ProbeTarget { ats: ProbeVendor; slug: string; domain?: 'de' | 'com' }

/** The ordered probe list for one company: URL hint first, then seed hint, then every vendor with every guess. Invalid slugs are dropped. */
export function probePlan(input: { name?: string; url?: string; hint?: { ats: string; slug: string }; vendors?: readonly string[] }): ProbeTarget[] {
  const vendors = (input.vendors?.length ? PROBE_VENDORS.filter((v) => input.vendors!.includes(v)) : [...PROBE_VENDORS]) as ProbeVendor[];
  const plan: ProbeTarget[] = [];
  const add = (t: ProbeTarget) => {
    if (slugProblem(t.ats, t.slug)) return;
    if (!plan.some((p) => p.ats === t.ats && p.slug === t.slug && p.domain === t.domain)) plan.push(t);
  };
  const fromUrl = input.url ? parseCareersUrl(input.url) : null;
  if (fromUrl) add(fromUrl);
  if (input.hint && (PROBE_VENDORS as readonly string[]).includes(input.hint.ats)) add({ ats: input.hint.ats as ProbeVendor, slug: input.hint.slug });
  if (input.name) {
    const guesses = slugGuesses(input.name);
    const compact = input.name.replace(/[^A-Za-z0-9]+/g, '');
    for (const v of vendors) {
      for (const g of guesses) {
        if (v === 'personio') { add({ ats: v, slug: g, domain: 'de' }); add({ ats: v, slug: g, domain: 'com' }); } else add({ ats: v, slug: g });
      }
      if (v === 'smartrecruiters' && compact) add({ ats: v, slug: compact }); // SmartRecruiters slugs can be case-sensitive
    }
  }
  return plan;
}

export interface ProbeHit { ats: ProbeVendor; slug: string; domain?: 'de' | 'com'; jobs: number }
export interface DiscoverOptions {
  /** Vendor fetchers (default: the real board providers). Tests inject fakes. */
  fetchers?: Partial<Record<CompanyAts, BoardFetcher>>;
  /** Pause between two probe requests (default 1000 ms). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Stop at the first vendor that answers (default true). */
  firstHitOnly?: boolean;
  vendors?: readonly string[];
  log?: (m: string) => void;
}
export interface DiscoverResult { input: string; hits: ProbeHit[]; entry: TrackedCompany | null; tried: number; errors: number }

/** Probes one company. The entry is built from the FIRST hit only; a hit means the board answered and has at least one posting. */
export async function discoverCompany(input: { name: string; url?: string; hint?: { ats: string; slug: string } }, opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const fetchers = opts.fetchers ?? (await import('./boards/registry.js')).FETCHERS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = opts.delayMs ?? 1000;
  const plan = probePlan({ ...input, vendors: opts.vendors });
  const hits: ProbeHit[] = [];
  let tried = 0, errors = 0;
  for (const t of plan) {
    if (tried > 0 && delay > 0) await sleep(delay);
    tried++;
    const fetcher = fetchers[t.ats];
    if (!fetcher) continue;
    const c: TrackedCompany = { name: input.name, ats: t.ats, slug: t.slug, enabled: true, ...(t.domain ? { domain: t.domain } : {}) };
    try {
      const jobs = await fetcher(c, { deadlineAt: Date.now() + 25_000, company: c });
      if (Array.isArray(jobs) && jobs.length > 0) {
        hits.push({ ats: t.ats, slug: t.slug, ...(t.domain ? { domain: t.domain } : {}), jobs: jobs.length });
        opts.log?.(`  found ${t.ats} ${t.slug}: ${jobs.length} jobs`);
        if (opts.firstHitOnly !== false) break;
      }
    } catch { errors++; }
  }
  const h = hits[0];
  const entry: TrackedCompany | null = h
    ? { name: input.name, ats: h.ats, slug: h.slug, enabled: true, ...(h.domain ? { domain: h.domain } : {}) }
    : null;
  return { input: input.name, hits, entry, tried, errors };
}

/** One-line JSON for portals.json, plus a note that says where it came from. */
export function entryLine(e: TrackedCompany, note = 'found by portals:discover (board answered with postings)'): string {
  return JSON.stringify({ name: e.name, ats: e.ats, slug: e.slug, ...(e.domain ? { domain: e.domain } : {}), enabled: true, note });
}

export interface AppendResult { added: string[]; skipped: Array<{ name: string; reason: string }> }
const norm = (s: string) => s.trim().toLowerCase();

/**
 * Appends entries to tracked_companies in the portals file as one-line objects, text-wise, so the rest of the file stays byte-identical.
 * An entry is validated (vendor slug rule, vendor extras) and deduped (same vendor + slug, or same company name). Nothing is written when
 * the result would not parse. `dryRun` returns what would happen and touches nothing.
 */
export function appendPortalEntries(file: string, entries: TrackedCompany[], opts: { dryRun?: boolean; note?: string } = {}): AppendResult {
  if (!existsSync(file)) throw new Error(`${file} not found`);
  const text = readFileSync(file, 'utf8');
  const raw = JSON.parse(text);
  if (!Array.isArray(raw?.tracked_companies)) throw new Error('tracked_companies must be an array');
  const have = raw.tracked_companies as Array<{ name?: string; ats?: string; slug?: string }>;
  const result: AppendResult = { added: [], skipped: [] };
  const lines: string[] = [];
  for (const e of entries) {
    const problem = slugProblem(e.ats, e.slug) ?? extraConfigProblem(e);
    if (problem) { result.skipped.push({ name: e.name, reason: problem }); continue; }
    const dupe = have.some((h) => (norm(String(h.ats ?? '')) === e.ats && norm(String(h.slug ?? '')) === norm(e.slug)) || norm(String(h.name ?? '')) === norm(e.name));
    if (dupe) { result.skipped.push({ name: e.name, reason: 'already in tracked_companies (same vendor and slug, or same name)' }); continue; }
    have.push({ name: e.name, ats: e.ats, slug: e.slug });
    lines.push(`    ${entryLine(e, opts.note)}`);
    result.added.push(e.name);
  }
  if (!lines.length || opts.dryRun) return result;
  const start = text.indexOf('"tracked_companies"');
  const close = start < 0 ? -1 : text.indexOf('\n  ]', start);
  if (close < 0) throw new Error('could not find the end of tracked_companies (unexpected file layout); add the lines by hand');
  const before = text.slice(0, close).replace(/\s+$/, '');
  const needsComma = !before.endsWith('[') && !before.endsWith(',');
  const next = `${before}${needsComma ? ',' : ''}\n${lines.join(',\n')}${text.slice(close)}`;
  JSON.parse(next); // never write a file that does not parse
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
  return result;
}
