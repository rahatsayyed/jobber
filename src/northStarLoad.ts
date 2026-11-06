// file: src/northStarLoad.ts
// Reads the optional `north_star` section of user-data/profile.json (see src/northStar.ts for the shape and the rules).
import { existsSync, readFileSync } from 'node:fs';
import { userDataPath } from './lib/userData.js';
import { parseNorthStar, validateNorthStar, type NorthStar } from './northStar.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface NorthStarStatus {
  /** The owner's section, or null when user-data/profile.json has none (or is unreadable or invalid: see `invalid`). */
  northStar: NorthStar | null;
  source: 'profile' | 'none';
  /** Why the section was ignored (field paths or a short reason), never a value. */
  invalid?: string;
}

/** Read the optional `north_star` section of user-data/profile.json. Never throws; a bad section is ignored and reported in `invalid`. */
export function loadNorthStar(env: NodeJS.ProcessEnv = process.env, root?: string): NorthStarStatus {
  let file: string;
  try { file = root ? userDataPath('profile.json', env, root) : userDataPath('profile.json', env); } catch { return { northStar: null, source: 'none' }; }
  if (!existsSync(file)) return { northStar: null, source: 'none' };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return { northStar: null, source: 'none', invalid: 'profile.json is not valid JSON' }; }
  if (!isObj(raw) || raw.north_star === undefined) return { northStar: null, source: 'none' };
  const bad = validateNorthStar(raw.north_star);
  if (bad.length) return { northStar: null, source: 'none', invalid: bad.slice(0, 6).join(', ') };
  return { northStar: parseNorthStar(raw.north_star), source: 'profile' };
}
