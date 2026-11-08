// Adapted from career-ops-hq/career-ops providers/applitrack.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public school-district job board (Frontline AppliTrack): GET https://www.applitrack.com/<slug>/onlineapp/jobpostings/Output.asp?all=1
//   a JavaScript file (it starts with `function applyFor`) that document.writes HTML: <table class='title' ...> JobID: 123 ... <td id='wrapword'>Title</td> ...
//   Location: </span><span class='normal'>Site</span> ... Date Posted: </span><span class='normal'>M/D/YYYY</span>
// Job URL: https://www.applitrack.com/<slug>/onlineapp/default.aspx?AppliTrackJobId=<id>&AppliTrackLayoutMode=detail&AppliTrackViewPosting=1
// No description in the list. Mostly US school jobs. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts } from './transport.js';
import { blocksBetween, getHtml, makeJob, mdyToIso, plain } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const HOST = 'www.applitrack.com';

export interface AppliTrackRow { id: string; title: string; location: string; posted?: string | undefined }
export function parseAppliTrackOutput(body: string): AppliTrackRow[] {
  if (!body.includes('function applyFor')) throw new Error('response is not an AppliTrack Output.asp script (no applyFor prelude)');
  const html = body.replace(/\\'/g, "'").replace(/\\"/g, '"');
  const rows: AppliTrackRow[] = [];
  const seen = new Set<string>();
  for (const block of html.split(/<table class='title'/i).slice(1, MAX_JOBS_PER_BOARD + 1)) {
    const part = block.slice(0, 30_000);
    const id = /JobID:\s*(\d{1,12})/i.exec(part)?.[1];
    const cell = blocksBetween(part, "<td id='wrapword'", '</td>', 1)[0];
    const title = cell ? plain(cell.slice(cell.indexOf('>') + 1)) : '';
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const field = (name: string): string => {
      const i = part.indexOf(`${name}:`);
      if (i === -1) return '';
      const m = /<span class=['"]normal['"][^>]*>([^<]{0,200})</.exec(part.slice(i, i + 600));
      return m ? plain(m[1]) : '';
    };
    rows.push({ id, title, location: field('Location'), posted: mdyToIso(field('Date Posted')) });
  }
  return rows;
}

export async function fetchAppliTrack(c: TrackedCompany, _ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `applitrack ${c.slug}`;
  const base = `https://${HOST}/${c.slug}/onlineapp`;
  const body = await getHtml(`${base}/jobpostings/Output.asp?all=1`, label, exactHosts(HOST));
  let rows: AppliTrackRow[];
  try { rows = parseAppliTrackOutput(body); } catch (e: any) { throw new Error(`${label}: ${String(e?.message ?? e)}`); }
  return rows.flatMap((r) => makeJob({
    prefix: 'at', source: 'applitrack', c, key: r.id, title: r.title,
    url: `${base}/default.aspx?AppliTrackJobId=${r.id}&AppliTrackLayoutMode=detail&AppliTrackViewPosting=1`,
    locations: r.location ? [r.location] : [], posted: r.posted,
  }) ?? []);
}

export const shapeSpec = z.object({ id: z.string().min(1), title: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('applitrack', fetchAppliTrack, shapeSpec, (r) => parseAppliTrackOutput(String(r[0])).slice(0, 5));
