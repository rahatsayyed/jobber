import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecipeService, loadRecipeConfig, type RecipeService } from '../src/applier/recipes/learn.js';
import { getRecipe } from '../src/applier/recipes/store.js';
import { validateRecipe } from '../src/applier/recipes/schema.js';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleFill } from '../src/applier/tools/fill.js';
import { handleUpload } from '../src/applier/tools/upload.js';
import { handleSubmit } from '../src/applier/tools/submit.js';
import { handleRecipe, handlePropose } from '../src/applier/tools/autofill.js';
import { makeApplier, type ApplierHarness } from './helpers/applierHarness.js';
import type { FormField, RawField } from '../src/webcore/formModel.js';

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-learn-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-10-16T10:00:00.000Z');
const svc = (runId: string, env: NodeJS.ProcessEnv = {}): RecipeService => createRecipeService({ learnedDir: dir, runId, env, now: () => NOW });

const field = (id: string, role: FormField['role'], type: string, required = true): FormField =>
  ({ id, role, label: 'x', type, required, filled: false, hidden: false });
const raw = (over: Partial<RawField>): RawField => ({ type: 'text', name: '', label: 'x', required: true, filled: false, hidden: false, ...over });

/** One application by hand: the operator filled three fields; code records what the extractor saw. */
function byHand(s: RecipeService, platform: string, jobId: string): void {
  const notes: Array<[FormField, RawField]> = [
    [field('f1', 'name.full', 'text'), raw({ id: 'full_name' })],
    [field('f2', 'email', 'email'), raw({ type: 'email', name: 'email' })],
    [field('f3', 'resume', 'file'), raw({ type: 'file', name: 'cv' })],
  ];
  for (const [f, r] of notes) s.noteFilled({ platform, jobId, stepKind: 'form', field: f, raw: r });
}

describe('recipe learning', () => {
  it('config: defaults 3 and 2, clamped', () => {
    expect(loadRecipeConfig({})).toEqual({ promoteN: 3, promoteRuns: 2 });
    expect(loadRecipeConfig({ APPLY_RECIPE_PROMOTE_N: '5', APPLY_RECIPE_PROMOTE_RUNS: '4' })).toEqual({ promoteN: 5, promoteRuns: 4 });
    expect(loadRecipeConfig({ APPLY_RECIPE_PROMOTE_N: 'x', APPLY_RECIPE_PROMOTE_RUNS: '0' })).toEqual({ promoteN: 3, promoteRuns: 2 });
  });

  it('promotion needs N confirmed submits over the required run ids', () => {
    const a = svc('run-a');
    byHand(a, 'recruitee', 'j1'); expect(a.noteOutcome({ platform: 'recruitee', jobId: 'j1', outcome: 'confirmed' }).promoted).toBe(false);
    byHand(a, 'recruitee', 'j2'); expect(a.noteOutcome({ platform: 'recruitee', jobId: 'j2', outcome: 'confirmed' }).promoted).toBe(false);
    byHand(a, 'recruitee', 'j3'); expect(a.noteOutcome({ platform: 'recruitee', jobId: 'j3', outcome: 'confirmed' }).promoted).toBe(false);   // 3 confirmed, 1 run id
    expect(getRecipe('recruitee', { learnedDir: dir })).toBeNull();
    expect(a.status('recruitee')).toMatchObject({ confirmed: 3, runs: 1, promote_n: 3, promote_runs: 2, recipe: null });

    const b = svc('run-b');
    byHand(b, 'recruitee', 'j4');
    expect(b.noteOutcome({ platform: 'recruitee', jobId: 'j4', outcome: 'confirmed' }).promoted).toBe(true);
    const got = getRecipe('recruitee', { learnedDir: dir });
    expect(got?.origin).toBe('learned');
    expect(validateRecipe(got!.recipe).ok).toBe(true);
    expect(got!.recipe).toMatchObject({ source: 'learned', verified: true });
    const fields = got!.recipe.steps[0].fields;
    expect(fields.map((f) => f.role).sort()).toEqual(['email', 'name.full', 'resume']);
    expect(fields.map((f) => f.selector).sort()).toEqual(['#full_name', 'input[name="cv"]', 'input[name="email"]']);
    expect(b.status('recruitee').recipe).toMatchObject({ origin: 'learned', verified: true });
  });

  it('the same job confirmed twice counts once', () => {
    const a = svc('run-a');
    for (let i = 0; i < 4; i++) { byHand(a, 'recruitee', 'same'); a.noteOutcome({ platform: 'recruitee', jobId: 'same', outcome: 'confirmed' }); }
    expect(a.status('recruitee').confirmed).toBe(1);
  });

  it('held and unconfirmed never promote and leave no candidate entries', () => {
    const a = svc('run-a');
    const b = svc('run-b');
    for (let i = 0; i < 6; i++) {
      const s = i % 2 ? a : b;
      byHand(s, 'recruitee', `h${i}`);
      s.noteOutcome({ platform: 'recruitee', jobId: `h${i}`, outcome: i % 3 === 0 ? 'held' : i % 3 === 1 ? 'unconfirmed' : 'failed' });
    }
    expect(a.status('recruitee')).toMatchObject({ confirmed: 0, runs: 0, recipe: null });
    expect(getRecipe('recruitee', { learnedDir: dir })).toBeNull();
    const cand = path.join(dir, 'recruitee.candidate.json');
    const body = fs.existsSync(cand) ? JSON.parse(fs.readFileSync(cand, 'utf8')) : { entries: [], confirmed: [] };
    expect(body.entries).toEqual([]);
    expect(body.confirmed).toEqual([]);
    // fills that were never followed by any outcome do not count either
    byHand(a, 'recruitee', 'orphan');
    expect(a.status('recruitee').confirmed).toBe(0);
  });

  it('a platform with a shipped recipe is tracked but never overwritten', () => {
    const a = svc('run-a'); const b = svc('run-b');
    for (const [s, j] of [[a, 'g1'], [a, 'g2'], [b, 'g3']] as const) { byHand(s, 'greenhouse', j); s.noteOutcome({ platform: 'greenhouse', jobId: j, outcome: 'confirmed' }); }
    expect(a.status('greenhouse').confirmed).toBe(3);
    expect(fs.existsSync(path.join(dir, 'greenhouse.json'))).toBe(false);
    expect(getRecipe('greenhouse', { learnedDir: dir })?.origin).toBe('shipped');
  });

  it('hostile or unsafe handles are not recorded', () => {
    const a = svc('run-a');
    a.noteFilled({ platform: 'recruitee', jobId: 'x', stepKind: 'form', field: field('f1', 'email', 'email'), raw: raw({ type: 'email', id: 'a"],[onclick', name: 'javascript:alert(1)' }) });
    a.noteFilled({ platform: 'recruitee', jobId: 'x', stepKind: 'form', field: field('f2', 'email', 'email'), raw: raw({ type: 'email', name: 'ok' }) });
    a.noteFilled({ platform: '../x', jobId: 'x', stepKind: 'form', field: field('f3', 'email', 'email'), raw: raw({ id: 'e' }) });
    a.noteFilled({ platform: 'browser', jobId: 'x', stepKind: 'form', field: field('f4', 'email', 'email'), raw: raw({ id: 'e' }) });
    a.noteFilled({ platform: 'recruitee', jobId: 'x', stepKind: 'form', field: field('f5', 'question', 'text'), raw: raw({ id: 'q' }) });
    a.noteOutcome({ platform: 'recruitee', jobId: 'x', outcome: 'confirmed' });
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'recruitee.candidate.json'), 'utf8'));
    expect(body.entries.map((e: { selector: string }) => e.selector)).toEqual(['input[name="ok"]']);
    expect(fs.readdirSync(dir).sort()).toEqual(['recruitee.candidate.json']);
  });

  it('a proposed recipe is validated, stays dormant, and is promoted only by later confirmed submits', () => {
    const a = svc('run-a');
    const proposal = {
      schema: 1, id: 'recruitee', platform: 'recruitee', verified: true, source: 'learned',
      steps: [{ id: 'form', kind: 'form', match: { roles: ['email', 'resume'], minFields: 2 }, fields: [
        { role: 'email', selector: '#mail', type: 'email', required: true }, { role: 'resume', selector: '#cv', type: 'file', required: true }] }],
      confirmation: { roles_absent: ['email'] },
    };
    expect(a.propose('recruitee', { ...proposal, steps: [{ ...proposal.steps[0], fields: [{ role: 'email', selector: 'a;b', type: 'email' }] }] } as never)).toMatchObject({ ok: false });
    expect(a.propose('recruitee', proposal as never)).toEqual({ ok: true });
    expect(getRecipe('recruitee', { learnedDir: dir })).toBeNull();            // dormant
    expect(a.propose('greenhouse', { ...proposal, id: 'greenhouse', platform: 'greenhouse' } as never)).toMatchObject({ ok: false, code: 'recipe_exists' });
    const b = svc('run-b');
    for (const [s, j] of [[a, 'p1'], [a, 'p2'], [b, 'p3']] as const) { byHand(s, 'recruitee', j); s.noteOutcome({ platform: 'recruitee', jobId: j, outcome: 'confirmed' }); }
    const got = getRecipe('recruitee', { learnedDir: dir });
    expect(got?.origin).toBe('learned');
    expect(got!.recipe.steps[0].fields.map((f) => f.selector).sort()).toEqual(['#cv', '#mail']);   // the proposal, not the hand-fills
  });

  it('autofill hit and miss counters are kept', () => {
    const a = svc('run-a');
    a.recordAutofill('greenhouse', true); a.recordAutofill('greenhouse', true); a.recordAutofill('greenhouse', false);
    expect(a.status('greenhouse')).toMatchObject({ matches: 2, misses: 1 });
  });

  it('a corrupt candidate file is replaced, never trusted', () => {
    fs.writeFileSync(path.join(dir, 'recruitee.candidate.json'), '{"entries": "oops"');
    const a = svc('run-a');
    byHand(a, 'recruitee', 'j1');
    a.noteOutcome({ platform: 'recruitee', jobId: 'j1', outcome: 'confirmed' });
    expect(a.status('recruitee').confirmed).toBe(1);
  });
});

describe('learning through the real tools', () => {
  let h: ApplierHarness | null = null;
  afterEach(async () => { await h?.close(); h = null; });

  async function run(env: NodeJS.ProcessEnv): Promise<ApplierHarness> {
    h = makeApplier({ env, transitions: { 'Submit Application': [{ fixture: 'ats-a-confirmation.html' }] } });
    h.deps.recipes = createRecipeService({ learnedDir: path.join(h.dir, 'recipes'), runId: 'run1', env: h.env, now: () => NOW });
    h.deps.recipeSignals = (p) => h!.deps.recipes!.signals(p);
    expect((await handleOpen({ job_id: 'job-1' }, h.deps)).status).toBe('ok');
    expect((await handleFill({ field: 'f1', ref: { kind: 'profile', field: 'name.first' } }, h.deps)).status).toBe('ok');
    expect((await handleFill({ field: 'f3', ref: { kind: 'profile', field: 'email' } }, h.deps)).status).toBe('ok');
    expect((await handleUpload({ field: 'f5' }, h.deps)).status).toBe('ok');
    expect((await handleFill({ field: 'f8', ref: { kind: 'answer', key: 'custom:Why do you want to work here?' } }, h.deps)).status).toBe('ok');
    return h;
  }

  it('a confirmed submit counts once, a held submit never', async () => {
    let x = await run({ APPLY_SUBMIT_MODE: 'hold' });
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'held' });
    expect(x.deps.recipes!.status('greenhouse').confirmed).toBe(0);
    await x.close(); h = null;

    x = await run({ APPLY_SUBMIT_MODE: 'submit' });
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'submitted' });
    expect(x.deps.recipes!.status('greenhouse')).toMatchObject({ confirmed: 1, runs: 1 });
    const cand = JSON.parse(fs.readFileSync(path.join(x.dir, 'recipes', 'greenhouse.candidate.json'), 'utf8'));
    expect(cand.entries.map((e: { role: string }) => e.role).sort()).toEqual(['email', 'name.first', 'resume']);
    expect(JSON.stringify(cand)).not.toMatch(/Jane|jane\.fixture|Why do you want/);
  });

  it('an unconfirmed submit never counts', async () => {
    h = makeApplier({ env: { APPLY_SUBMIT_MODE: 'submit' } });   // no transition: the page stays on the form
    h.deps.recipes = createRecipeService({ learnedDir: path.join(h.dir, 'recipes'), runId: 'run1', env: h.env, now: () => NOW });
    await handleOpen({ job_id: 'job-1' }, h.deps);
    await handleFill({ field: 'f1', ref: { kind: 'profile', field: 'name.first' } }, h.deps);
    await handleFill({ field: 'f3', ref: { kind: 'profile', field: 'email' } }, h.deps);
    await handleUpload({ field: 'f5' }, h.deps);
    await handleFill({ field: 'f8', ref: { kind: 'answer', key: 'custom:Why do you want to work here?' } }, h.deps);
    const r = await handleSubmit({}, h.deps);
    expect(r.status).toBe('unconfirmed');
    expect(h.deps.recipes.status('greenhouse').confirmed).toBe(0);
  });

  it('apply_recipe reports status and apply_propose_recipe validates and needs a matching open job', async () => {
    h = makeApplier({});
    h.deps.recipes = createRecipeService({ learnedDir: path.join(h.dir, 'recipes'), runId: 'run1', env: h.env, now: () => NOW });
    expect(await handleRecipe({}, h.deps)).toMatchObject({ status: 'refused', code: 'no_job' });
    await handleOpen({ job_id: 'job-1' }, h.deps);
    const s = await handleRecipe({}, h.deps);
    expect(s).toMatchObject({ status: 'ok', code: 'recipe_status', platform: 'greenhouse' });
    expect(s.info).toMatchObject({ recipe: 'shipped', verified: true, matches: 0, misses: 0, confirmed: 0 });
    const bad = await handlePropose({ recipe: { id: 'x' } as never }, h.deps);
    expect(bad).toMatchObject({ status: 'refused', code: 'invalid_recipe' });
    const other = { schema: 1, id: 'recruitee', platform: 'recruitee', verified: false, source: 'proposed', steps: [{ id: 'form', kind: 'form', match: { roles: ['email'], minFields: 1 }, fields: [{ role: 'email', selector: '#mail', type: 'email' }] }], confirmation: { roles_absent: ['email'] } };
    expect(await handlePropose({ recipe: other as never }, h.deps)).toMatchObject({ status: 'refused', code: 'platform_mismatch' });
    expect(await handlePropose({ recipe: { ...other, id: 'greenhouse', platform: 'greenhouse' } as never }, h.deps)).toMatchObject({ status: 'refused', code: 'recipe_exists' });
  });
});
