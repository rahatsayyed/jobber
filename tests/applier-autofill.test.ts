import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleNext } from '../src/applier/tools/next.js';
import { handleState } from '../src/applier/tools/state.js';
import { handleSubmit } from '../src/applier/tools/submit.js';
import { APPLIER_TOOL_SCHEMAS } from '../src/applier/tools/index.js';
import { handleAutofill, AutofillInput } from '../src/applier/tools/autofill.js';
import { createRecipeService } from '../src/applier/recipes/learn.js';
import { matchStep } from '../src/applier/recipes/autofill.js';
import type { Recipe } from '../src/applier/recipes/schema.js';
import { createAtsLayoutGuard } from '../src/applier/recipes/layoutGuard.js';
import { createLayoutObserver } from '../src/layout/runtime.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { observeAts } from '../src/layout/fingerprint.js';
import { parseLayoutText } from '../src/layout/store.js';
import { extractFormModel } from '../src/webcore/formModel.js';
import { loadFixture } from './helpers/fixtureSite.js';
import { WHY, makeApplier, type ApplierHarness, type HarnessOpts } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const NOW = new Date('2026-10-16T10:00:00.000Z');

async function opened(o: HarnessOpts = {}, recipes = true): Promise<ApplierHarness> {
  h = makeApplier(o);
  if (recipes) h.deps.recipes = createRecipeService({ learnedDir: path.join(h.dir, 'recipes'), runId: 'run1', env: h.env, now: () => NOW });
  const r = await handleOpen({ job_id: 'job-1' }, h.deps);
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return h;
}
const clicks = (x: ApplierHarness) => x.site.events.filter((e) => e.startsWith('click:control'));

describe('apply_autofill', () => {
  it('input schema is registered and takes no arguments', () => {
    expect(Object.keys(APPLIER_TOOL_SCHEMAS)).toEqual(expect.arrayContaining(['apply_autofill', 'apply_recipe', 'apply_propose_recipe']));
    expect(AutofillInput.safeParse({}).success).toBe(true);
    expect(AutofillInput.safeParse({ value: 'x' }).success).toBe(false);
  });

  it('autofill on ats-a and ats-b fixtures fills exactly the expected fields and stops before submit', async () => {
    let x = await opened();
    const r = await handleAutofill({}, x.deps);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'ok', code: 'stopped_before_submit', filled: ['f1', 'f3', 'f4', 'f5', 'f8'], unresolved: [] });
    // last name was already on the page, the linkedin box and the cover letter are not in the recipe, the honeypot is hidden
    expect(x.site.fills.map((f) => f.value)).toEqual(['Jane', 'jane.fixture@example.com', '+00 1112223333', WHY]);
    expect(x.site.uploads).toEqual([{ label: 'Resume/CV *', path: x.resumePath }]);
    expect(clicks(x)).toEqual([]);
    expect(x.db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
    // no typed value or path travels back to the model
    const blob = JSON.stringify(r);
    for (const v of ['Jane', 'jane.fixture', '+00 1112223333', WHY, x.resumePath]) expect(blob).not.toContain(v);
    expect((r as { state?: string }).state).toContain('step=form');
    await x.close(); h = null;

    x = await opened({ start: 'ats-b-form.html', applyUrl: 'https://jobs.lever.co/beta/1', platform: 'lever' });
    const b = await handleAutofill({}, x.deps);
    expect(b, JSON.stringify(b)).toMatchObject({ status: 'ok', code: 'stopped_before_submit', filled: ['f1', 'f2', 'f3', 'f4', 'f5'], unresolved: [] });
    expect(x.site.fills.map((f) => f.value)).toEqual(['Jane Q Fixture', 'jane.fixture@example.com', 'Fixture City', 'https://linkedin.com/in/fixture-person']);
    expect(x.site.uploads).toHaveLength(1);
    expect(x.site.selections).toEqual([]);   // self-identification is never touched by the fast path
    expect(clicks(x)).toEqual([]);
  });

  it('a required question the answer book cannot answer is returned as unresolved, not guessed', async () => {
    const x = await opened({ why: false });
    const r = await handleAutofill({}, x.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'autofill_incomplete', unresolved: ['f8'] });
    expect(x.site.fills.map((f) => f.value)).not.toContain(WHY);
    expect(clicks(x)).toEqual([]);
  });

  it('drifted-ats-a-form returns recipe_miss', async () => {
    const x = await opened({ start: 'drifted-ats-a-form.html' });
    const r = await handleAutofill({}, x.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'recipe_miss', filled: [] });
    expect((r as { state?: string }).state).toContain('Tell us about yourself');
    expect(x.site.fills).toEqual([]);
    expect(x.deps.recipes!.status('greenhouse')).toMatchObject({ matches: 0, misses: 1 });
  });

  const WD_URL = 'https://acme.wd5.myworkdayjobs.com/en-US/x/job/1';
  const WD_STEPS = { 'Save and Continue': [{ fixture: 'wd-step2-questions.html' }, { fixture: 'wd-step3-review.html' }] };

  it('Workday-like three-step fixture without a recipe completes by hand through apply_next to review', async () => {
    const x = await opened({ start: 'wd-step1-personal.html', applyUrl: WD_URL, platform: 'workday', tier: 'agent', transitions: WD_STEPS });
    const r = await handleAutofill({}, x.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'recipe_miss' });
    expect((r as { state?: string }).state).toContain('First Name');
    expect(x.site.fills).toEqual([]);
    const n1 = await handleNext({ control: 'c2' }, x.deps);
    expect(n1, JSON.stringify(n1)).toMatchObject({ status: 'ok', code: 'moved' });
    const n2 = await handleNext({ control: 'c2' }, x.deps);
    expect(n2, JSON.stringify(n2)).toMatchObject({ status: 'ok', code: 'moved' });
    expect((await handleState(x.deps)).state).toContain('step=review');
    expect(x.db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
  });

  it('without a recipe service the tool is a recipe_miss with the state, never an error', async () => {
    const x = await opened({}, false);
    expect(await handleAutofill({}, x.deps)).toMatchObject({ status: 'ok', code: 'recipe_miss' });
  });

  it('dry run fills nothing', async () => {
    const x = await opened({ env: { APPLY_DRY_RUN: 'true' } });
    const r = await handleAutofill({}, x.deps);
    expect(r.status).toBe('dry_run');
    expect(x.site.fills).toEqual([]);
  });

  it('refuses without an open job and under a halt', async () => {
    h = makeApplier({});
    h.deps.recipes = createRecipeService({ learnedDir: path.join(h.dir, 'recipes'), runId: 'run1', env: h.env, now: () => NOW });
    expect(await handleAutofill({}, h.deps)).toMatchObject({ status: 'refused', code: 'no_job' });
  });
});

describe('layout drift', () => {
  const cfg = (dir: string, enforce: 'warn' | 'enforce') => ({ ...loadLayoutConfig({}), dir, enforce });

  function learnAtsA(dir: string, c: ReturnType<typeof cfg>): void {
    const model = extractFormModel(loadFixture('ats-a-form.html', 'https://boards.greenhouse.io/acme/jobs/1'));
    for (const run of ['ra', 'rb', 'ra']) {
      createLayoutObserver({ platform: 'ats_greenhouse', cfg: c, now: () => NOW, runId: run }).observeAts(model);
    }
  }

  it('every autofill read feeds layout memory with vocabulary ids only', async () => {
    const x = await opened();
    const dir = path.join(x.dir, 'layout');
    x.deps.layoutGuard = createAtsLayoutGuard({ cfg: cfg(dir, 'warn'), db: x.db, now: () => NOW, runId: 'run1' });
    await handleAutofill({}, x.deps);
    const text = fs.readFileSync(path.join(dir, 'ats_greenhouse.json'), 'utf8');
    expect(parseLayoutText(text, 'ats_greenhouse').ok).toBe(true);
    expect(text).not.toMatch(/Resume\/CV|Why do you want|first_name|Submit Application/);
  });

  it('under warn a drifted page is only a recipe_miss; under enforce autofill and submit refuse with layout_drift and escalate', async () => {
    let x = await opened({ start: 'drifted-ats-a-form.html' });
    let dir = path.join(x.dir, 'layout');
    learnAtsA(dir, cfg(dir, 'warn'));
    x.deps.layoutGuard = createAtsLayoutGuard({ cfg: cfg(dir, 'warn'), db: x.db, now: () => NOW, runId: 'run1' });
    expect(await handleAutofill({}, x.deps)).toMatchObject({ code: 'recipe_miss' });
    expect(x.db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE platform = 'apply'").get()).toEqual({ n: 0 });
    await x.close(); h = null;

    x = await opened({ start: 'drifted-ats-a-form.html', env: { APPLY_SUBMIT_MODE: 'submit' } });
    dir = path.join(x.dir, 'layout');
    learnAtsA(dir, cfg(dir, 'enforce'));
    x.deps.layoutGuard = createAtsLayoutGuard({ cfg: cfg(dir, 'enforce'), db: x.db, now: () => NOW, runId: 'run1' });
    expect(await handleAutofill({}, x.deps)).toMatchObject({ status: 'refused', code: 'layout_drift' });
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'refused', code: 'layout_drift' });
    expect(x.site.events.filter((e) => e.startsWith('click'))).toEqual([]);
    const rows = x.db.prepare("SELECT reason, detail FROM escalations WHERE platform = 'apply'").all() as Array<{ reason: string; detail: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].reason).toBe('layout_drift');
    expect(rows[0].detail).toMatch(/^platform=greenhouse kind=form$/);
  });

  it('the observer escalation path for an ATS platform never halts anything', () => {
    const x = makeApplier({});
    h = x;
    const c = cfg(path.join(x.dir, 'layout'), 'enforce');
    const model = extractFormModel(loadFixture('ats-a-form.html', 'https://boards.greenhouse.io/acme/jobs/1'));
    const drifted = extractFormModel(loadFixture('drifted-ats-a-form.html', 'https://boards.greenhouse.io/acme/jobs/1'));
    for (const run of ['ra', 'rb', 'ra']) createLayoutObserver({ platform: 'ats_greenhouse', cfg: c, now: () => NOW, runId: run, db: x.db, notify: () => undefined }).observeAts(model);
    for (const run of ['rc', 'rd', 'rc', 'rd', 'rc', 'rd']) createLayoutObserver({ platform: 'ats_greenhouse', cfg: c, now: () => NOW, runId: run, db: x.db, notify: () => undefined }).observeAts(drifted);
    expect(x.db.prepare('SELECT COUNT(*) AS n FROM halt_flags').get()).toEqual({ n: 0 });
    expect(x.db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE platform = 'apply'").get()).toMatchObject({ n: expect.any(Number) });
    expect(observeAts(model, 'ats_greenhouse').platform).toBe('ats_greenhouse');
  });
});

describe('matchStep verdicts', () => {
  const model = () => extractFormModel(loadFixture('ats-a-form.html', 'https://boards.greenhouse.io/acme/jobs/1'));
  const recipe = (roles: string[], minFields: number, required: string[] = []): Recipe => ({
    schema: 1, id: 'acme', platform: 'acme', verified: false, source: 'proposed',
    steps: [{
      id: 'form', kind: 'form', match: { roles: roles as never, minFields },
      fields: roles.map((r) => ({ role: r as never, selector: '#x', type: 'text' as const, ...(required.includes(r) ? { required: true } : {}) })),
    }],
    confirmation: { roles_absent: [] },
  });

  it('match, partial, drift and unknown', () => {
    expect(matchStep(recipe(['email', 'resume'], 2), model()).class).toBe('match');
    expect(matchStep(recipe(['email', 'resume', 'name.full'], 2), model()).class).toBe('partial');
    expect(matchStep(recipe(['email', 'resume', 'name.full', 'location'], 3), model()).class).toBe('drift');
    expect(matchStep(recipe(['email', 'resume', 'name.full'], 2, ['name.full']), model()).class).toBe('drift');
    const review = { ...model(), stepKind: 'review' as const };
    expect(matchStep(recipe(['email'], 1), review).class).toBe('unknown');
  });
});
