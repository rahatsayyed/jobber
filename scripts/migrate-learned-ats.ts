// One-off migration (plan 8G-2 task 19): turns the runtime-created config/learned-ats-platforms.json
// (hostname -> FieldMap, written by the old self-extending bootstrap) into validated, UNVERIFIED learned
// recipes under .jobber/ats-recipes. Run: npx tsx scripts/migrate-learned-ats.ts
// The learned file is untracked and may not exist: then this does nothing. Every selector goes through the
// same validator as any recipe, so a hostile entry is rejected and reported, never written. An existing
// recipe of the same id (shipped or learned) is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeSelector } from '../src/applier/recipes/safeSelector.js';
import { validateRecipe, type Recipe, type RecipeField } from '../src/applier/recipes/schema.js';
import { DEFAULT_LEARNED_DIR, PROJECT_ROOT, getRecipe, readSmallFile, saveLearnedRecipe } from '../src/applier/recipes/store.js';

export interface MigrateOpts { learnedPath?: string; outDir?: string }
export interface MigrateResult { present: boolean; migrated: string[]; rejected: Array<{ host: string; why: string }> }

const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const REQUIRED = ['name', 'email', 'resumeUpload', 'submitButton'] as const;
const OPTIONAL = ['firstName', 'lastName', 'phone', 'coverLetter'] as const;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

function toRecipe(host: string, id: string, m: Raw): Recipe | string {
  for (const k of REQUIRED) if (typeof m[k] !== 'string') return `missing ${k}`;
  for (const k of OPTIONAL) if (m[k] !== undefined && typeof m[k] !== 'string') return `bad ${k}`;
  const sel = (k: string): string => m[k] as string;
  for (const k of [...REQUIRED, ...OPTIONAL]) if (typeof m[k] === 'string' && !isSafeSelector(sel(k))) return `unsafe selector for ${k}`;

  const fields: RecipeField[] = [];
  if (typeof m.firstName === 'string' && typeof m.lastName === 'string') {
    fields.push({ role: 'name.first', selector: sel('firstName'), type: 'text', required: true });
    fields.push({ role: 'name.last', selector: sel('lastName'), type: 'text', required: true });
  } else {
    fields.push({ role: 'name.full', selector: sel('name'), type: 'text', required: true });
  }
  fields.push({ role: 'email', selector: sel('email'), type: 'email', required: true });
  if (typeof m.phone === 'string') fields.push({ role: 'phone', selector: sel('phone'), type: 'tel' });
  fields.push({ role: 'resume', selector: sel('resumeUpload'), type: 'file', required: true });
  if (typeof m.coverLetter === 'string') fields.push({ role: 'cover_letter', selector: sel('coverLetter'), type: 'textarea' });
  const roles = fields.filter((f) => f.required).map((f) => f.role);
  const recipe: Recipe = {
    schema: 1, id, platform: id, verified: false, source: 'learned',
    note: `migrated from learned-ats-platforms.json, host ${host}`.slice(0, 200),
    steps: [{
      id: 'form', kind: 'form', match: { roles, minFields: roles.length }, fields,
      submit: { selector: sel('submitButton') },
    }],
    confirmation: { roles_absent: ['email', 'resume'] },
  };
  const v = validateRecipe(recipe);
  return v.ok ? v.recipe : v.why;
}

export function migrateLearned(o: MigrateOpts = {}): MigrateResult {
  const learnedPath = o.learnedPath ?? path.join(PROJECT_ROOT, 'config', 'learned-ats-platforms.json');
  const outDir = o.outDir ?? DEFAULT_LEARNED_DIR;
  const out: MigrateResult = { present: false, migrated: [], rejected: [] };
  const text = readSmallFile(learnedPath, 1_000_000);
  if (text === null) return out;
  out.present = true;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { out.rejected.push({ host: '(file)', why: 'invalid json' }); return out; }
  if (!isObj(raw)) { out.rejected.push({ host: '(file)', why: 'not an object' }); return out; }
  for (const [host, entry] of Object.entries(raw)) {
    const shown = HOST_RE.test(host) ? host : '(bad host)';
    if (!HOST_RE.test(host)) { out.rejected.push({ host: shown, why: 'bad host name' }); continue; }
    if (!isObj(entry)) { out.rejected.push({ host, why: 'entry is not an object' }); continue; }
    const id = host.replace(/[^a-z0-9]/g, '').slice(0, 30);
    if (getRecipe(id, { learnedDir: outDir })) continue;       // never overwrite
    const r = toRecipe(host, id, entry);
    if (typeof r === 'string') { out.rejected.push({ host, why: r }); continue; }
    try { saveLearnedRecipe(r, outDir); out.migrated.push(id); } catch { out.rejected.push({ host, why: 'not saved' }); }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = migrateLearned();
  if (!r.present) console.log('no config/learned-ats-platforms.json, nothing to migrate');
  else console.log(`migrated ${r.migrated.length}, rejected ${r.rejected.length}`);
  for (const x of r.rejected) console.log(`  rejected ${x.host}: ${x.why}`);
  if (fs.existsSync(DEFAULT_LEARNED_DIR)) console.log(`recipes are in ${path.relative(PROJECT_ROOT, DEFAULT_LEARNED_DIR)}`);
}
