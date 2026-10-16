// Declarative generated-provider spec (plan 8G task 8, D7, O-spec). A spec is DATA: a fixed engine (engine.ts) interprets it.
// It is never imported, required or evaluated, and no model writes code.
import { z } from 'zod';
import { isSafeJsonPath, isSafeSelector } from '../../lib/safeSelector.js';

export const HOST_RE = /^(?=.{3,100}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const FIELD_ATTRS = ['text', 'href', 'content', 'datetime', 'title'] as const;

const selector = z.string().refine(isSafeSelector, 'unsafe selector');
const jpath = z.string().refine(isSafeJsonPath, 'unsafe json path');
const locator = z.object({ selector: selector.optional(), path: jpath.optional(), attr: z.enum(FIELD_ATTRS).optional() }).strict();
export type FieldLocator = z.infer<typeof locator>;

export const specSchema = z.object({
  schema: z.literal(1),
  id: z.string().regex(ID_RE),
  label: z.string().min(1).max(100),
  hosts: z.array(z.string().regex(HOST_RE)).min(1).max(5),
  kind: z.enum(['html_list', 'json_api']),
  start_urls: z.array(z.string().url().max(500)).min(1).max(5),
  item: z.object({ selector: selector.optional(), jsonPath: jpath.optional() }).strict(),
  fields: z.object({
    title: locator, url: locator, company: locator.optional(), location: locator.optional(),
    description: locator.optional(), posted_at: locator.optional(), id: locator.optional(),
  }).strict(),
  pagination: z.object({ next_selector: selector.optional(), param: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/).optional(), max_pages: z.number().int().min(1).max(5) }).strict().optional(),
  job_id_from: z.enum(['url', 'field']),
}).strict().superRefine((s, ctx) => {
  const bad = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path });
  const html = s.kind === 'html_list';
  if (html && (!s.item.selector || s.item.jsonPath)) bad('html_list needs item.selector only', ['item']);
  if (!html && (!s.item.jsonPath || s.item.selector)) bad('json_api needs item.jsonPath only', ['item']);
  for (const [name, f] of Object.entries(s.fields)) {
    if (!f) continue;
    if (html && (f.path !== undefined || (f.selector === undefined && f.attr === undefined))) bad('html field needs selector/attr, no path', ['fields', name]);
    if (!html && (f.path === undefined || f.selector !== undefined || f.attr !== undefined)) bad('json field needs path only', ['fields', name]);
  }
  if (s.job_id_from === 'field' && !s.fields.id) bad('job_id_from field needs fields.id', ['job_id_from']);
  if (s.pagination) {
    if (!s.pagination.next_selector && !s.pagination.param) bad('pagination needs next_selector or param', ['pagination']);
    if (!html && s.pagination.next_selector) bad('json_api paginates by param only', ['pagination']);
  }
  s.start_urls.forEach((u, i) => {
    let p: URL | null = null;
    try { p = new URL(u); } catch { /* flagged below */ }
    if (!p || p.protocol !== 'https:' || p.username || p.password || p.port || !hostAllowed(p.hostname, s.hosts)) bad('start_url must be https inside hosts', ['start_urls', i]);
  });
});
export type ProviderSpec = z.infer<typeof specSchema>;

export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((a) => h === a || h.endsWith(`.${a}`));
}
