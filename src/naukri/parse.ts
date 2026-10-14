// Pure Naukri snapshot parsers. No browser: the MCP layer hands over plain objects.
import { extractNaukriJobId } from '../sources/naukri.js';
import { gateInput } from '../safety/inputGate.js';

export interface RawSearchCard {
  title: string; company: string; location: string; experience?: string; salary?: string;
  href: string; postedText?: string;
}
export interface SearchResult {
  job_id: string; url: string; title: string; company: string; location: string;
  salary: string | null; posted: string | null;
}
export interface RawThread {
  threadRef: string; sender: string; company?: string; preview: string; unread: boolean; at?: string;
}

const PREVIEW_MAX = 220;

function safeNaukriUrl(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  if (!/^https:\/\//i.test(h)) return null;
  try {
    const u = new URL(h);
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'www.naukri.com' && host !== 'naukri.com') return null;
    return u.toString();
  } catch {
    return null;
  }
}

const clean = (s: unknown, max = 300): string | null => {
  if (typeof s !== 'string') return null;
  const g = gateInput(s.trim(), { maxChars: max });
  if (g.blocked) return null;
  const t = g.text.trim();
  return t.length ? t : null;
};

export function parseSearchCards(cards: RawSearchCard[], max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  for (const c of Array.isArray(cards) ? cards : []) {
    if (out.length >= limit) break;
    if (!c || typeof c !== 'object') continue;
    const url = safeNaukriUrl(c.href);
    if (!url) continue;
    const jobId = extractNaukriJobId(url);
    if (!jobId || seen.has(jobId)) continue;
    const title = clean(c.title);
    const company = clean(c.company);
    if (!title || !company) continue;
    seen.add(jobId);
    out.push({
      job_id: jobId, url, title, company,
      location: clean(c.location) ?? '',
      salary: clean(c.salary) ?? null,
      posted: clean(c.postedText, 80) ?? null,
    });
  }
  return out;
}

export function parseInbox(threads: RawThread[], max: number): RawThread[] {
  const out: RawThread[] = [];
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  for (const t of Array.isArray(threads) ? threads : []) {
    if (out.length >= limit) break;
    if (!t || typeof t.threadRef !== 'string' || !t.threadRef) continue;
    const g = gateInput(String(t.preview ?? ''), { maxChars: PREVIEW_MAX });
    const preview = g.blocked ? '[blocked]' : g.text.slice(0, PREVIEW_MAX);
    out.push({
      threadRef: t.threadRef,
      sender: clean(t.sender, 120) ?? '',
      ...(t.company !== undefined ? { company: clean(t.company, 120) ?? '' } : {}),
      preview,
      unread: Boolean(t.unread),
      ...(t.at !== undefined ? { at: String(t.at) } : {}),
    });
  }
  return out;
}
