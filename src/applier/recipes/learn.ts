// Recipe service (plan 8G-2 task 19): lookup, hit/miss counters, confirmed-only learning and promotion.
//
// While the operator fills a form by hand, the typed tools tell this service which field (role, type and a
// selector built from the extractor's own id or name handle) was filled. Those notes sit in memory per job.
// Only a CONFIRMED submitted application moves them into .jobber/ats-recipes/<platform>.candidate.json;
// held, unconfirmed and failed applications discard them. A candidate becomes a learned recipe only after
// APPLY_RECIPE_PROMOTE_N confirmed applications over APPLY_RECIPE_PROMOTE_RUNS distinct run ids, and never
// for a platform that already has a recipe. No page text, label, value or URL is ever stored.
import path from 'node:path';
import { z } from 'zod';
import type { FormField, RawField } from '../../webcore/formModel.js';
import { isSafeSelector } from '../../lib/safeSelector.js';
import type { ConfirmSignals } from '../confirm.js';
import { confirmSignals } from './autofill.js';
import {
  RECIPE_FIELD_TYPES, RECIPE_PLATFORM_RE, RECIPE_ROLES, RECIPE_STEP_KINDS, RecipeSchema, validateRecipe,
  type Recipe, type RecipeField,
} from './schema.js';
import {
  DEFAULT_LEARNED_DIR, getRecipe, isPlatformId, readSmallFile, saveLearnedRecipe, writeFileAtomic,
  type LoadedRecipe, type RecipeStoreOpts,
} from './store.js';

export interface RecipeConfig { promoteN: number; promoteRuns: number }

function intIn(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || !/^\d{1,4}$/.test(raw.trim())) return def;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : def;
}

export function loadRecipeConfig(env: NodeJS.ProcessEnv = process.env): RecipeConfig {
  return {
    promoteN: intIn(env.APPLY_RECIPE_PROMOTE_N, 3, 1, 50),
    promoteRuns: intIn(env.APPLY_RECIPE_PROMOTE_RUNS, 2, 1, 20),
  };
}

// Roles the operator types by hand that a recipe may learn (questions, self-identification, consent and
// cover letters stay answer-book work and are never learned).
const LEARNABLE = new Set<string>(['name.first', 'name.last', 'name.full', 'email', 'phone', 'resume', 'linkedin_url', 'location']);
const NEVER_LEARN_PLATFORMS = new Set(['browser', 'none', 'naukri', 'linkedin', 'linkedin_easy']);
const MAX_ENTRIES = 60;
const MAX_CONFIRMED = 50;
const MAX_BUFFERS = 50;
const RUN_RE = /^[A-Za-z0-9_-]{1,40}$/;
const JOB_RE = /^[\w.:@-]{1,200}$/;

const EntrySchema = z.object({
  step: z.enum(RECIPE_STEP_KINDS),
  role: z.enum(RECIPE_ROLES as [string, ...string[]]),
  selector: z.string().min(1).max(200).refine(isSafeSelector, 'unsafe selector'),
  type: z.enum(RECIPE_FIELD_TYPES),
  n: z.number().int().min(1).max(100000),
}).strict();
type Entry = z.infer<typeof EntrySchema>;

const CandidateSchema = z.object({
  schema: z.literal(1),
  platform: z.string().regex(RECIPE_PLATFORM_RE),
  entries: z.array(EntrySchema).max(MAX_ENTRIES),
  confirmed: z.array(z.object({ job: z.string().regex(JOB_RE), run: z.string().regex(RUN_RE) }).strict()).max(MAX_CONFIRMED),
  stats: z.object({ match: z.number().int().min(0).max(1_000_000), miss: z.number().int().min(0).max(1_000_000) }).strict(),
  proposed: RecipeSchema.nullable(),
  proposed_at: z.number().int().min(0).max(MAX_CONFIRMED),
}).strict();
type Candidate = z.infer<typeof CandidateSchema>;

export interface FillNote { platform: string; jobId: string; stepKind: string; field: FormField; raw?: RawField }
export type Outcome = 'confirmed' | 'held' | 'unconfirmed' | 'failed';
export interface RecipeStatus {
  platform: string;
  recipe: { origin: LoadedRecipe['origin']; verified: boolean; steps: number } | null;
  matches: number; misses: number; confirmed: number; runs: number;
  promote_n: number; promote_runs: number; proposed: boolean;
}

export interface RecipeService {
  load(platform: string): LoadedRecipe | null;
  signals(platform: string): ConfirmSignals | null;
  recordAutofill(platform: string, hit: boolean): void;
  noteFilled(n: FillNote): void;
  noteOutcome(n: { platform: string; jobId: string; outcome: Outcome }): { promoted: boolean };
  propose(platform: string, recipe: unknown): { ok: true } | { ok: false; code: string };
  status(platform: string): RecipeStatus;
}

/** A selector built only from the extractor's id or name handle; null when it is not plainly safe. */
export function handleSelector(raw: RawField | undefined, type: string): string | null {
  if (!raw) return null;
  const tag = type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input';
  let sel: string | null = null;
  if (raw.id && /^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(raw.id)) sel = `#${raw.id}`;
  else if (raw.name && /^[A-Za-z][A-Za-z0-9_.[\]-]{0,60}$/.test(raw.name)) sel = `${tag}[name="${raw.name}"]`;
  return sel && isSafeSelector(sel) ? sel : null;
}

const entryKey = (e: Pick<Entry, 'step' | 'role' | 'selector' | 'type'>): string => `${e.step}|${e.role}|${e.selector}|${e.type}`;

export function createRecipeService(o: {
  learnedDir?: string; shippedDir?: string; runId: string; env?: NodeJS.ProcessEnv; now?: () => Date;
}): RecipeService {
  const learnedDir = o.learnedDir ?? DEFAULT_LEARNED_DIR;
  const store: RecipeStoreOpts = { learnedDir, shippedDir: o.shippedDir };
  const cfg = loadRecipeConfig(o.env ?? process.env);
  const runId = RUN_RE.test(o.runId) ? o.runId : 'norun';
  const buffers = new Map<string, Map<string, Entry>>();

  const candFile = (platform: string): string => path.join(learnedDir, `${platform}.candidate.json`);
  const empty = (platform: string): Candidate => ({ schema: 1, platform, entries: [], confirmed: [], stats: { match: 0, miss: 0 }, proposed: null, proposed_at: 0 });

  function loadCandidate(platform: string): Candidate {
    const text = readSmallFile(candFile(platform), 131072);
    if (text === null) return empty(platform);
    try {
      const r = CandidateSchema.safeParse(JSON.parse(text));
      if (r.success && r.data.platform === platform) return r.data;
    } catch { /* fall through to a fresh file */ }
    return empty(platform);
  }
  function saveCandidate(c: Candidate): void {
    writeFileAtomic(candFile(c.platform), JSON.stringify(c) + '\n');
  }
  const guarded = (fn: () => void): void => {
    try { fn(); } catch { console.error('[recipes] update failed'); }
  };
  const runsOf = (list: Array<{ run: string }>): number => new Set(list.map((c) => c.run)).size;

  function tryPromote(c: Candidate): boolean {
    if (getRecipe(c.platform, store)) return false;
    if (c.proposed) {
      const after = c.confirmed.slice(c.proposed_at);
      if (after.length < cfg.promoteN || runsOf(after) < cfg.promoteRuns) return false;
      saveLearnedRecipe({ ...c.proposed, source: 'learned', verified: true }, learnedDir);
      c.proposed = null;
      return true;
    }
    if (c.confirmed.length < cfg.promoteN || runsOf(c.confirmed) < cfg.promoteRuns) return false;
    const solid = c.entries.filter((e) => e.n >= cfg.promoteN);
    const roles = new Set(solid.map((e) => e.role));
    if (!roles.has('email') || !roles.has('resume')) return false;
    const kinds = [...new Set(solid.map((e) => e.step))];
    const steps = kinds.map((kind) => {
      const fields: RecipeField[] = [];
      for (const e of solid.filter((x) => x.step === kind).sort((a, b) => b.n - a.n)) {
        if (fields.some((f) => f.role === e.role)) continue;
        fields.push({ role: e.role as RecipeField['role'], selector: e.selector, type: e.type, ...(e.role === 'email' || e.role === 'resume' ? { required: true } : {}) });
      }
      const rs = fields.map((f) => f.role);
      return { id: kind, kind, match: { roles: rs, minFields: Math.max(1, Math.ceil(rs.length * 0.75)) }, fields };
    });
    const formRoles = steps.flatMap((s) => s.fields.map((f) => f.role)).filter((r) => r === 'email' || r === 'resume');
    const recipe: Recipe = {
      schema: 1, id: c.platform, platform: c.platform, verified: true, source: 'learned',
      note: 'learned from confirmed applications',
      steps, confirmation: { roles_absent: [...new Set(formRoles)] },
    };
    const v = validateRecipe(recipe);
    if (!v.ok) return false;
    saveLearnedRecipe(v.recipe, learnedDir);
    return true;
  }

  return {
    load: (platform) => (isPlatformId(platform) ? getRecipe(platform, store) : null),
    signals: (platform) => {
      const l = isPlatformId(platform) ? getRecipe(platform, store) : null;
      return l ? confirmSignals(l.recipe) : null;
    },
    recordAutofill(platform, hit) {
      if (!isPlatformId(platform)) return;
      guarded(() => {
        const c = loadCandidate(platform);
        if (hit) c.stats.match = Math.min(c.stats.match + 1, 1_000_000); else c.stats.miss = Math.min(c.stats.miss + 1, 1_000_000);
        saveCandidate(c);
      });
    },
    noteFilled(n) {
      try {
        if (!isPlatformId(n.platform) || NEVER_LEARN_PLATFORMS.has(n.platform) || !JOB_RE.test(n.jobId)) return;
        if (!LEARNABLE.has(n.field.role) || !(RECIPE_STEP_KINDS as readonly string[]).includes(n.stepKind)) return;
        if (!(RECIPE_FIELD_TYPES as readonly string[]).includes(n.field.type)) return;
        const selector = handleSelector(n.raw, n.field.type);
        if (!selector) return;
        const e = { step: n.stepKind as Entry['step'], role: n.field.role, selector, type: n.field.type as Entry['type'], n: 1 };
        const key = `${n.platform}|${n.jobId}`;
        let buf = buffers.get(key);
        if (!buf) {
          if (buffers.size >= MAX_BUFFERS) buffers.delete(buffers.keys().next().value as string);
          buf = new Map();
          buffers.set(key, buf);
        }
        if (buf.size < MAX_ENTRIES) buf.set(entryKey(e), e);
      } catch { console.error('[recipes] note failed'); }
    },
    noteOutcome(n) {
      let promoted = false;
      try {
        const key = `${n.platform}|${n.jobId}`;
        const buf = buffers.get(key);
        buffers.delete(key);
        if (n.outcome !== 'confirmed' || !isPlatformId(n.platform) || NEVER_LEARN_PLATFORMS.has(n.platform) || !JOB_RE.test(n.jobId)) return { promoted: false };
        const c = loadCandidate(n.platform);
        if (c.confirmed.some((x) => x.job === n.jobId)) return { promoted: false };
        for (const e of buf?.values() ?? []) {
          const hit = c.entries.find((x) => entryKey(x) === entryKey(e));
          if (hit) hit.n = Math.min(hit.n + 1, 100000);
          else if (c.entries.length < MAX_ENTRIES) c.entries.push({ ...e, n: 1 });
        }
        c.confirmed.push({ job: n.jobId, run: runId });
        if (c.confirmed.length > MAX_CONFIRMED) {
          const drop = c.confirmed.length - MAX_CONFIRMED;
          c.confirmed = c.confirmed.slice(drop);
          c.proposed_at = Math.max(0, c.proposed_at - drop);
        }
        promoted = tryPromote(c);
        saveCandidate(c);
      } catch { console.error('[recipes] outcome failed'); }
      return { promoted };
    },
    propose(platform, recipe) {
      try {
        if (!isPlatformId(platform)) return { ok: false, code: 'invalid_platform' };
        if (getRecipe(platform, store)) return { ok: false, code: 'recipe_exists' };
        const base = typeof recipe === 'object' && recipe !== null ? (recipe as Record<string, unknown>) : {};
        const v = validateRecipe({ ...base, source: 'proposed', verified: false });
        if (!v.ok) return { ok: false, code: 'invalid_recipe' };
        if (v.recipe.platform !== platform) return { ok: false, code: 'platform_mismatch' };
        const c = loadCandidate(platform);
        c.proposed = v.recipe;
        c.proposed_at = c.confirmed.length;
        saveCandidate(c);
        return { ok: true };
      } catch {
        return { ok: false, code: 'store_error' };
      }
    },
    status(platform) {
      const c = isPlatformId(platform) ? loadCandidate(platform) : empty('none');
      const l = isPlatformId(platform) ? getRecipe(platform, store) : null;
      return {
        platform,
        recipe: l ? { origin: l.origin, verified: l.recipe.verified, steps: l.recipe.steps.length } : null,
        matches: c.stats.match, misses: c.stats.miss, confirmed: c.confirmed.length, runs: runsOf(c.confirmed),
        promote_n: cfg.promoteN, promote_runs: cfg.promoteRuns, proposed: c.proposed !== null,
      };
    },
  };
}
