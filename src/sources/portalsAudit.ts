// validate-portals style audit (idea from career-ops audit-portals). No network, no database: reads config/portals.json,
// config/platforms.json (and optionally config/portals-seed.json) and reports invalid or dead entries.
// errors = the runtime would skip or misread it; warnings = probably a mistake or a dead entry.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATOR_ATS, COMPANY_ATS, extraConfigProblem, slugProblem } from './boards/filters.js';
import { loadRegistry } from './registry.js';

export interface AuditFinding { level: 'error' | 'warning'; where: string; message: string }
export interface AuditResult { findings: AuditFinding[]; errors: number; warnings: number }

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const PLACEHOLDER_SLUG = /^(?:example|examples?-?company|your-?company|company|slug|todo|tbd|test|changeme|acme|foo|bar)$/i;
const KNOWN_PREFIXES = ['word', 'stem', 'lead'];
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Problems with one title keyword of the filter grammar ("word:x", "stem:x", "lead:x", "a + b"); null when fine. */
export function keywordProblem(k: unknown): string | null {
  if (typeof k !== 'string') return 'not a string';
  if (!k.trim()) return 'empty keyword';
  for (const part of k.split('+')) {
    const p = part.trim();
    if (!p) return 'empty part around "+"';
    const m = /^([a-z]+):(.*)$/i.exec(p);
    if (m) {
      if (!KNOWN_PREFIXES.includes(m[1].toLowerCase())) return `unknown prefix "${m[1]}:" (known: word:, stem:, lead:)`;
      if (!m[2].trim()) return `"${m[1]}:" with no word`;
    }
  }
  return null;
}

function readJson(file: string, label: string, out: AuditFinding[]): any | null {
  if (!existsSync(file)) { out.push({ level: 'error', where: label, message: 'file not found' }); return null; }
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e: any) { out.push({ level: 'error', where: label, message: `invalid JSON: ${String(e?.message ?? e).slice(0, 120)}` }); return null; }
}

export interface AuditPaths { portals?: string; platforms?: string; seed?: string; sourcesDir?: string }

export function auditPortals(p: AuditPaths = {}): AuditResult {
  const f: AuditFinding[] = [];
  const err = (where: string, message: string) => f.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => f.push({ level: 'warning', where, message });
  const portalsFile = p.portals ?? path.join(repoRoot, 'config', 'portals.json');
  const platformsFile = p.platforms ?? path.join(repoRoot, 'config', 'platforms.json');
  const seedFile = p.seed ?? path.join(repoRoot, 'config', 'portals-seed.json');
  const sourcesDir = p.sourcesDir ?? here;

  // ---- portals.json ----
  const raw = readJson(portalsFile, 'portals.json', f);
  if (raw) {
    if (!isObj(raw)) err('portals.json', 'top level must be an object');
    else {
      const list: unknown[] = Array.isArray(raw.tracked_companies) ? raw.tracked_companies : [];
      if (!Array.isArray(raw.tracked_companies)) err('portals.json', 'tracked_companies must be an array');
      const seenKey = new Map<string, number>();
      const seenName = new Map<string, number>();
      let enabledCount = 0;
      list.forEach((c, i) => {
        const w = `portals.json tracked_companies[${i}]${isObj(c) && typeof c.name === 'string' ? ` (${c.name.slice(0, 40)})` : ''}`;
        if (!isObj(c)) { err(w, 'not an object'); return; }
        if (typeof c.name !== 'string' || !c.name.trim()) err(w, 'missing name');
        if (c.ats === 'custom') return; // owner-listed site read by the scout, validated elsewhere
        if (!(COMPANY_ATS as readonly string[]).includes(c.ats)) { err(w, `unknown ats ${JSON.stringify(c.ats)} (known: ${COMPANY_ATS.join(', ')}, custom)`); return; }
        if (typeof c.enabled !== 'boolean') warn(w, 'enabled is not a boolean (anything but true counts as disabled)');
        const sp = typeof c.slug === 'string' ? slugProblem(c.ats, c.slug.trim()) : 'invalid slug';
        if (sp) err(w, sp);
        else {
          if (PLACEHOLDER_SLUG.test(c.slug.trim())) warn(w, `slug "${c.slug}" looks like a placeholder`);
          if (c.slug !== c.slug.trim()) warn(w, 'slug has surrounding spaces (they are trimmed at load)');
        }
        const xp = extraConfigProblem(c);
        if (xp) err(w, xp);
        const key = `${c.ats}:${String(c.slug ?? '').trim().toLowerCase()}`;
        if (seenKey.has(key)) err(w, `duplicate of tracked_companies[${seenKey.get(key)}] (same vendor and slug)`); else seenKey.set(key, i);
        const nk = String(c.name ?? '').trim().toLowerCase();
        if (nk) { if (seenName.has(nk)) warn(w, `same name as tracked_companies[${seenName.get(nk)}]`); else seenName.set(nk, i); }
        if (c.enabled === true) {
          enabledCount++;
          if (typeof c.note === 'string' && /unverified/i.test(c.note)) warn(w, 'enabled but its note says unverified: run scripts/check-portal.ts first');
        }
      });
      if (list.length && enabledCount === 0) warn('portals.json', 'no tracked company is enabled (only aggregators and APIs would run)');
      if (raw.aggregators !== undefined) {
        if (!isObj(raw.aggregators)) err('portals.json aggregators', 'must be an object');
        else for (const [k, v] of Object.entries(raw.aggregators)) {
          if (!(AGGREGATOR_ATS as readonly string[]).includes(k)) err(`portals.json aggregators.${k}`, `unknown aggregator (known: ${AGGREGATOR_ATS.join(', ')})`);
          else if (!isObj(v)) err(`portals.json aggregators.${k}`, 'must be an object');
          else { const xp = extraConfigProblem({ ...v, ats: k }); if (xp) err(`portals.json aggregators.${k}`, xp); }
        }
      }
      // title filter
      const tf = raw.title_filter;
      if (!isObj(tf)) err('portals.json title_filter', 'missing or not an object');
      else {
        for (const key of ['positive', 'negative', 'exclude', 'skip_tiers', 'seniority_boost'] as const) {
          if (tf[key] === undefined) { if (key === 'positive' || key === 'negative') err(`portals.json title_filter.${key}`, 'must be an array'); continue; }
          if (!Array.isArray(tf[key])) { err(`portals.json title_filter.${key}`, 'must be an array'); continue; }
          const seen = new Set<string>();
          tf[key].forEach((k: unknown, i: number) => {
            const kp = keywordProblem(k);
            if (kp) { err(`portals.json title_filter.${key}[${i}]`, kp); return; }
            const norm = String(k).trim().toLowerCase();
            if (seen.has(norm)) warn(`portals.json title_filter.${key}[${i}]`, `duplicate keyword "${k}"`); else seen.add(norm);
          });
        }
        if (Array.isArray(tf.positive) && !tf.positive.some((x: unknown) => typeof x === 'string' && x.trim())) err('portals.json title_filter.positive', 'must not be empty (the loader refuses the whole file)');
        if (Array.isArray(tf.positive) && Array.isArray(tf.negative)) {
          const neg = new Set(tf.negative.filter((x: unknown) => typeof x === 'string').map((x: string) => x.trim().toLowerCase()));
          for (const x of tf.positive) if (typeof x === 'string' && neg.has(x.trim().toLowerCase())) warn('portals.json title_filter', `"${x}" is in both positive and negative (it can never match)`);
        }
        if (tf.use_role_gate !== undefined && typeof tf.use_role_gate !== 'boolean') err('portals.json title_filter.use_role_gate', 'must be true or false');
      }
      const lf = raw.location_filter;
      if (!isObj(lf)) err('portals.json location_filter', 'missing or not an object');
      else {
        if (!Array.isArray(lf.allow) || !lf.allow.some((x: unknown) => typeof x === 'string' && x.trim())) err('portals.json location_filter.allow', 'must be a non-empty array (the loader refuses the whole file)');
        for (const key of ['global', 'exclude'] as const) if (lf[key] !== undefined && !Array.isArray(lf[key])) err(`portals.json location_filter.${key}`, 'must be an array');
        if (Array.isArray(lf.allow) && Array.isArray(lf.exclude)) {
          const ex = new Set(lf.exclude.map((x: unknown) => String(x).trim().toLowerCase()));
          for (const a of lf.allow) if (ex.has(String(a).trim().toLowerCase())) warn('portals.json location_filter', `"${a}" is both allowed and excluded`);
        }
      }
      if (raw.max_posting_age_days !== undefined && raw.max_posting_age_days !== null) {
        const n = raw.max_posting_age_days;
        if (typeof n !== 'number' || !Number.isFinite(n)) err('portals.json max_posting_age_days', 'must be a number');
        else if (n > 0 && n < 3) warn('portals.json max_posting_age_days', 'very small: most boards publish dates in whole days');
      }
      if (raw.early_stop_by_age !== undefined && typeof raw.early_stop_by_age !== 'boolean') err('portals.json early_stop_by_age', 'must be true or false');
      if (raw.early_stop_by_age === true && !(typeof raw.max_posting_age_days === 'number' && raw.max_posting_age_days > 0)) warn('portals.json early_stop_by_age', 'has no effect without max_posting_age_days');
    }
  }

  // ---- platforms.json ----
  if (existsSync(platformsFile)) {
    const { platforms, errors } = loadRegistry(platformsFile);
    for (const e of errors) err('platforms.json', e.replace(/^config\/platforms\.json: /, ''));
    const ids = new Set(platforms.map((x) => x.id));
    for (const x of platforms) {
      if (x.provider) {
        const base = path.join(sourcesDir, x.provider);
        if (!existsSync(`${base}.ts`) && !existsSync(`${base}.js`)) err(`platforms.json ${x.id}`, `provider module "${x.provider}" not found under src/sources`);
      }
      if (x.enabled && x.stability === 'flaky') warn(`platforms.json ${x.id}`, 'enabled but marked flaky');
    }
    for (const v of [...COMPANY_ATS, ...AGGREGATOR_ATS]) if (!ids.has(v)) warn('platforms.json', `no platform row for board vendor "${v}" (its status would not be listed)`);
  } else err('platforms.json', 'file not found');

  // ---- seed list (optional) ----
  if (existsSync(seedFile)) {
    const seed = readJson(seedFile, 'portals-seed.json', f);
    if (seed) {
      const list = Array.isArray(seed.companies) ? seed.companies : null;
      if (!list) err('portals-seed.json', 'companies must be an array');
      else {
        const names = new Set<string>();
        list.forEach((c: any, i: number) => {
          const w = `portals-seed.json companies[${i}]${typeof c?.name === 'string' ? ` (${c.name.slice(0, 40)})` : ''}`;
          if (!isObj(c) || typeof c.name !== 'string' || !c.name.trim()) { err(w, 'missing name'); return; }
          const nk = c.name.trim().toLowerCase();
          if (names.has(nk)) warn(w, 'duplicate name'); else names.add(nk);
          if (c.hint !== undefined) {
            if (!isObj(c.hint) || typeof c.hint.ats !== 'string' || typeof c.hint.slug !== 'string') err(w, 'hint needs ats and slug');
            else { const sp = slugProblem(c.hint.ats, c.hint.slug); if (sp || !(COMPANY_ATS as readonly string[]).includes(c.hint.ats)) err(w, sp ?? `unknown ats ${c.hint.ats}`); }
          }
        });
      }
    }
  }

  return { findings: f, errors: f.filter((x) => x.level === 'error').length, warnings: f.filter((x) => x.level === 'warning').length };
}
