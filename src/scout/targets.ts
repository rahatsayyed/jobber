// Where a source_tasks row points (plan 8G task 7). The host comes from code (the vendor board URL built
// from the owner's portals.json entry, or a `custom` entry's own url), never from a model-supplied string.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORTALS_PATH = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'config', 'portals.json');

export interface TaskRow { id: number; platform: string; company: string | null; reason: string; state: string }
export interface TaskTarget { url: string; hosts: string[]; platform: string; company: string }

/** Vendor board hosts a scout may open (the "registry host" rule). */
export const VENDOR_HOSTS: readonly string[] = [
  'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'apply.workable.com',
  'jobs.smartrecruiters.com',
];
const VENDOR_SUFFIXES = ['recruitee.com', 'myworkdayjobs.com', 'jobs.personio.de', 'jobs.personio.com'];

export function isVendorHost(host: string): boolean {
  const h = host.toLowerCase();
  return VENDOR_HOSTS.includes(h) || VENDOR_SUFFIXES.some((s) => h.endsWith(`.${s}`));
}

function safeHttps(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  u.hash = '';
  return u;
}

function loadPortals(file: string): { tracked: any[] } {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { tracked: Array.isArray(raw?.tracked_companies) ? raw.tracked_companies : [] };
  } catch {
    return { tracked: [] };
  }
}

/** The owner's `custom` entries: `{name, ats: "custom", url, enabled}`; url must be https. */
export function customSites(file: string = DEFAULT_PORTALS_PATH): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  for (const c of loadPortals(file).tracked) {
    if (!c || c.ats !== 'custom' || c.enabled !== true || typeof c.name !== 'string') continue;
    const u = safeHttps(c.url);
    if (u) out.push({ name: c.name.slice(0, 100), url: u.toString() });
  }
  return out;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function vendorUrl(c: any): URL | null {
  const slug = typeof c.slug === 'string' ? c.slug.trim() : '';
  if (!SLUG.test(slug)) return null;
  switch (c.ats) {
    case 'greenhouse': return safeHttps(`https://boards.greenhouse.io/${slug}`);
    case 'lever': return safeHttps(`https://jobs.lever.co/${slug}`);
    case 'ashby': return safeHttps(`https://jobs.ashbyhq.com/${slug}`);
    case 'workable': return safeHttps(`https://apply.workable.com/${slug}`);
    case 'smartrecruiters': return safeHttps(`https://jobs.smartrecruiters.com/${slug}`);
    case 'recruitee': return safeHttps(`https://${slug.toLowerCase()}.recruitee.com`);
    case 'personio': return safeHttps(`https://${slug.toLowerCase()}.jobs.personio.${c.domain === 'com' ? 'com' : 'de'}`);
    case 'workday':
      return typeof c.wd === 'string' && typeof c.site === 'string' && /^wd\d{1,2}$/.test(c.wd) && SLUG.test(c.site)
        ? safeHttps(`https://${slug.toLowerCase()}.${c.wd}.myworkdayjobs.com/${c.site}`) : null;
    default: return null;
  }
}

export function resolveTaskTarget(row: TaskRow, portalsPath: string = DEFAULT_PORTALS_PATH): TaskTarget | null {
  if (!row.company) return null;
  const company = row.company.toLowerCase();
  if (row.platform === 'custom') {
    const hit = customSites(portalsPath).find((s) => s.name.toLowerCase() === company);
    if (!hit) return null;
    const u = new URL(hit.url);
    return { url: hit.url, hosts: [u.hostname.toLowerCase()], platform: 'custom', company: hit.name };
  }
  const c = loadPortals(portalsPath).tracked.find((x) => x && x.ats === row.platform && typeof x.name === 'string' && x.name.toLowerCase() === company);
  if (!c) return null;
  const u = vendorUrl(c);
  if (!u) return null;
  const hosts = [u.hostname.toLowerCase()];
  if (c.ats === 'greenhouse') hosts.push('job-boards.greenhouse.io');
  return { url: u.toString(), hosts, platform: row.platform, company: c.name };
}
