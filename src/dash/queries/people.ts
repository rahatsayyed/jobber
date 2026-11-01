// src/dash/queries/people.ts
// Read-only people list and per-person conversation (touches) for the dashboard. people/contact_state/touches come from
// src/outreach/schema.ts; contact_state.stage values are STAGES in src/outreach/people.ts:7, touches.status defaults to 'queued'
// (src/outreach/schema.ts:43). Keyset cursor: INTEGER PRIMARY KEY ids, newest first, `id < cursor`.
import type BetterSqlite3 from 'better-sqlite3';
import { clampLimit, likePattern, tableExists, type Page } from '../readDb.js';
import { cleanRow } from '../clean.js';

type Db = BetterSqlite3.Database;

export interface PersonRow {
  id: number; platform: string; name: string | null; headline: string | null; company: string | null; category: string;
  stage: string | null; followups_sent: number | null; last_touch_at: string | null; next_due_at: string | null; paused_reason: string | null;
  profile_url: string | null; connection_status: string | null; touch_count: number;
}

/** Public profile link rebuilt from the stored profile_key. Only the exact linkedin.com/in/<slug> shape becomes a link; anything else is null. */
export function profileUrl(platform: string, profileKey: string | null | undefined): string | null {
  if (platform !== 'linkedin' || !profileKey) return null;
  return /^linkedin\.com\/in\/[A-Za-z0-9%_.-]{1,200}$/.test(profileKey) ? `https://www.${profileKey}` : null;
}
export interface Touch {
  id: number; job_id: string | null; kind: string; status: string; body: string | null; created_at: string; sent_at: string | null;
}

const PERSON_LIMITS: Record<string, number> = {
  platform: 32, name: 200, headline: 300, company: 200, category: 64, stage: 32, last_touch_at: 64, next_due_at: 64, paused_reason: 300,
};
const TOUCH_LIMITS: Record<string, number> = { job_id: 200, kind: 64, status: 32, body: 4000, created_at: 64, sent_at: 64 };

// connection_status: newest connections row whose profile_url contains the stored profile_key (the table has no person id).
const EXTRA = (db: Db) => `${tableExists(db, 'connections')
  ? "(SELECT c.status FROM connections c WHERE instr(c.profile_url, p.profile_key) > 0 ORDER BY c.id DESC LIMIT 1)" : 'NULL'} AS connection_status,
  ${tableExists(db, 'touches') ? '(SELECT COUNT(*) FROM touches t WHERE t.person_id = p.id)' : '0'} AS touch_count, p.profile_key AS profile_key`;
const personSelect = (db: Db): string => tableExists(db, 'contact_state')
  ? `SELECT p.id, p.platform, p.name, p.headline, p.company, p.category, s.stage, s.followups_sent,
  s.last_touch_at, s.next_due_at, s.paused_reason, ${EXTRA(db)} FROM people p LEFT JOIN contact_state s ON s.person_id = p.id`
  : `SELECT p.id, p.platform, p.name, p.headline, p.company, p.category, NULL AS stage, NULL AS followups_sent,
  NULL AS last_touch_at, NULL AS next_due_at, NULL AS paused_reason, ${EXTRA(db)} FROM people p`;
const toPerson = (r: Record<string, unknown>): PersonRow => {
  const { profile_key, ...rest } = r;
  const c = cleanRow(rest, PERSON_LIMITS) as unknown as PersonRow;
  return { ...c, profile_url: profileUrl(String(r.platform), typeof profile_key === 'string' ? profile_key : null) };
};

export function listPeople(db: Db, opts: { q?: string; stage?: string; cursor?: number | null; limit?: number }): Page<PersonRow> {
  if (!tableExists(db, 'people')) return { items: [], nextCursor: null };
  const limit = clampLimit(opts.limit);
  const hasState = tableExists(db, 'contact_state');
  const select = personSelect(db);
  const where: string[] = [];
  const params: Record<string, unknown> = { lim: limit + 1 };
  if (opts.stage && hasState) { where.push('s.stage = @stage'); params.stage = opts.stage; }
  if (opts.stage && !hasState) return { items: [], nextCursor: null };
  if (opts.q && opts.q.trim() !== '') {
    where.push("(p.name LIKE @like ESCAPE '\\' OR p.company LIKE @like ESCAPE '\\' OR p.headline LIKE @like ESCAPE '\\')");
    params.like = likePattern(opts.q);
  }
  if (opts.cursor != null) { where.push('p.id < @cursor'); params.cursor = opts.cursor; }
  const rows = db.prepare(`${select} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT @lim`)
    .all(params) as Record<string, unknown>[];
  const page = rows.slice(0, limit).map(toPerson);
  return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

/** Distinct stage values for the People filter. */
export function personStages(db: Db): string[] {
  if (!tableExists(db, 'contact_state')) return [];
  return (db.prepare('SELECT DISTINCT stage FROM contact_state WHERE stage IS NOT NULL ORDER BY stage LIMIT 50').all() as { stage: string }[])
    .map((r) => cleanRow(r, { stage: 32 }).stage);
}

export function personThread(db: Db, personId: number, opts: { cursor?: number | null; limit?: number }): { person: PersonRow; touches: Page<Touch> } | null {
  if (!tableExists(db, 'people')) return null;
  const p = db.prepare(`${personSelect(db)} WHERE p.id = ?`).get(personId) as Record<string, unknown> | undefined;
  if (!p) return null;
  const person = toPerson(p);
  if (!tableExists(db, 'touches')) return { person, touches: { items: [], nextCursor: null } };
  const limit = clampLimit(opts.limit);
  const params: Record<string, unknown> = { pid: personId, lim: limit + 1 };
  let cur = '';
  if (opts.cursor != null) { cur = 'AND id < @cursor'; params.cursor = opts.cursor; }
  const rows = db.prepare(`SELECT id, job_id, kind, status, body, created_at, sent_at FROM touches WHERE person_id = @pid ${cur}
    ORDER BY id DESC LIMIT @lim`).all(params) as unknown as Touch[];
  const page = rows.slice(0, limit).map((t) => cleanRow(t as unknown as Record<string, unknown>, TOUCH_LIMITS) as unknown as Touch);
  return { person, touches: { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null } };
}
