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
}
export interface Touch {
  id: number; job_id: string | null; kind: string; status: string; body: string | null; created_at: string; sent_at: string | null;
}

const PERSON_LIMITS: Record<string, number> = {
  platform: 32, name: 200, headline: 300, company: 200, category: 64, stage: 32, last_touch_at: 64, next_due_at: 64, paused_reason: 300,
};
const TOUCH_LIMITS: Record<string, number> = { job_id: 200, kind: 64, status: 32, body: 4000, created_at: 64, sent_at: 64 };

const PERSON_SELECT = `SELECT p.id, p.platform, p.name, p.headline, p.company, p.category, s.stage, s.followups_sent,
  s.last_touch_at, s.next_due_at, s.paused_reason FROM people p LEFT JOIN contact_state s ON s.person_id = p.id`;

export function listPeople(db: Db, opts: { q?: string; stage?: string; cursor?: number | null; limit?: number }): Page<PersonRow> {
  if (!tableExists(db, 'people')) return { items: [], nextCursor: null };
  const limit = clampLimit(opts.limit);
  const hasState = tableExists(db, 'contact_state');
  const select = hasState ? PERSON_SELECT
    : `SELECT p.id, p.platform, p.name, p.headline, p.company, p.category, NULL AS stage, NULL AS followups_sent,
       NULL AS last_touch_at, NULL AS next_due_at, NULL AS paused_reason FROM people p`;
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
    .all(params) as unknown as PersonRow[];
  const page = rows.slice(0, limit).map((r) => cleanRow(r as unknown as Record<string, unknown>, PERSON_LIMITS) as unknown as PersonRow);
  return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

export function personThread(db: Db, personId: number, opts: { cursor?: number | null; limit?: number }): { person: PersonRow; touches: Page<Touch> } | null {
  if (!tableExists(db, 'people')) return null;
  const hasState = tableExists(db, 'contact_state');
  const select = hasState ? PERSON_SELECT
    : `SELECT p.id, p.platform, p.name, p.headline, p.company, p.category, NULL AS stage, NULL AS followups_sent,
       NULL AS last_touch_at, NULL AS next_due_at, NULL AS paused_reason FROM people p`;
  const p = db.prepare(`${select} WHERE p.id = ?`).get(personId) as PersonRow | undefined;
  if (!p) return null;
  const person = cleanRow(p as unknown as Record<string, unknown>, PERSON_LIMITS) as unknown as PersonRow;
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
