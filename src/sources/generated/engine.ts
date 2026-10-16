// Fixed interpreter for declarative provider specs (plan 8G task 8). Input is the spec (validated data) and fetched page text;
// output is jobs. Nothing here evaluates, requires or imports spec content; selectors go through the closed matcher below.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toIsoDay, type Job } from '../../db.js';
import { parseHtml, textOf, type HtmlNode } from '../../linkedin/htmlVisible.js';
import { isSafeSelector, jsonPathSegments } from '../../lib/safeSelector.js';
import type { Provider } from '../provider.js';
import { apexHosts, getText } from '../boards/transport.js';
import { hostAllowed, type FieldLocator, type ProviderSpec } from './spec.js';

// ---- selector matcher (closed grammar from isSafeSelector) ----
interface Comp { tag?: string; id?: string; classes: string[]; attrs: Array<{ name: string; value?: string }> }

function parseCompound(p: string): Comp {
  const c: Comp = { classes: [], attrs: [] };
  const tag = /^[a-z][a-z0-9]*/.exec(p);
  let i = 0;
  if (tag) { c.tag = tag[0]; i = tag[0].length; }
  while (i < p.length) {
    if (p[i] === '#' || p[i] === '.') {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(p.slice(i + 1));
      if (!m) break;
      if (p[i] === '#') c.id = m[0]; else c.classes.push(m[0]);
      i += 1 + m[0].length;
    } else if (p[i] === '[') {
      const end = p.indexOf(']', i);
      if (end < 0) break;
      const body = p.slice(i + 1, end);
      const eq = body.indexOf('=');
      const name = eq < 0 ? body : body.slice(0, eq);
      const raw = eq < 0 ? undefined : body.slice(eq + 1).replace(/^["']|["']$/g, '');
      c.attrs.push({ name, ...(raw !== undefined ? { value: raw } : {}) });
      i = end + 1;
    } else break;
  }
  return c;
}

export function parseSelector(s: string): Comp[] | null {
  if (!isSafeSelector(s)) return null;
  return s.split(' ').map(parseCompound);
}

function matches(n: HtmlNode, c: Comp): boolean {
  if (n.tag === '#text' || n.tag === '#root') return false;
  if (c.tag && n.tag !== c.tag) return false;
  if (c.id !== undefined && n.attrs['id'] !== c.id) return false;
  if (c.classes.length) {
    const have = (n.attrs['class'] ?? '').split(/\s+/);
    if (!c.classes.every((k) => have.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = n.attrs[a.name];
    if (v === undefined) return false;
    if (a.value !== undefined && v !== a.value) return false;
  }
  return true;
}

/** Descendants of `scope` (scope itself is only ever an ancestor), document order, hidden ones included (callers check `.hidden`). */
function selectAll(scope: HtmlNode, sel: Comp[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  const last = sel[sel.length - 1]!;
  const walk = (n: HtmlNode, anc: HtmlNode[]) => {
    for (const ch of n.children) {
      if (matches(ch, last) && (sel.length === 1 || anc.some((a) => matches(a, sel[0]!)))) out.push(ch);
      if (ch.children.length) walk(ch, [...anc, ch]);
    }
  };
  walk(scope, [scope]);
  return out;
}

// ---- extraction ----
export interface RawItem { title: string; url: string; [k: string]: string }
export interface Extraction {
  jobs: Job[];
  raw: RawItem[];
  /** Fields (or items) whose element was hidden: their values are never used. */
  hidden: number;
  /** Items whose URL was relative-unresolvable, non-https or outside the hosts. */
  outside: number;
  incomplete: number;
  nextUrl: string | null;
}

const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const clean = (s: unknown, max: number): string => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(INVISIBLE, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const MAX_ITEMS = 200;

export const generatedJobShape = z.object({
  id: z.string().min(1).max(120), source: z.string().min(1), title: z.string().min(1).max(200), company: z.string().min(1).max(100),
  url: z.string().url().max(500), apply_url: z.string().url().max(500), description: z.string().max(2000),
}).passthrough();

function resolveUrl(raw: string, base: string, hosts: readonly string[]): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !hostAllowed(u.hostname, hosts)) return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

function getPath(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const seg of jsonPathSegments(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (typeof seg === 'number') { if (!Array.isArray(cur)) return undefined; cur = cur[seg]; continue; }
    if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const scalar = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

function jobIdFor(specId: string, key: string): string {
  return `gen:${specId}:${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

/** Interpret `spec` over one fetched page (`pageUrl` resolves relative links). Never throws on content. */
export function extractWithSpec(spec: ProviderSpec, text: string, pageUrl: string): Extraction {
  const res: Extraction = { jobs: [], raw: [], hidden: 0, outside: 0, incomplete: 0, nextUrl: null };
  const values: Array<Record<string, string | undefined>> = [];
  if (spec.kind === 'html_list') {
    const root = parseHtml(text);
    const itemSel = parseSelector(spec.item.selector ?? '');
    if (!itemSel) return res;
    const read = (item: HtmlNode, f: FieldLocator | undefined, dflt: 'text' | 'href'): string | undefined => {
      if (!f) return undefined;
      let el: HtmlNode | undefined = item;
      if (f.selector) {
        const sel = parseSelector(f.selector);
        if (!sel) return undefined;
        const all = selectAll(item, sel);
        if (all.some((n) => n.hidden)) res.hidden++;
        el = all.find((n) => !n.hidden);
      } else if (item.hidden) el = undefined;
      if (!el) return undefined;
      const attr = f.attr ?? dflt;
      return attr === 'text' ? textOf(el) : el.attrs[attr];
    };
    for (const item of selectAll(root, itemSel).slice(0, MAX_ITEMS)) {
      if (item.hidden) { res.hidden++; continue; }
      const v: Record<string, string | undefined> = {};
      for (const k of ['title', 'url', 'company', 'location', 'description', 'posted_at', 'id'] as const) {
        v[k] = read(item, spec.fields[k], k === 'url' ? 'href' : 'text');
      }
      values.push(v);
    }
    if (spec.pagination?.next_selector) {
      const sel = parseSelector(spec.pagination.next_selector);
      const el = sel ? selectAll(root, sel).find((n) => !n.hidden) : undefined;
      const href = el?.attrs['href'];
      res.nextUrl = href ? resolveUrl(href, pageUrl, spec.hosts) : null;
    }
  } else {
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { return res; }
    const arr = getPath(doc, spec.item.jsonPath ?? '');
    if (!Array.isArray(arr)) return res;
    for (const it of arr.slice(0, MAX_ITEMS)) {
      const v: Record<string, string | undefined> = {};
      for (const k of ['title', 'url', 'company', 'location', 'description', 'posted_at', 'id'] as const) {
        const f = spec.fields[k];
        v[k] = f?.path ? scalar(getPath(it, f.path)) : undefined;
      }
      values.push(v);
    }
  }

  const seen = new Set<string>();
  for (const v of values) {
    const title = clean(v.title, 200);
    const rawUrl = (v.url ?? '').trim();
    if (!title || !rawUrl) { res.incomplete++; continue; }
    const url = resolveUrl(rawUrl, pageUrl, spec.hosts);
    if (!url) { res.outside++; continue; }
    const key = spec.job_id_from === 'field' ? `f:${clean(v.id, 120)}` : url;
    if (spec.job_id_from === 'field' && key === 'f:') { res.incomplete++; continue; }
    const id = jobIdFor(spec.id, key);
    if (seen.has(id)) continue;
    seen.add(id);
    const posted = toIsoDay(v.posted_at);
    const loc = clean(v.location, 120);
    const desc = clean(v.description, 1500);
    res.jobs.push({
      id, source: `gen:${spec.id}`, title, company: clean(v.company, 100) || spec.label.slice(0, 100), url, apply_url: url,
      description: loc ? `Location: ${loc}\n\n${desc}`.trim() : desc, ...(posted ? { posted_at: posted } : {}),
    });
    res.raw.push({ title, url });
  }
  return res;
}

// ---- provider ----
export type TextFetcher = (url: string) => Promise<string>;
export const shapeSpec = z.object({ title: z.string().min(1), url: z.string().min(1) }).passthrough();

const pageUrlFor = (base: string, spec: ProviderSpec, n: number): string => {
  if (n <= 1 || !spec.pagination?.param) return base;
  const u = new URL(base);
  u.searchParams.set(spec.pagination.param, String(n));
  return u.toString();
};

/** A Provider that runs `spec` like any other source: same Job shape, same shape check, source `gen:<id>`. */
export function createGeneratedProvider(spec: ProviderSpec, fetchText?: TextFetcher): Provider {
  const fetcher: TextFetcher = fetchText ?? ((url) => getText(url, `gen:${spec.id}`, { hosts: apexHosts(...spec.hosts), accept: spec.kind === 'json_api' ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }));
  return {
    id: `gen:${spec.id}`,
    shapeSpec,
    async fetch() {
      const jobs: Job[] = [];
      const sample: unknown[] = [];
      const ids = new Set<string>();
      const maxPages = spec.pagination?.max_pages ?? 1;
      for (const start of spec.start_urls) {
        let url: string | null = start;
        const visited = new Set<string>();
        for (let page = 1; page <= maxPages && url && !visited.has(url); page++) {
          visited.add(url);
          const ex = extractWithSpec(spec, await fetcher(url), url);
          let fresh = 0;
          for (const j of ex.jobs) {
            if (ids.has(j.id)) continue;
            ids.add(j.id); jobs.push(j); fresh++;
            if (sample.length < 5) sample.push({ title: j.title, url: j.url });
          }
          if (!fresh) break;
          url = spec.pagination?.next_selector ? ex.nextUrl : spec.pagination?.param ? pageUrlFor(start, spec, page + 1) : null;
        }
      }
      return { jobs, sample };
    },
  };
}
