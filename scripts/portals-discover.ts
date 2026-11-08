// Find the ATS board of a company and print its config/portals.json entry (company seeding).
//   npm run portals:discover -- "Razorpay" "https://jobs.lever.co/meesho" [--write]
//   npm run portals:discover -- --seed [--region india|gulf|remote] [--limit N] [--write]
// Default is a PREVIEW: it probes the public Greenhouse/Lever/Ashby/Workable/Recruitee/SmartRecruiters/Personio endpoints through the
// board providers (https only, one request per --delay-ms, default 1000) and prints entries; nothing is written. With --write the found
// entries are appended to config/portals.json after validation and dedupe (never overwriting an existing entry). A slug is kept only
// when the probe returned a board with postings. Use `npx tsx scripts/check-portal.ts` afterwards to see how many jobs pass your filters.
// Flags: --ats a,b (restrict vendors)  --all (do not stop at the first vendor that answers)  --delay-ms N  --config <file> (tests).
// Exit codes: 0 ok, 2 usage. This is a live-network owner tool; the scheduler and the agent never run it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPortalEntries, discoverCompany, entryLine, looksLikeUrl } from '../src/sources/portalsDiscover.js';
import type { TrackedCompany } from '../src/sources/boards/filters.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALUE = new Set(['--region', '--limit', '--ats', '--delay-ms', '--config', '--seed-file']);
const args = process.argv.slice(2);
const pos: string[] = [];
const flags = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE.has(a)) { flags.set(a, args[++i] ?? ''); continue; }
  if (a.startsWith('--')) { flags.set(a, ''); continue; }
  pos.push(a);
}
const USAGE = 'usage: npm run portals:discover -- <company name or careers URL>... [--write]\n       npm run portals:discover -- --seed [--region india|gulf|remote] [--limit N] [--write]\n       flags: --ats greenhouse,lever  --all  --delay-ms 1000';

const seed = flags.has('--seed');
if (!seed && !pos.length) { console.error(USAGE); process.exit(2); }
const delayMs = flags.has('--delay-ms') ? Number(flags.get('--delay-ms')) : 1000;
if (!Number.isFinite(delayMs) || delayMs < 0) { console.error('--delay-ms must be a number >= 0'); process.exit(2); }
const configFile = flags.get('--config') || path.join(root, 'config', 'portals.json');

interface Item { name: string; url?: string; hint?: { ats: string; slug: string } }
let items: Item[] = [];
if (seed) {
  const file = flags.get('--seed-file') || path.join(root, 'config', 'portals-seed.json');
  let list: any[] = [];
  try { list = JSON.parse(readFileSync(file, 'utf8')).companies ?? []; } catch (e: any) { console.error(`cannot read seed file: ${e?.message ?? e}`); process.exit(2); }
  const region = flags.get('--region');
  items = list.filter((c) => c && typeof c.name === 'string' && (!region || c.region === region)).map((c) => ({ name: c.name, ...(c.hint ? { hint: c.hint } : {}) }));
  if (flags.has('--limit')) items = items.slice(0, Math.max(0, Number(flags.get('--limit')) || 0));
}
for (const p of pos) {
  if (looksLikeUrl(p)) {
    // The company name for a URL entry is the slug-ish host part; the owner can rename it in portals.json.
    let name = p;
    try { const u = new URL(p); name = (u.pathname.split('/').filter(Boolean)[0] ?? u.hostname.split('.')[0]) || u.hostname; } catch { /* keep */ }
    items.push({ name, url: p });
  } else items.push({ name: p });
}

const vendors = flags.has('--ats') ? (flags.get('--ats') as string).split(',').map((x) => x.trim()).filter(Boolean) : undefined;
const found: TrackedCompany[] = [];
let missed = 0;
for (const it of items) {
  console.log(`${it.name}${it.url ? ` (${it.url})` : ''}`);
  const r = await discoverCompany(it, { delayMs, vendors, firstHitOnly: !flags.has('--all'), log: (m) => console.log(m) });
  if (r.entry) { found.push(r.entry); console.log(`  -> ${entryLine(r.entry)}`); } else { missed++; console.log(`  -> no board found (${r.tried} probes, ${r.errors} failed)`); }
}
console.log(`\n${found.length} found, ${missed} not found`);
if (flags.has('--write')) {
  const res = appendPortalEntries(configFile, found);
  console.log(`wrote ${res.added.length} entr${res.added.length === 1 ? 'y' : 'ies'} to ${path.relative(root, configFile) || configFile}`);
  for (const s of res.skipped) console.log(`  skipped ${s.name}: ${s.reason}`);
} else if (found.length) {
  console.log('preview only: add --write to append these to config/portals.json');
}
