// src/outreach/people.ts
import type BetterSqlite3 from 'better-sqlite3';
import type { Category } from './cadence.js';

type Db = BetterSqlite3.Database;

export const STAGES = ['new', 'active', 'replied_positive', 'replied_negative', 'closed', 'cooldown'] as const;

const LEGAL_SUFFIXES =
  /\b(pvt|private|ltd|limited|inc|incorporated|llc|llp|gmbh|corp|corporation|co|fzco|fze|pjsc)\b/g;

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeProfileKey(url: string): string {
  const raw = String(url ?? '').trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) host = 'linkedin.com';
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep raw path */
    }
    return (host + path.toLowerCase()).replace(/\/+$/, '');
  } catch {
    return raw.toLowerCase().split(/[?#]/)[0].replace(/\/+$/, '');
  }
}

export interface PersonInput {
  platform: string;
  profileKey: string;
  name?: string;
  headline?: string;
  company: string;
  category: Category;
}

export function upsertPerson(db: Db, p: PersonInput): number {
  db.prepare(
    `INSERT INTO people (platform, profile_key, name, headline, company, company_key, category)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, profile_key) DO UPDATE SET
       name = COALESCE(excluded.name, name), headline = COALESCE(excluded.headline, headline),
       company = excluded.company, company_key = excluded.company_key,
       category = CASE WHEN COALESCE((SELECT stage FROM contact_state WHERE person_id = people.id), 'new') = 'new'
                       THEN excluded.category ELSE people.category END`,
  ).run(p.platform, p.profileKey, p.name ?? null, p.headline ?? null, p.company, normalizeCompany(p.company), p.category);
  const row = db
    .prepare('SELECT id FROM people WHERE platform = ? AND profile_key = ?')
    .get(p.platform, p.profileKey) as { id: number };
  db.prepare('INSERT OR IGNORE INTO contact_state (person_id) VALUES (?)').run(row.id);
  return row.id;
}

export function activeContactCount(db: Db, platform: string, companyKey: string, speculative: boolean): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM people p JOIN contact_state s ON s.person_id = p.id
       WHERE p.platform = ? AND p.company_key = ? AND s.speculative = ?
         AND s.stage NOT IN ('new', 'closed')`,
    )
    .get(platform, companyKey, speculative ? 1 : 0) as { n: number };
  return row.n;
}

export function activeByCategory(db: Db, platform: string, companyKey: string): Record<Category, number> {
  const out: Record<Category, number> = { recruiter: 0, hiring_manager: 0, peer: 0, connection: 0 };
  const rows = db
    .prepare(
      `SELECT p.category AS category, COUNT(*) AS n FROM people p JOIN contact_state s ON s.person_id = p.id
       WHERE p.platform = ? AND p.company_key = ? AND s.stage NOT IN ('new', 'closed')
       GROUP BY p.category`,
    )
    .all(platform, companyKey) as { category: Category; n: number }[];
  for (const r of rows) out[r.category] = r.n;
  return out;
}

export function companyPaused(db: Db, platform: string, companyKey: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM people p JOIN contact_state s ON s.person_id = p.id
       WHERE p.platform = ? AND p.company_key = ? AND s.stage = 'replied_positive' LIMIT 1`,
    )
    .get(platform, companyKey);
  return row !== undefined;
}

export interface Candidate {
  personId: number;
  category: Category;
  connected: boolean;
}

const MIN_MIX: Record<'recruiter' | 'hiring_manager' | 'peer', number> = {
  recruiter: 1,
  hiring_manager: 1,
  peer: 2,
};

export function selectContacts(
  candidates: Candidate[],
  active: Record<Category, number>,
  limit: number,
  activeTotal: number,
): Candidate[] {
  let room = limit - activeTotal;
  if (room <= 0) return [];
  const picked: Candidate[] = [];
  const pool = [...candidates];

  const take = (pred: (c: Candidate) => boolean): boolean => {
    let i = pool.findIndex((c) => c.connected && pred(c));
    if (i < 0) i = pool.findIndex(pred);
    if (i < 0) return false;
    picked.push(pool.splice(i, 1)[0]);
    room--;
    return true;
  };
  const have = (cat: Category): number => active[cat] + picked.filter((p) => p.category === cat).length;

  // Mix minimums take precedence; within a category connected people go first.
  for (const cat of ['recruiter', 'hiring_manager', 'peer'] as const) {
    while (room > 0 && have(cat) < MIN_MIX[cat] && take((c) => c.category === cat)) {
      /* fill the mix */
    }
  }
  while (room > 0 && take(() => true)) {
    /* remaining room, connected preferred */
  }
  return [...picked.filter((c) => c.connected), ...picked.filter((c) => !c.connected)];
}
