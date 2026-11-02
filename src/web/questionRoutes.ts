// src/web/questionRoutes.ts
// Dashboard Inbox API for the questions an application form asked that nothing reliable could answer (apply_questions), grouped by job.
// Reads use the read-only handle; the three actions (answer, agent, skip) run through deps.write on a short-lived write connection.
// CSRF, Origin and Host checks are enforced by the server for every POST before these handlers run. Answers go through the same gates as
// `npm run answers` (src/apply/answerService.ts). The audit log carries the action and the question ids only, never the answer or comment.
import BetterSqlite3 from 'better-sqlite3';
import { audit, type AuthDb } from '../dash/authStore.js';
import { groupedQuestions, questionCounts } from '../apply/questionInbox.js';
import { submitAnswer, type AnswerDeps } from '../apply/answerService.js';
import { ANSWER_MAX, COMMENT_MAX, getQuestion, markAgentHandle, markSkipped, migrateApplyQuestions } from '../apply/questions.js';
import { json, readJson, type Ctx } from './router.js';

type Db = BetterSqlite3.Database;

export interface QuestionDeps {
  /** Runs `fn` on a short-lived write connection (the dashboard's own handle is read-only). */
  write: <T>(fn: (db: Db) => T) => T;
  /** The base resume, for the `suggested` hints and the fact gate; null when unreadable. */
  resume?: () => Record<string, unknown> | null;
  /** Test seam for the answer gates (answers path, env, resume). */
  answer?: AnswerDeps;
}

// The dashboard's narrow write: one short-lived connection (its own handle is read-only), migrated so `owner_comment` exists.
export function withQuestionWriter<T>(path: string, fn: (db: Db) => T): T {
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    migrateApplyQuestions(db);
    return fn(db);
  } finally {
    db.close();
  }
}

export interface QuestionRoute { method: 'GET' | 'POST'; pattern: string; fn: (c: Ctx) => Promise<void> | void }

const MAX_IDS = 100;
const MAX_ANSWERS = 40;
const BODY_MAX = 64 * 1024;

const isId = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0;
const obj = (b: unknown): Record<string, unknown> | null => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null);

function commentOf(b: Record<string, unknown>): { ok: true; value: string | null } | { ok: false } {
  const c = b.comment;
  if (c === undefined || c === null) return { ok: true, value: null };
  if (typeof c !== 'string' || c.length > COMMENT_MAX) return { ok: false };
  return { ok: true, value: c.trim() ? c : null };
}

function idsOf(b: Record<string, unknown>): number[] | null {
  const raw = b.ids;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDS || !raw.every(isId)) return null;
  return [...new Set(raw as number[])];
}

interface ItemResult { id: number; ok: boolean; error?: string; released?: string[] }

export function createQuestionRoutes(deps: QuestionDeps, env: { auth: AuthDb; data: Db; now: () => Date }): QuestionRoute[] {
  const { auth, data, now } = env;
  const resume = (): Record<string, unknown> | null => { try { return deps.resume ? deps.resume() : null; } catch { return null; } };
  const counts = (): { questions: number; jobs: number } => questionCounts(data);

  const finish = (c: Ctx, action: 'answer' | 'agent' | 'skip', results: ItemResult[]): void => {
    const okIds = results.filter((r) => r.ok).map((r) => r.id);
    audit(auth, action === 'answer' ? 'apply_question_answer' : action === 'agent' ? 'apply_question_agent' : 'apply_question_skip',
      { ip: c.ip, note: `${okIds.length} of ${results.length}; ids ${results.map((r) => r.id).slice(0, 10).join(',')}` }, now());
    const failed = results.length > 0 && okIds.length === 0;
    json(c.res, failed ? 422 : 200, { ok: !results.some((r) => !r.ok), results, error: failed ? results[0]?.error : undefined, counts: counts() });
  };

  const run = (id: number, fn: (db: Db) => string[] | void): ItemResult => {
    try {
      const released = deps.write((db) => fn(db));
      return { id, ok: true, released: released ?? [] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      // Only our own closed messages reach the owner; anything else is a write failure.
      const known = /^(no such question|question \d+ is already|not_allowed:)/.test(msg);
      if (!known) console.error(`web: apply question write failed: ${e instanceof Error ? e.name : 'error'}`);
      return { id, ok: false, error: known ? msg.replace(/^not_allowed: /, '') : 'write failed' };
    }
  };

  const bad = (c: Ctx, why: string): void => {
    audit(auth, 'apply_question_reject', { ip: c.ip, note: why }, now());
    json(c.res, 400, { error: why });
  };

  return [
    {
      method: 'GET', pattern: '/api/apply-questions',
      fn: (c) => {
        const status = c.url.searchParams.get('status') ?? 'open';
        if (status !== 'open' && status !== 'all') return json(c.res, 400, { error: 'invalid status' });
        json(c.res, 200, { jobs: groupedQuestions(data, { status, resume: resume(), now: now() }), counts: counts() });
      },
    },
    {
      // One answer: {id, answer, scope, comment?}. Several answers of one job: {answers: [{id, answer, scope}], comment?}.
      method: 'POST', pattern: '/api/apply-questions/answer',
      fn: async (c) => {
        const b = obj(await readJson(c.req, BODY_MAX));
        if (!b) return bad(c, 'invalid body');
        const jobComment = commentOf(b);
        if (!jobComment.ok) return bad(c, 'invalid comment');
        const list = b.answers !== undefined ? b.answers : [b];
        if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ANSWERS) return bad(c, 'invalid answers');
        const items: { id: number; answer: string; always: boolean; comment: string | null }[] = [];
        for (const it of list) {
          const o = obj(it);
          if (!o || !isId(o.id) || typeof o.answer !== 'string' || o.answer.length > ANSWER_MAX * 2) return bad(c, 'invalid answer');
          if (o.scope !== 'once' && o.scope !== 'always') return bad(c, 'invalid scope');
          const own = commentOf(o);
          if (!own.ok) return bad(c, 'invalid comment');
          items.push({ id: o.id, answer: o.answer, always: o.scope === 'always', comment: own.value ?? jobComment.value });
        }
        if (new Set(items.map((i) => i.id)).size !== items.length) return bad(c, 'duplicate ids');
        const results: ItemResult[] = items.map((i) => run(i.id, (db) => {
          const r = submitAnswer(db, i.id, i.answer, { always: i.always, comment: i.comment }, { ...deps.answer, now, baseResume: deps.answer?.baseResume ?? (resume() ? (): Record<string, unknown> => resume() as Record<string, unknown> : undefined) });
          if (!r.ok) throw new Error(r.code === 'not_found' ? 'no such question' : r.code === 'not_open' ? `question ${i.id} is already ${getQuestion(db, i.id)?.status ?? 'closed'}` : `not_allowed: ${r.reason}`);
          return r.outcome.released;
        }));
        finish(c, 'answer', results);
      },
    },
    {
      method: 'POST', pattern: '/api/apply-questions/agent-handle',
      fn: async (c) => {
        const b = obj(await readJson(c.req, BODY_MAX));
        const ids = b ? idsOf(b) : null;
        if (!b || !ids) return bad(c, 'invalid ids');
        const cm = commentOf(b);
        if (!cm.ok) return bad(c, 'invalid comment');
        finish(c, 'agent', ids.map((id) => run(id, (db) => { markAgentHandle(db, id, now(), cm.value); })));
      },
    },
    {
      method: 'POST', pattern: '/api/apply-questions/skip',
      fn: async (c) => {
        const b = obj(await readJson(c.req, BODY_MAX));
        const ids = b ? idsOf(b) : null;
        if (!b || !ids) return bad(c, 'invalid ids');
        const cm = commentOf(b);
        if (!cm.ok) return bad(c, 'invalid comment');
        finish(c, 'skip', ids.map((id) => run(id, (db) => { markSkipped(db, id, now(), cm.value); })));
      },
    },
  ];
}
