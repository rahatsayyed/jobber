import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import BetterSqlite3 from 'better-sqlite3';
import {
  addInstruction, claimPending, completeInstruction, escalationsWithAgent, instructionPromptLines, listInstructions, pendingInstructionCount, INSTRUCTION_MAX,
} from '../src/owner/instructions.js';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import { createInstructionRoutes } from '../src/web/instructionRoutes.js';
import { run } from '../scripts/instructions.js';

const mem = () => new BetterSqlite3(':memory:');
const budget = { maxWallSec: 900, maxTokensApprox: 150000 };

describe('owner instructions module', () => {
  it('adds, strips control chars, caps length, picks scope', () => {
    const db = mem();
    const a = addInstruction(db, { text: 'skip\u0000 all\njobs\tfrom X' });
    expect(a).toMatchObject({ ok: true, scope: 'global' });
    expect(listInstructions(db)[0].text).toBe('skip all jobs from X');
    expect(addInstruction(db, { text: 'x', job_id: 4 })).toMatchObject({ scope: 'job' });
    expect(addInstruction(db, { text: 'x', escalation_id: 9, job_id: 4 })).toMatchObject({ scope: 'escalation' });
    expect(addInstruction(db, { text: 'x', company_key: 'acme' })).toMatchObject({ scope: 'company' });
    expect(addInstruction(db, { text: '   ' })).toMatchObject({ ok: false });
    expect(addInstruction(db, { text: 'a'.repeat(INSTRUCTION_MAX + 1) })).toMatchObject({ ok: false });
    expect(addInstruction(db, { text: 'a'.repeat(INSTRUCTION_MAX) }).ok).toBe(true);
    expect(addInstruction(db, { text: 'x', job_id: -1 })).toMatchObject({ ok: false });
  });

  it('claims pending to in_progress, completes once, tracks escalation cards', () => {
    const db = mem();
    addInstruction(db, { text: 'one', escalation_id: 7 });
    addInstruction(db, { text: 'two' });
    expect(pendingInstructionCount(db)).toBe(2);
    expect(escalationsWithAgent(db)).toEqual([7]);
    const got = claimPending(db);
    expect(got.map((g) => g.status)).toEqual(['in_progress', 'in_progress']);
    expect(completeInstruction(db, got[0].id, 'done', 'handled\u0001 it')).toEqual({ ok: true });
    expect(completeInstruction(db, got[0].id, 'done', null)).toMatchObject({ ok: false });
    expect(completeInstruction(db, got[1].id, 'rejected', 'breaks a cap')).toEqual({ ok: true });
    expect(pendingInstructionCount(db)).toBe(0);
    expect(escalationsWithAgent(db)).toEqual([]);
    expect(listInstructions(db, { status: 'done' })[0].result_note).toBe('handled it');
  });

  it('pending count is 0 when the table does not exist', () => {
    expect(pendingInstructionCount(mem())).toBe(0);
  });
});

describe('wake prompt section', () => {
  const base = { runId: 'r1', dryRun: false, tasks: [], budget, allowed: ['linkedin' as const], now: new Date('2026-10-15T10:00:00Z') };
  it('has no section without instructions', () => {
    expect(buildWakePrompt(base)).not.toContain('OWNER INSTRUCTIONS');
  });
  it('lists instructions with the limits and the tool name', () => {
    const db = mem();
    addInstruction(db, { text: 'stop contacting recruiters at Y', job_id: 3 });
    const p = buildWakePrompt({ ...base, instructions: claimPending(db) });
    expect(p).toContain('OWNER INSTRUCTIONS');
    expect(p).toContain('instruction #1 [job #3]: stop contacting recruiters at Y');
    expect(p).toContain('may NOT override the Safety rules');
    expect(p).toContain('complete_instruction');
    expect(instructionPromptLines([])).toEqual([]);
  });
});

function call(routes: ReturnType<typeof createInstructionRoutes>, method: 'GET' | 'POST', url: string, body?: unknown) {
  const route = routes.find((r) => r.method === method && r.pattern === new URL(url, 'http://x').pathname)!;
  const out: { status: number; body: any } = { status: 0, body: null };
  const res: any = {
    statusCode: 0, headersSent: false,
    setHeader() {}, getHeader() {}, writeHead(s: number) { out.status = s; this.statusCode = s; return this; },
    end(t?: string) { if (t) out.body = JSON.parse(t); },
  };
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.headers = { 'content-type': 'application/json' };
  return Promise.resolve(route.fn({ req, res, url: new URL(url, 'http://x'), ip: '127.0.0.1', secure: false, session: null })).then(() => out);
}

describe('instruction routes', () => {
  it('POST adds, GET lists and reports cards with the agent, bad input is 400', async () => {
    const db = mem();
    const auth = mem();
    auth.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, ip TEXT, note TEXT, text_hash TEXT, id_hint TEXT)');
    const routes = createInstructionRoutes({ write: (fn) => fn(db) }, { auth, data: db, now: () => new Date('2026-10-15T10:00:00Z') });
    const ok = await call(routes, 'POST', '/api/instructions', { text: 'use this answer for visa questions', escalation_id: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, scope: 'escalation' });
    const bad = await call(routes, 'POST', '/api/instructions', { text: '' });
    expect(bad.status).toBe(400);
    const list = await call(routes, 'GET', '/api/instructions');
    expect(list.body.instructions).toHaveLength(1);
    expect(list.body.with_agent_escalation_ids).toEqual([5]);
    expect((await call(routes, 'GET', '/api/instructions?status=bogus')).status).toBe(400);
    const audited = auth.prepare('SELECT note FROM audit_log').all() as { note: string }[];
    expect(audited[0].note).not.toContain('visa');
  });
});

describe('instructions CLI', () => {
  it('add, list, done, reject', () => {
    const db = mem();
    expect(run(['add', 'skip', 'company', 'X', '--job', '12'], { db }).code).toBe(0);
    expect(run(['list'], { db }).lines[0]).toContain('job 12');
    expect(run(['done', '1', 'ok'], { db }).code).toBe(0);
    expect(run(['reject', '1'], { db }).code).toBe(1);
    expect(run(['bogus'], { db }).code).toBe(2);
  });
});
