// Small helpers shared by the tenant-board providers added from career-ops (bamboohr, breezy, pinpoint, gem, comeet, eightfold, oraclecloud, ...).
import { toIsoDay } from '../../db.js';
import { htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_ID_CHARS, type BoardJob } from './greenhouse.js';

export const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
export const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);

export interface JobParts {
  prefix: string; source: string; c: TrackedCompany; key: string; title: string; url: string;
  description?: string; html?: boolean; posted?: unknown; locations: string[]; remote?: boolean;
}
/** One BoardJob, or null when the id would be too long. `url` must already be vetted (boardUrl) for the vendor host. */
export function buildJob(p: JobParts): BoardJob | null {
  const id = `${p.prefix}:${p.c.slug}:${p.key}`;
  if (id.length > MAX_ID_CHARS) return null;
  const posted = toIsoDay(p.posted);
  const description = capDescription(p.html === false ? (p.description ?? '') : htmlToPlain(p.description ?? ''));
  const locations = [...new Set(p.locations.map((l) => l.trim()).filter(Boolean))].map(clip);
  return {
    id, source: p.source, title: clip(p.title), company: p.c.name, url: p.url, apply_url: p.url, description,
    ...(posted ? { posted_at: posted } : {}),
    locations, remote: p.remote === true || locations.some((l) => /remote/i.test(l)),
  };
}
