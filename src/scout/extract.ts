// Closed job-card extractor (plan 8G task 7): code picks job-like links from the anchors a page reported.
// No model decides what a job is, nothing is saved here, and page text is capped and stripped.
import { createHash } from 'node:crypto';
import type { Job } from '../db.js';
import type { RawAnchorPage } from './page.js';

const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const JOB_PATH = /(job|jobs|career|careers|position|positions|opening|openings|vacanc|requisition|posting|role|roles)/i;
const ID_SEGMENT = /(\/\d{3,}|\/[0-9a-f]{8}-[0-9a-f]{4}-|[?&](gh_jid|jid|id|jobid|job_id)=[\w-]{3,})/i;
const ROLE_WORD = /\b(engineer|developer|designer|manager|analyst|scientist|architect|lead|intern|consultant|specialist|director|administrator|tester|qa|devops|sre|programmer|officer|associate|executive|researcher|writer|recruiter)\b/i;
const NAV_TEXT = /^(home|about( us)?|contact( us)?|log ?in|sign ?in|sign ?up|register|privacy( policy)?|terms( of use)?|cookies?|careers?|jobs?|all jobs|open roles|back|next|previous|search|view all( jobs)?|apply( now)?|teams?|benefits|blog|faq|help|english|share|save)$/i;
const MAX_JOBS = 100;

export interface ExtractOptions {
  /** Platform id used for the job id and the `gen:<platform>` source. */
  platform: string;
  company: string;
  /** Hosts a job link may point to (the page host is always allowed). */
  hosts?: string[];
}

const clean = (s: string, max: number): string => String(s ?? '').replace(INVISIBLE, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function hostOk(host: string, allowed: string[]): boolean {
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

export function jobIdFor(platform: string, url: string): string {
  return `gen:${platform}:${createHash('sha1').update(url).digest('hex').slice(0, 16)}`;
}

export function extractJobs(raw: RawAnchorPage, o: ExtractOptions): Job[] {
  let pageHost = '';
  try { pageHost = new URL(raw.url).hostname.toLowerCase(); } catch { return []; }
  const allowed = [pageHost, ...(o.hosts ?? []).map((h) => h.toLowerCase())];
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const a of raw.anchors ?? []) {
    let u: URL;
    try { u = new URL(a.href); } catch { continue; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) continue;
    if (!hostOk(u.hostname.toLowerCase(), allowed)) continue;
    u.hash = '';
    const title = clean(a.text, 140);
    if (title.length < 4 || NAV_TEXT.test(title)) continue;
    const pathAndQuery = `${u.pathname}${u.search}`;
    const jobPath = JOB_PATH.test(u.pathname);
    const idLike = ID_SEGMENT.test(pathAndQuery);
    if (!(jobPath && (idLike || ROLE_WORD.test(title))) && !(idLike && ROLE_WORD.test(title))) continue;
    const url = u.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: jobIdFor(o.platform, url), source: `gen:${o.platform}`, title, company: clean(o.company, 100) || o.platform,
      url, apply_url: url, description: clean(a.context, 1500),
    });
    if (out.length >= MAX_JOBS) break;
  }
  return out;
}

/**
 * The one posting a single job page IS (a manual_url task for a job URL): title from the page title, description from the visible
 * text, url from the open page (the caller has already checked it is on the task host). Text is capped and stripped like job cards.
 * Returns null when the page has no usable title or text.
 */
export function singleJobFromPage(raw: RawAnchorPage, o: { company: string }): Job | null {
  let u: URL;
  try { u = new URL(raw.url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  u.hash = '';
  // The page title, else the first non-empty line of the visible text (often the posting's own heading).
  const firstLine = String(raw.text ?? '').split(/\r?\n/).map((l) => clean(l, 140)).find((l) => l.length >= 4) ?? '';
  const title = clean(raw.title, 140).length >= 4 ? clean(raw.title, 140) : firstLine;
  const description = clean(raw.text, 8000);
  if (title.length < 4 || description.length < 40) return null;
  const url = u.toString();
  return { id: jobIdFor('manual', url), source: 'gen:manual', title, company: clean(o.company, 100) || 'unknown', url, apply_url: url, description };
}
