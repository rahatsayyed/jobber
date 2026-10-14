// Adapted from career-ops-hq/career-ops providers/personio.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Public per-tenant XML feed: GET https://<slug>.jobs.personio.de/xml (or .com)
//   <workzag-jobs><position><id/><name/><office/><additionalOffices><office/></additionalOffices><createdAt/><jobDescriptions>...</jobDescriptions></position>...
// There is no per-job URL in the feed: it is built as https://<host>/job/<id> (id must be an integer). career-ops strips <jobDescriptions>;
// this provider keeps them (every <value> under it, document order) because the matcher needs the posting text. The inner element names of
// <jobDescriptions> are NOT confirmed from career-ops code: the provider only relies on <value> elements and falls back to an empty description.
// Tenants that disabled the XML feed answer 404: reported as a labelled error (the HTML fallback in career-ops is fragile and not ported).
// Discover-only (see src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText } from './transport.js';
import { childOf, childrenOf, descendantsOf, parseXml, textOf } from './xml.js';

const hostOf = (c: TrackedCompany): string => `${c.slug}.jobs.personio.${c.domain === 'com' ? 'com' : 'de'}`;

export function normalizePersonioXml(xml: string, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const jobsNode = childOf(parseXml(xml), 'workzag-jobs');
  if (!jobsNode) throw new Error(`personio ${c.slug}: unexpected response shape (no workzag-jobs element)`);
  const host = hostOf(c);
  const out: BoardJob[] = [];
  let noDescription = 0;
  for (const pos of childrenOf(jobsNode, 'position').slice(0, MAX_JOBS_PER_BOARD)) {
    const id = textOf(pos, 'id');
    const title = textOf(pos, 'name');
    if (!/^\d{1,12}$/.test(id) || !title) continue;
    const fullId = `pe:${c.slug}:${id}`;
    if (fullId.length > MAX_ID_CHARS) continue;
    const offices = [...new Set(descendantsOf(pos, 'office').map((o) => o.text.trim()).filter(Boolean))].map(clip);
    const posted = toIsoDay(textOf(pos, 'createdAt'));
    const body = descendantsOf(childOf(pos, 'jobDescriptions'), 'value').map((v) => v.text).join('\n');
    const url = `https://${host}/job/${id}`;
    const plain = capDescription(htmlToPlain(body));
    if (!plain) noDescription++;
    out.push({
      id: fullId,
      source: 'personio',
      title: clip(title),
      company: c.name,
      url,
      apply_url: url,
      description: plain,
      ...(posted ? { posted_at: posted } : {}),
      locations: offices,
      remote: /remote/i.test(title) || offices.some((o) => /remote/i.test(o)),
    });
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (jobDescriptions changed?)`);
  return out;
}

export async function fetchPersonio(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const host = hostOf(c);
  const xml = await getText(`https://${host}/xml`, `personio ${c.slug}`, { hosts: exactHosts(host) });
  try {
    return normalizePersonioXml(xml, c, ctx);
  } catch (e: any) {
    const m = String(e?.message ?? e);
    throw new Error(m.startsWith('personio ') ? m : `personio ${c.slug}: ${m}`);
  }
}
