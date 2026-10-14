// Check a company board (or an aggregator feed) before adding it to config/portals.json:
//   npx tsx scripts/check-portal.ts <greenhouse|lever|ashby|workable|recruitee|personio|smartrecruiters> <slug> [--eu] [--domain de|com]
//   npx tsx scripts/check-portal.ts workday <tenant> --wd <wdN> --site <site> [--search <text>]
//   npx tsx scripts/check-portal.ts <hackernews|himalayas|weworkremotely>
// Prints how many jobs the board returned and how many pass the configured title + location filters.
// For workday and smartrecruiters (one detail request per posting) only the postings that pass the filters are detailed, at most max_detail of them.
// Exit codes: 0 ok, 1 fetch failure, 2 usage or invalid slug/config. (A live check is a user step: it uses the network.)
import { AGGREGATOR_DEFAULTS, AGGREGATOR_ATS, COMPANY_ATS, extraConfigProblem, loadPortals, locationAllowed, slugProblem, titlePasses, type Ats, type TrackedCompany } from '../src/sources/boards/filters.js';
import { FETCHERS } from '../src/sources/boards/registry.js';

const USAGE = `usage: npx tsx scripts/check-portal.ts <${COMPANY_ATS.join('|')}> <slug> [--eu] [--domain de|com] [--wd wdN --site <site>] [--search <text>]\n       npx tsx scripts/check-portal.ts <${AGGREGATOR_ATS.join('|')}>`;
const VALUE_FLAGS = new Set(['--domain', '--wd', '--site', '--search', '--max-detail', '--max-pages']);

const args = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) { flags.set(a, args[++i] ?? ''); continue; }
  if (a.startsWith('--')) { flags.set(a, ''); continue; }
  positional.push(a);
}
const [ats, slug] = positional as [Ats, string | undefined];
const isAggregator = (AGGREGATOR_ATS as readonly string[]).includes(ats);
const isCompany = (COMPANY_ATS as readonly string[]).includes(ats);
if (!isAggregator && !isCompany) { console.error(USAGE); process.exit(2); }
if (isCompany && !slug) { console.error(USAGE); process.exit(2); }

const num = (f: string) => (flags.has(f) ? Number(flags.get(f)) : undefined);
const company: TrackedCompany = isAggregator
  ? { ...AGGREGATOR_DEFAULTS[ats as keyof typeof AGGREGATOR_DEFAULTS], ats, enabled: true, ...(num('--max-pages') !== undefined ? { max_pages: num('--max-pages') } : {}) }
  : {
      name: slug as string, ats, slug: slug as string, enabled: true,
      ...(flags.has('--eu') ? { region: 'eu' as const } : {}),
      ...(flags.has('--domain') ? { domain: flags.get('--domain') as 'de' | 'com' } : {}),
      ...(flags.has('--wd') ? { wd: flags.get('--wd') } : {}),
      ...(flags.has('--site') ? { site: flags.get('--site') } : {}),
      ...(flags.has('--search') ? { search: flags.get('--search') } : {}),
      ...(num('--max-detail') !== undefined ? { max_detail: num('--max-detail') } : {}),
      ...(num('--max-pages') !== undefined ? { max_pages: num('--max-pages') } : {}),
    };
if (isCompany) {
  const problem = slugProblem(ats, slug) ?? extraConfigProblem(company);
  if (problem) {
    console.error(`invalid slug or options for ${ats} ${JSON.stringify(slug)}: ${problem} (letters, digits, "." "_" "-" only; must start with a letter or digit)`);
    process.exit(2);
  }
}

const label = isAggregator ? ats : `${ats} ${slug}`;
const { config } = loadPortals();
try {
  const jobs = await FETCHERS[ats](company, {
    deadlineAt: Date.now() + 25_000,
    warn: (m) => console.log(`  note: ${m}`),
    ...(config ? {
      titleOk: (t: string) => titlePasses(t, config.title_filter),
      prefilter: (t: string, l: string[], r: boolean) => titlePasses(t, config.title_filter) && locationAllowed(l, r, config.location_filter),
    } : {}),
  });
  const kept = config ? jobs.filter((j) => titlePasses(j.title, config.title_filter) && locationAllowed(j.locations, j.remote, config.location_filter)) : jobs;
  console.log(`${label}: ${jobs.length} jobs returned, ${kept.length} pass the filters`);
  for (const j of kept.slice(0, 5)) console.log(`  - ${j.title} | ${j.company} | ${j.locations.join('; ')} | ${j.apply_url}`);
} catch (e: any) {
  console.error(`${label}: ${e?.message ?? e}`);
  process.exit(1);
}
