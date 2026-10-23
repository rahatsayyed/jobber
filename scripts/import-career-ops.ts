// Owner and builder tool (plan 8G task 9): inventory a LOCAL checkout of career-ops-hq/career-ops and write the import report.
//   npx tsx scripts/import-career-ops.ts --src .superpowers/tmp/career-ops [--commit <sha>] [--out <file>] [--date YYYY-MM-DD]
// Offline: it only reads files under --src (clone the repository yourself first) and this project's own files. It never contacts a
// network, never ports code (ported providers are hand-adapted files in src/sources/providers) and never enables anything.
// It checks the licence first: a licence that is not permissive makes every provider "skipped: licence" and exits 3.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Kind = 'json_api' | 'html_list' | 'rss' | 'needs_login' | 'needs_js' | 'unclear';
export type Scope = 'board_wide' | 'tenant';
export type Status = 'imported' | 'already_present' | 'skipped';

export interface Row {
  id: string;
  lines: number;
  kind: Kind;
  scope: Scope;
  status: Status;
  reason: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-10-16-career-ops-import-report.md');

/** Drops // and block comments (good enough for classification; strings containing // are rare in these files). */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export function licenseVerdict(text: string): { ok: boolean; name: string } {
  const t = text.replace(/\s+/g, ' ');
  if (/MIT License/i.test(t) && /Permission is hereby granted, free of charge/i.test(t)) return { ok: true, name: 'MIT' };
  if (/Apache License,? Version 2\.0/i.test(t)) return { ok: true, name: 'Apache-2.0' };
  if (/Redistribution and use in source and binary forms/i.test(t) && /BSD|Neither the name|THIS SOFTWARE IS PROVIDED/i.test(t)) return { ok: true, name: 'BSD' };
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(t)) return { ok: true, name: 'ISC' };
  return { ok: false, name: 'unrecognized or not permissive' };
}

// Providers verified by reading that the heuristic below gets wrong (kept short and explicit).
const SCOPE_OVERRIDES: Record<string, Scope> = { justjoin: 'board_wide', collage: 'tenant' };

export function classify(source: string, id: string): { kind: Kind; scope: Scope } {
  const code = stripComments(source);
  const json = /fetchJson/.test(code);
  const text = /fetchText|fetchResponse/.test(code);
  let kind: Kind;
  if (/playwright|puppeteer|chromium|page\.goto|browser-extract/i.test(code)) kind = 'needs_js';
  else if (/\bauthorization\b|bearer\s|x-api-key|\bapi[_-]?key\b|csrf|set-cookie|\bcookie\b|sessionid|\blogin\b/i.test(code)) kind = 'needs_login';
  else if (text && /<item\b|<rss\b|<channel\b|\.xml\b|\brss\b|\batom\b/i.test(code)) kind = 'rss';
  else if (text && !json) kind = 'html_list';
  else if (json) kind = 'json_api';
  else if (text) kind = 'html_list';
  else kind = 'unclear';
  const hasFeedConst = /\bconst\s+(?:FEED|FEED_URL|FEED_BASE|JOBS_ENDPOINT|API_BASE|API_ORIGIN)\b/.test(code);
  const usesEntryUrl = /entry\??\.(?:careers_url|api|tenant|slug|company|board|org)\b/.test(code);
  const scope: Scope = SCOPE_OVERRIDES[id] ?? (usesEntryUrl && !hasFeedConst ? 'tenant' : 'board_wide');
  return { kind, scope };
}

export interface Known { ids: Set<string>; imported: Set<string> }

/** Ids already in config/platforms.json (any row) and the subset implemented as imported feeds in src/sources/providers. */
export function knownIds(root: string = ROOT): Known {
  const ids = new Set<string>();
  const imported = new Set<string>();
  try {
    const reg = JSON.parse(readFileSync(path.join(root, 'config', 'platforms.json'), 'utf8')) as { platforms?: { id?: string; provider?: string | null }[] };
    for (const p of reg.platforms ?? []) {
      if (typeof p.id !== 'string') continue;
      ids.add(p.id);
      if (typeof p.provider === 'string' && p.provider.startsWith('providers/')) imported.add(p.id);
    }
  } catch { /* no registry: nothing is known */ }
  return { ids, imported };
}

const SKIP_REASON: Record<string, string> = {
  tenant: 'per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine',
  needs_js: 'needs a real browser; agent tier, no script provider',
  needs_login: 'looks like it needs credentials, a token or a session (heuristic); agent tier, no script provider',
  html_list: 'HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider',
  unclear: 'could not classify automatically; needs a manual read',
  candidate: 'board-wide feed, not ported in this pass (candidate for a later batch)',
};

export function inventory(src: string, known: Known): Row[] {
  const dir = path.join(src, 'providers');
  const rows: Row[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue;
    const id = f.slice(0, -4);
    const source = readFileSync(path.join(dir, f), 'utf8');
    const lines = source.split('\n').length;
    if (id === 'local-parser') {
      rows.push({ id, lines, kind: 'unclear', scope: 'tenant', status: 'skipped', reason: 'not a provider: runs an owner-supplied local command' });
      continue;
    }
    const { kind, scope } = classify(source, id);
    let status: Status = 'skipped';
    let reason: string;
    if (known.imported.has(id)) { status = 'imported'; reason = 'ported as src/sources/providers/' + id + '.ts, disabled, discover-only'; }
    else if (known.ids.has(id)) { status = 'already_present'; reason = 'already ported earlier (plan 4/5 boards or the Remotive/RemoteOK sources)'; }
    else if (scope === 'tenant') reason = SKIP_REASON.tenant;
    else if (kind === 'needs_js' || kind === 'needs_login' || kind === 'html_list' || kind === 'unclear') reason = SKIP_REASON[kind];
    else reason = SKIP_REASON.candidate;
    rows.push({ id, lines, kind, scope, status, reason });
  }
  return rows;
}

const count = <T,>(xs: T[], f: (x: T) => boolean): number => xs.filter(f).length;

export function renderReport(o: { rows: Row[]; license: string; licenseName: string; licenseOk: boolean; commit: string; date: string }): string {
  const { rows } = o;
  const kinds: Kind[] = ['json_api', 'rss', 'html_list', 'needs_login', 'needs_js', 'unclear'];
  const out: string[] = [];
  out.push('# career-ops import report', '');
  out.push(`Generated ${o.date} by \`npx tsx scripts/import-career-ops.ts\` from a local checkout. Source: https://github.com/career-ops-hq/career-ops, commit \`${o.commit || 'unknown'}\`.`, '');
  out.push('## Licence ruling', '');
  out.push(o.licenseOk
    ? `Licence found: ${o.licenseName}. Compatible with this project, so providers are ported by hand as adaptations with an attribution header on line 1 (\`Adapted from career-ops-hq/career-ops providers/<file>.mjs (MIT, (c) <holder>), commit <hash>\`), disabled by default.`
    : `Licence found: ${o.licenseName}. NOT compatible: no real import. Nothing was ported; every provider is skipped.`, '');
  out.push('```text', o.license.trim(), '```', '');
  const total = rows.length;
  const imp = count(rows, (r) => r.status === 'imported');
  const had = count(rows, (r) => r.status === 'already_present');
  const skip = count(rows, (r) => r.status === 'skipped');
  out.push('## Counts', '');
  out.push(`- Provider modules found in \`providers/\` (files not starting with \`_\`): **${total}**`);
  out.push(`- Imported in this task: **${imp}**`);
  out.push(`- Already present before this task (earlier plans): **${had}**`);
  out.push(`- Skipped: **${skip}**`, '');
  out.push('| Classification (heuristic) | Modules |', '|---|---|');
  for (const k of kinds) out.push(`| ${k} | ${count(rows, (r) => r.kind === k)} |`);
  out.push('', `Scope: ${count(rows, (r) => r.scope === 'board_wide')} board-wide, ${count(rows, (r) => r.scope === 'tenant')} per-company (tenant). Classification is a code heuristic over the source text (\`scripts/import-career-ops.ts\` \`classify\`), not a live check: treat it as a triage list.`, '');
  out.push('## Providers', '', '| Provider | Lines | Class | Scope | Status | Reason |', '|---|---|---|---|---|---|');
  for (const r of rows) out.push(`| ${r.id} | ${r.lines} | ${r.kind} | ${r.scope} | ${r.status} | ${r.reason} |`);
  out.push('', '## What the imported providers are and are not', '');
  out.push('- Shapes were read from career-ops code only. NOTHING was run against a real site: every imported row is `stability: fixture`, `enabled: false`.');
  out.push('- Terms of use and robots.txt of every source are unreviewed. Run `npx tsx scripts/check-portal.ts` style checks from a networked shell and read each site\'s terms before enabling a row in `config/platforms.json`.');
  out.push('- Most feeds carry no job description (career-ops is listing-only for them): those jobs get a "Listing only" description and score on title and location only until a description fetch exists.');
  out.push('- Imported sources are discover-only for apply (`src/lib/discoverOnly.ts`): email and connect outreach may run, an apply attempt never does.');
  out.push('- The runner applies no title/location filter to `api` sources, so each imported provider keeps only titles that share a word with the configured role and caps the result at 200.', '');
  return out.join('\n');
}

export function parseArgs(argv: string[]): { src?: string; commit?: string; out?: string; date?: string } {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return { src: get('--src'), commit: get('--commit'), out: get('--out'), date: get('--date') };
}

export function main(argv: string[] = process.argv.slice(2), root: string = ROOT): number {
  const a = parseArgs(argv);
  if (!a.src || !existsSync(path.join(a.src, 'providers'))) {
    console.error('Usage: npx tsx scripts/import-career-ops.ts --src <career-ops checkout> [--commit <sha>] [--out <file>] [--date YYYY-MM-DD]');
    return 2;
  }
  let license = '';
  try { license = readFileSync(path.join(a.src, 'LICENSE'), 'utf8'); } catch { license = ''; }
  const verdict = license ? licenseVerdict(license) : { ok: false, name: 'no LICENSE file found' };
  const known = verdict.ok ? knownIds(root) : { ids: new Set<string>(), imported: new Set<string>() };
  let rows = inventory(a.src, known);
  if (!verdict.ok) rows = rows.map((r) => ({ ...r, status: 'skipped' as Status, reason: 'licence: no real import' }));
  const outFile = a.out ?? DEFAULT_OUT;
  mkdirSync(path.dirname(outFile), { recursive: true });
  const date = a.date ?? new Date().toISOString().slice(0, 10);
  writeFileSync(outFile, renderReport({ rows, license: license || '(no LICENSE file)', licenseName: verdict.name, licenseOk: verdict.ok, commit: a.commit ?? '', date }));
  console.log(`${rows.length} provider modules, ${rows.filter((r) => r.status === 'imported').length} imported, ${rows.filter((r) => r.status === 'already_present').length} already present, ${rows.filter((r) => r.status === 'skipped').length} skipped; report: ${path.relative(root, outFile)}`);
  return verdict.ok ? 0 : 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
