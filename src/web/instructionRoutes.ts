// src/web/instructionRoutes.ts
// Dashboard API for owner instructions: GET /api/instructions (list) and POST /api/instructions (add). CSRF, Origin and Host checks are
// enforced by the server for every POST before these handlers run. The audit log carries the id and scope only, never the text.
import BetterSqlite3 from 'better-sqlite3';
import { audit, type AuthDb } from '../dash/authStore.js';
import { addInstruction, escalationsWithAgent, listInstructions, migrateOwnerInstructions, type InstructionStatus } from '../owner/instructions.js';
import { json, readJson, type Ctx } from './router.js';

type Db = BetterSqlite3.Database;

export interface InstructionDeps { write: <T>(fn: (db: Db) => T) => T }

export function withInstructionWriter<T>(path: string, fn: (db: Db) => T): T {
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    migrateOwnerInstructions(db);
    return fn(db);
  } finally {
    db.close();
  }
}

export interface InstructionRoute { method: 'GET' | 'POST'; pattern: string; fn: (c: Ctx) => Promise<void> | void }

const STATUSES = new Set(['pending', 'in_progress', 'done', 'rejected']);

export function createInstructionRoutes(deps: InstructionDeps, env: { auth: AuthDb; data: Db; now: () => Date }): InstructionRoute[] {
  const { auth, data, now } = env;
  return [
    {
      method: 'GET', pattern: '/api/instructions',
      fn: (c) => {
        const s = c.url.searchParams.get('status');
        if (s !== null && !STATUSES.has(s)) return json(c.res, 400, { error: 'invalid status' });
        let items: unknown[] = [];
        let withAgent: number[] = [];
        try {
          items = listInstructions(data, { status: (s as InstructionStatus | null) ?? undefined, limit: 50 });
          withAgent = escalationsWithAgent(data);
        } catch { /* table not created yet: empty */ }
        json(c.res, 200, { instructions: items, with_agent_escalation_ids: withAgent });
      },
    },
    {
      method: 'POST', pattern: '/api/instructions',
      fn: async (c) => {
        const b = await readJson(c.req, 16 * 1024);
        if (!b || typeof b !== 'object' || Array.isArray(b)) return json(c.res, 400, { error: 'invalid body' });
        const o = b as Record<string, unknown>;
        if (typeof o.text !== 'string') return json(c.res, 400, { error: 'text required' });
        let r;
        try {
          r = deps.write((db) => addInstruction(db, {
            text: o.text as string,
            job_id: typeof o.job_id === 'number' ? o.job_id : null,
            escalation_id: typeof o.escalation_id === 'number' ? o.escalation_id : null,
            company_key: typeof o.company_key === 'string' ? o.company_key : null,
          }, now()));
        } catch {
          return json(c.res, 500, { error: 'write failed' });
        }
        if (!r.ok) return json(c.res, 400, { error: r.error });
        audit(auth, 'owner_instruction_add', { ip: c.ip, note: `id ${r.id}; scope ${r.scope}` }, now());
        json(c.res, 200, { ok: true, id: r.id, scope: r.scope });
      },
    },
  ];
}
