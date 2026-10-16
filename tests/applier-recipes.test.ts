import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSafeSelector } from '../src/applier/recipes/safeSelector.js';
import { validateRecipe, defaultRefFor, type Recipe } from '../src/applier/recipes/schema.js';
import { getRecipe, loadShippedRecipe, shippedRecipeIds, saveLearnedRecipe } from '../src/applier/recipes/store.js';
import { ATS_REGISTRY } from '../src/apply/registry.js';
import { migrateLearned } from '../scripts/migrate-learned-ats.js';

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-recipes-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const base = (): Recipe => ({
  schema: 1, id: 'acme', platform: 'acme', verified: false, source: 'proposed',
  steps: [{
    id: 'form', kind: 'form', match: { roles: ['email', 'resume'], minFields: 2 },
    fields: [
      { role: 'email', selector: '#email', type: 'email', required: true },
      { role: 'resume', selector: 'input[type="file"]', type: 'file', required: true },
    ],
  }],
  confirmation: { roles_absent: ['email'] },
});

describe('shipped recipes', () => {
  it('shipped recipes validate', () => {
    expect(shippedRecipeIds().sort()).toEqual(['ashby', 'greenhouse', 'lever', 'smartrecruiters', 'workable']);
    for (const id of shippedRecipeIds()) {
      const r = loadShippedRecipe(id);
      expect(r, id).not.toBeNull();
      expect(validateRecipe(r).ok, id).toBe(true);
      expect(r!.id).toBe(id);
      expect(r!.source).toBe('shipped');
    }
    for (const id of ['greenhouse', 'lever', 'ashby']) expect(loadShippedRecipe(id)!.verified).toBe(true);
    for (const id of ['workable', 'smartrecruiters']) expect(loadShippedRecipe(id)!.verified).toBe(false);
  });

  it('registry marks exactly the recipe platforms fast and points at their recipes', () => {
    for (const a of ATS_REGISTRY) {
      if (shippedRecipeIds().includes(a.id)) {
        expect(a.tier, a.id).toBe('fast');
        expect(a.recipeId, a.id).toBe(a.id);
      } else {
        expect(a.tier, a.id).toBe('agent');
        expect(a.recipeId, a.id).toBeNull();
      }
    }
  });

  it('the first three recipes keep the selectors of their old FieldMaps', () => {
    const gh = loadShippedRecipe('greenhouse')!.steps[0].fields.map((f) => f.selector);
    expect(gh).toEqual(expect.arrayContaining(['#first_name', '#last_name', '#email', '#phone', '#resume']));
    expect(loadShippedRecipe('greenhouse')!.steps[0].submit?.selector).toBe('#submit_app');
    expect(loadShippedRecipe('lever')!.steps[0].fields.map((f) => f.selector)).toEqual(expect.arrayContaining(['input[name="name"]', 'input[name="email"]', 'input[name="resume"]']));
    expect(loadShippedRecipe('ashby')!.steps[0].fields.map((f) => f.selector)).toEqual(expect.arrayContaining(['input[id^="_systemfield_name"]', 'input[id^="_systemfield_email"]']));
  });
});

describe('selector safety', () => {
  const GOOD = ['#email', '.field', 'input', 'input[type="file"]', 'input[name="urls[LinkedIn]"]', 'input[id^="_systemfield_name"]', 'button[type="submit"]', '[data-x]', 'form .row > input.a', 'a, b'];
  const BAD = [
    '', ' ', 'javascript:alert(1)', 'a[href^="javascript:alert(1)"]', '<script>', 'input<b', 'a{color:red}', 'a;b', 'a { }', 'url(http://x)', 'input[style="x:expression(1)"]',
    'a'.repeat(300), '#email, #b, #c, #d, #e', 'input:hover', ':root', 'a:not(b)','a\nb', 'a[b="c`d"]', '@import', 'a\\b', '#a #b #c #d #e', 'input[name="x"] ,',
    'a[b="<img src=x>"]', 'a[b="{"]', 'x[a=b c]',
  ];
  it('hostile selectors rejected', () => {
    for (const s of BAD) expect(isSafeSelector(s), JSON.stringify(s)).toBe(false);
    for (const s of GOOD) expect(isSafeSelector(s), s).toBe(true);
    expect(isSafeSelector(undefined as unknown as string)).toBe(false);
  });

  it('a recipe with a hostile selector or ref is rejected', () => {
    const r = base();
    r.steps[0].fields[0].selector = 'a[href^="javascript:x"]';
    expect(validateRecipe(r).ok).toBe(false);
    const s = base();
    s.steps[0].submit = { selector: '#x; drop' };
    expect(validateRecipe(s).ok).toBe(false);
    const m = base();
    m.steps[0].fields[0].ref = { kind: 'resume_pdf' };
    expect(validateRecipe(m).ok).toBe(false);
    expect(validateRecipe(base()).ok).toBe(true);
  });

  it('schema is closed: unknown keys, roles, kinds and path-like ids fail', () => {
    for (const mutate of [
      (r: Record<string, unknown>) => { r.extra = 1; },
      (r: Record<string, unknown>) => { r.id = '../x'; },
      (r: Record<string, unknown>) => { r.platform = 'A B'; },
      (r: Record<string, unknown>) => { ((r.steps as Array<Record<string, unknown>>)[0]).kind = 'weird'; },
      (r: Record<string, unknown>) => { (((r.steps as Array<Record<string, unknown>>)[0].fields as Array<Record<string, unknown>>)[0]).role = 'password'; },
      (r: Record<string, unknown>) => { r.steps = []; },
      (r: Record<string, unknown>) => { (r.confirmation as Record<string, unknown>).urlPath = 'https://evil.test/x'; },
    ]) {
      const r = JSON.parse(JSON.stringify(base())) as Record<string, unknown>;
      mutate(r);
      expect(validateRecipe(r).ok).toBe(false);
    }
  });

  it('default refs follow the role', () => {
    expect(defaultRefFor('email')).toEqual({ kind: 'profile', field: 'email' });
    expect(defaultRefFor('resume')).toEqual({ kind: 'resume_pdf' });
    expect(defaultRefFor('question')).toBeNull();
    expect(defaultRefFor('cover_letter')).toBeNull();
  });
});

describe('store', () => {
  it('loads shipped first, learned second, and refuses path-like ids', () => {
    expect(getRecipe('greenhouse', { learnedDir: dir })?.origin).toBe('shipped');
    expect(getRecipe('../etc/passwd', { learnedDir: dir })).toBeNull();
    expect(getRecipe('acme', { learnedDir: dir })).toBeNull();
    saveLearnedRecipe({ ...base(), source: 'learned', verified: true }, dir);
    const got = getRecipe('acme', { learnedDir: dir });
    expect(got?.origin).toBe('learned');
    expect(got?.recipe.steps).toHaveLength(1);
    // a shipped recipe wins over a learned file with the same id
    fs.writeFileSync(path.join(dir, 'greenhouse.json'), JSON.stringify({ ...base(), id: 'greenhouse', platform: 'greenhouse' }));
    expect(getRecipe('greenhouse', { learnedDir: dir })?.origin).toBe('shipped');
  });

  it('a corrupt or hostile learned file is ignored, not loaded', () => {
    const bad = base();
    bad.steps[0].fields[0].selector = 'javascript:alert(1)';
    fs.writeFileSync(path.join(dir, 'acme.json'), JSON.stringify(bad));
    expect(getRecipe('acme', { learnedDir: dir })).toBeNull();
    fs.writeFileSync(path.join(dir, 'acme.json'), '{not json');
    expect(getRecipe('acme', { learnedDir: dir })).toBeNull();
  });
});

describe('migration of config/learned-ats-platforms.json', () => {
  const GOOD_MAP = {
    name: '#full_name', email: '#mail', phone: '#tel', resumeUpload: 'input[type="file"]', coverLetter: '#cl', submitButton: 'button[type="submit"]',
  };

  it('migration is a no-op when the learned file is absent', () => {
    const out = path.join(dir, 'out');
    const r = migrateLearned({ learnedPath: path.join(dir, 'missing.json'), outDir: out });
    expect(r).toEqual({ present: false, migrated: [], rejected: [] });
    expect(fs.existsSync(out)).toBe(false);
  });

  it('migrates a clean entry into a validated, unverified learned recipe', () => {
    const file = path.join(dir, 'learned.json');
    fs.writeFileSync(file, JSON.stringify({ 'jobs.acme.com': GOOD_MAP }));
    const out = path.join(dir, 'out');
    const r = migrateLearned({ learnedPath: file, outDir: out });
    expect(r.migrated).toHaveLength(1);
    const got = getRecipe(r.migrated[0], { learnedDir: out });
    expect(got?.recipe.verified).toBe(false);
    expect(got?.recipe.steps[0].fields.map((f) => f.role).sort()).toEqual(['cover_letter', 'email', 'name.full', 'phone', 'resume']);
    // running it again never overwrites
    expect(migrateLearned({ learnedPath: file, outDir: out }).migrated).toEqual([]);
  });

  it('migration rejects a hostile entry', () => {
    const file = path.join(dir, 'learned.json');
    fs.writeFileSync(file, JSON.stringify({
      'evil.example.com': { ...GOOD_MAP, email: 'a[href^="javascript:alert(1)"]' },
      'ok.example.com': GOOD_MAP,
      'worse.example.com': 'not an object',
    }));
    const out = path.join(dir, 'out');
    const r = migrateLearned({ learnedPath: file, outDir: out });
    expect(r.migrated).toHaveLength(1);
    expect(r.rejected.map((x) => x.host).sort()).toEqual(['evil.example.com', 'worse.example.com']);
    expect(fs.readdirSync(out)).toHaveLength(1);
  });
});
