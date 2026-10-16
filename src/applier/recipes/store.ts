// Recipe files (plan 8G-2 task 19). Shipped recipes live in config/ats-recipes (tracked); recipes learned at
// run time live in .jobber/ats-recipes (git-ignored). Both are validated on every load, bounded in size, and
// never trusted: a corrupt, oversize, symlinked or hostile file is ignored, never half-loaded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE_PLATFORM_RE, validateRecipe, type Recipe } from './schema.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_SHIPPED_DIR = path.join(PROJECT_ROOT, 'config', 'ats-recipes');
export const DEFAULT_LEARNED_DIR = path.join(PROJECT_ROOT, '.jobber', 'ats-recipes');
export const MAX_RECIPE_BYTES = 32768;

export interface RecipeStoreOpts { shippedDir?: string; learnedDir?: string }
export type RecipeOrigin = 'shipped' | 'learned';
export interface LoadedRecipe { recipe: Recipe; origin: RecipeOrigin }

export const isPlatformId = (id: unknown): id is string => typeof id === 'string' && RECIPE_PLATFORM_RE.test(id);

/** Reads a small regular file (never a symlink), or null. */
export function readSmallFile(file: string, maxBytes: number = MAX_RECIPE_BYTES): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Atomic, owner-only write (tmp file plus rename). Refuses a symlink target. */
export function writeFileAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('target is a symlink'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

function loadFrom(dir: string, id: string, source: Recipe['source'][]): Recipe | null {
  if (!isPlatformId(id)) return null;
  const text = readSmallFile(path.join(dir, `${id}.json`));
  if (text === null) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const v = validateRecipe(raw);
  if (!v.ok || v.recipe.id !== id || !source.includes(v.recipe.source)) return null;
  return v.recipe;
}

export function loadShippedRecipe(id: string, dir: string = DEFAULT_SHIPPED_DIR): Recipe | null {
  return loadFrom(dir, id, ['shipped']);
}

export function loadLearnedRecipe(id: string, dir: string = DEFAULT_LEARNED_DIR): Recipe | null {
  return loadFrom(dir, id, ['learned']);
}

export function shippedRecipeIds(dir: string = DEFAULT_SHIPPED_DIR): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(isPlatformId);
  } catch {
    return [];
  }
}

/** Shipped first, then learned. A shipped recipe is never shadowed by a learned file. */
export function getRecipe(id: string, o: RecipeStoreOpts = {}): LoadedRecipe | null {
  const shipped = loadShippedRecipe(id, o.shippedDir);
  if (shipped) return { recipe: shipped, origin: 'shipped' };
  const learned = loadLearnedRecipe(id, o.learnedDir);
  return learned ? { recipe: learned, origin: 'learned' } : null;
}

/** Validates, then writes <dir>/<id>.json. Throws on an invalid recipe or an oversize file. */
export function saveLearnedRecipe(recipe: Recipe, dir: string = DEFAULT_LEARNED_DIR): void {
  const v = validateRecipe(recipe);
  if (!v.ok) throw new Error(`recipe not saved: ${v.why}`);
  const text = JSON.stringify(v.recipe, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_RECIPE_BYTES) throw new Error('recipe not saved: too large');
  writeFileAtomic(path.join(dir, `${v.recipe.id}.json`), text);
}
