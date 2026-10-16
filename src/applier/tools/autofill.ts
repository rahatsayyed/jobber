// apply_autofill, apply_recipe, apply_propose_recipe (plan 8G-2 task 19).
//
// apply_autofill is the fast path: when the open page matches a step of the platform's recipe it fills the
// planned fields through the same typed fill and upload handlers the operator uses by hand (so every guard
// of those tools still applies), clicks next between steps, and stops at the review step or at the last
// form. It never clicks submit. When the layout does not match (drift, unknown step, no recipe) it returns
// recipe_miss with the screened page state and the operator continues by hand. Results carry ids only.
import { z } from 'zod';
import { RecipeObject, validateRecipe } from '../recipes/schema.js';
import { matchStep, planFields, unresolvedFields, type PlanItem, type RecipeVerdict } from '../recipes/autofill.js';
import type { Recipe } from '../recipes/schema.js';
import {
  envOf, inPage, layoutDriftRefusal, preflight, refuse, type ApplierDeps, type ApplyResult,
} from './common.js';
import { handleFill } from './fill.js';
import { handleUpload } from './upload.js';
import { handleNext, maxSteps } from './next.js';
import { handleState, screenedState } from './state.js';

export const AutofillInput = z.object({}).strict();
export const RecipeInput = z.object({}).strict();
// A proposal carries structure only: no free note, and source and verified are set by code.
export const ProposeInput = z.object({ recipe: RecipeObject.omit({ note: true, source: true, verified: true }) }).strict();

interface Snap {
  stepKind: string;
  verdict: RecipeVerdict;
  plan: PlanItem[];
  unresolved: string[];
  nextId: string | null;
  state: string;
}

async function analyze(deps: ApplierDeps, recipe: Recipe): Promise<{ snap: Snap } | { res: ApplyResult }> {
  let snap: Snap | null = null as Snap | null;
  const res = await inPage(deps, async ({ job, model, layout }) => {
    const drift = layoutDriftRefusal(deps, job, model, layout);
    if (drift) return drift;
    const verdict = matchStep(recipe, model);
    const usable = verdict.step !== null && (verdict.class === 'match' || verdict.class === 'partial');
    const nexts = model.controls.filter((c) => c.kind === 'next');
    const s = await screenedState(model, 'read', deps);
    if (!s.ok) return s.result;
    snap = {
      stepKind: model.stepKind,
      verdict,
      plan: usable ? planFields(verdict.step!, model, deps.answers) : [],
      unresolved: unresolvedFields(model),
      nextId: nexts.length === 1 ? nexts[0].id : null,
      state: s.state,
    };
    return { status: 'ok', code: 'analyzed' };
  });
  return snap ? { snap } : { res };
}

export async function handleAutofill(_input: z.infer<typeof AutofillInput>, deps: ApplierDeps): Promise<ApplyResult> {
  const g = preflight(deps);
  if (g) return g;
  const job = deps.state.cur;
  if (!job) return refuse('no_job', 'call apply_open first');
  if (job.submitted) return refuse('already_submitted', 'this application was already submitted');
  const filled: string[] = [];
  const loaded = deps.recipes?.load(job.platform) ?? null;

  if (!loaded) {
    const s = await handleState(deps);
    if (s.status !== 'ok') return s;
    return { status: 'ok', code: 'recipe_miss', reason: 'no_recipe', platform: job.platform, state: s.state, filled };
  }

  const limit = Math.min(maxSteps(envOf(deps)), 8);
  for (let i = 0; i < limit; i++) {
    const a = await analyze(deps, loaded.recipe);
    if ('res' in a) return { ...a.res, filled };
    const s0 = a.snap;
    if (s0.stepKind === 'review') {
      return { status: 'ok', code: 'stopped_before_submit', platform: job.platform, state: s0.state, filled, unresolved: s0.unresolved };
    }
    const hit = s0.verdict.class === 'match' || s0.verdict.class === 'partial';
    deps.recipes?.recordAutofill(job.platform, hit);
    if (!hit) {
      return { status: 'ok', code: 'recipe_miss', reason: s0.verdict.class, platform: job.platform, state: s0.state, filled, unresolved: s0.unresolved };
    }

    for (const item of s0.plan) {
      const r = item.action === 'upload'
        ? await handleUpload({ field: item.id }, deps)
        : await handleFill({ field: item.id, ref: item.ref as never }, deps);
      if (r.status === 'ok') filled.push(item.id);
      else if (r.status === 'dry_run') return { status: 'dry_run', code: 'dry_run', filled: [] };
      else if (r.status === 'blocked' || r.status === 'failed' || r.status === 'rate_limited') return { ...r, filled };
      // refused or needs_owner: the field stays open and shows up as unresolved
    }

    const b = await analyze(deps, loaded.recipe);
    if ('res' in b) return { ...b.res, filled };
    const s1 = b.snap;
    if (s1.unresolved.length > 0) {
      return { status: 'ok', code: 'autofill_incomplete', platform: job.platform, state: s1.state, filled, unresolved: s1.unresolved };
    }
    if (s1.stepKind === 'review' || s1.nextId === null) {
      return { status: 'ok', code: 'stopped_before_submit', platform: job.platform, state: s1.state, filled, unresolved: [] };
    }
    const n = await handleNext({ control: s1.nextId }, deps);
    if (n.status !== 'ok') return { ...n, filled, unresolved: [] };
  }
  const end = await handleState(deps);
  return { status: 'ok', code: 'step_limit', platform: job.platform, ...(end.state ? { state: end.state } : {}), filled, unresolved: [] };
}

export async function handleRecipe(_input: z.infer<typeof RecipeInput>, deps: ApplierDeps): Promise<ApplyResult> {
  const g = preflight(deps);
  if (g) return g;
  const job = deps.state.cur;
  if (!job) return refuse('no_job', 'call apply_open first');
  const st = deps.recipes?.status(job.platform);
  return {
    status: 'ok', code: 'recipe_status', platform: job.platform,
    info: {
      recipe: st?.recipe?.origin ?? 'none',
      verified: st?.recipe?.verified ?? false,
      steps: st?.recipe?.steps ?? 0,
      matches: st?.matches ?? 0,
      misses: st?.misses ?? 0,
      confirmed: st?.confirmed ?? 0,
      runs: st?.runs ?? 0,
      promote_n: st?.promote_n ?? 0,
      promote_runs: st?.promote_runs ?? 0,
      proposed: st?.proposed ?? false,
    },
  };
}

/**
 * The agent may propose a recipe for the platform of the open job. It is validated like any recipe (closed
 * vocabulary, safe selectors, role-checked refs), stored dormant, and promoted only by later confirmed
 * submitted applications. It never replaces an existing recipe.
 */
export async function handlePropose(input: z.infer<typeof ProposeInput>, deps: ApplierDeps): Promise<ApplyResult> {
  const g = preflight(deps);
  if (g) return g;
  const job = deps.state.cur;
  if (!job) return refuse('no_job', 'call apply_open first');
  if (!deps.recipes) return refuse('no_recipes', 'recipe storage is not configured');
  const v = validateRecipe({ ...input.recipe, source: 'proposed', verified: false });
  if (!v.ok) return refuse('invalid_recipe', v.why);
  if (v.recipe.platform !== job.platform) return refuse('platform_mismatch', 'a recipe may only be proposed for the platform of the open job');
  const r = deps.recipes.propose(job.platform, input.recipe);
  if (!r.ok) return refuse(r.code, 'the proposal was not stored');
  return { status: 'ok', code: 'recipe_proposed', platform: job.platform };
}
