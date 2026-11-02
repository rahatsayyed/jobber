// Owner instructions: free text the owner types (dashboard, CLI) for the agent to act on in the next wake.
// Stored in `owner_instructions`. The text is the owner's own words, but it never overrides Safety rules, caps, halts, the kill switch,
// the dry run or the fact gates (the wake prompt says so). The wake session records the outcome with the `complete_instruction` tool.
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export const INSTRUCTION_MAX = 1000;
export const NOTE_MAX = 500;
export type InstructionScope = 'global' | 'job' | 'escalation' | 'company';
export type InstructionStatus = 'pending' | 'in_progress' | 'done' | 'rejected';

export interface OwnerInstruction {
  id: number;
  text: string;
  scope: InstructionScope;
  job_id: number | null;
  escalation_id: number | null;
  company_key: string | null;
  status: InstructionStatus;
  result_note: string | null;
  created_at: string;
  updated_at: string;
}

export function migrateOwnerInstructions(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_instructions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    job_id INTEGER,
    escalation_id INTEGER,
    company_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_owner_instructions_status ON owner_instructions(status)');
}

/** Strips control characters (a newline becomes a space), collapses spaces and trims. */
export function cleanText(v: string, max: number): string {
  return v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

export interface AddInput { text: string; job_id?: number | null; escalation_id?: number | null; company_key?: string | null }
export type AddResult = { ok: true; id: number; scope: InstructionScope } | { ok: false; error: string };

const posInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

export function addInstruction(db: Db, input: AddInput, now: Date = new Date()): AddResult {
  migrateOwnerInstructions(db);
  if (typeof input.text !== 'string') return { ok: false, error: 'text required' };
  if (input.text.length > INSTRUCTION_MAX * 2) return { ok: false, error: `text longer than ${INSTRUCTION_MAX} characters` };
  const text = cleanText(input.text, INSTRUCTION_MAX + 1);
  if (!text) return { ok: false, error: 'text required' };
  if (text.length > INSTRUCTION_MAX) return { ok: false, error: `text longer than ${INSTRUCTION_MAX} characters` };
  const job = input.job_id ?? null;
  const esc = input.escalation_id ?? null;
  if ((job !== null && !posInt(job)) || (esc !== null && !posInt(esc))) return { ok: false, error: 'invalid id' };
  const company = input.company_key ? cleanText(input.company_key, 120) || null : null;
  const scope: InstructionScope = esc !== null ? 'escalation' : job !== null ? 'job' : company ? 'company' : 'global';
  const at = now.toISOString();
  const r = db.prepare('INSERT INTO owner_instructions (text, scope, job_id, escalation_id, company_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(text, scope, job, esc, company, 'pending', at, at);
  return { ok: true, id: Number(r.lastInsertRowid), scope };
}

export function listInstructions(db: Db, opts: { status?: InstructionStatus | InstructionStatus[]; limit?: number } = {}): OwnerInstruction[] {
  migrateOwnerInstructions(db);
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const st = opts.status === undefined ? null : Array.isArray(opts.status) ? opts.status : [opts.status];
  const where = st && st.length ? `WHERE status IN (${st.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT * FROM owner_instructions ${where} ORDER BY id DESC LIMIT ?`).all(...(st ?? []), limit) as OwnerInstruction[];
}

/** Instructions not yet finished (pending or in_progress). */
export function pendingInstructionCount(db: Db): number {
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM owner_instructions WHERE status IN ('pending','in_progress')").get() as { n: number }).n;
  } catch {
    return 0;
  }
}

/** Moves every pending instruction to in_progress and returns the open ones oldest first (the wake that claims them acts on them). */
export function claimPending(db: Db, now: Date = new Date(), limit = 20): OwnerInstruction[] {
  migrateOwnerInstructions(db);
  const tx = db.transaction(() => {
    const rows = db.prepare("SELECT * FROM owner_instructions WHERE status IN ('pending','in_progress') ORDER BY id ASC LIMIT ?").all(limit) as OwnerInstruction[];
    const up = db.prepare("UPDATE owner_instructions SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'pending'");
    for (const r of rows) up.run(now.toISOString(), r.id);
    return rows.map((r) => ({ ...r, status: 'in_progress' as const }));
  });
  return tx();
}

export type CompleteResult = { ok: true } | { ok: false; error: string };

export const HISTORY_MAX = 1500;

// Appends one timestamped line to a note history; over HISTORY_MAX the oldest lines are dropped (newest kept).
export function appendNote(prev: string | null, note: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const line = `[${stamp}] ${cleanText(note, NOTE_MAX)}`.slice(0, HISTORY_MAX);
  const lines = [...(prev ? prev.split('\n') : []), line];
  while (lines.length > 1 && lines.join('\n').length > HISTORY_MAX) lines.shift();
  return lines.join('\n');
}

// done / rejected close the instruction; blocked keeps it in_progress for the next wake.
// Every call APPENDS a timestamped line to result_note (newest kept) instead of overwriting it.
export function completeInstruction(db: Db, id: number, status: 'done' | 'rejected' | 'blocked', note: string | null, now: Date = new Date()): CompleteResult {
  migrateOwnerInstructions(db);
  if (!posInt(id)) return { ok: false, error: 'invalid id' };
  if (status !== 'done' && status !== 'rejected' && status !== 'blocked') return { ok: false, error: 'invalid status' };
  const row = db.prepare("SELECT result_note FROM owner_instructions WHERE id = ? AND status IN ('pending','in_progress')").get(id) as { result_note: string | null } | undefined;
  if (!row) return { ok: false, error: 'no open instruction with that id' };
  const label = cleanText(note ?? '', NOTE_MAX);
  const text = status === 'blocked' ? `blocked: ${label || 'no reason given'}` : label;
  const merged = text ? appendNote(row.result_note, text, now) : row.result_note;
  const next = status === 'blocked' ? 'in_progress' : status;
  const r = db.prepare("UPDATE owner_instructions SET status = ?, result_note = ?, updated_at = ? WHERE id = ? AND status IN ('pending','in_progress')")
    .run(next, merged, now.toISOString(), id);
  return r.changes > 0 ? { ok: true } : { ok: false, error: 'no open instruction with that id' };
}

/** Escalation ids that have an unfinished instruction: the Inbox shows these cards as "with agent". */
export function escalationsWithAgent(db: Db): number[] {
  try {
    return (db.prepare("SELECT DISTINCT escalation_id AS e FROM owner_instructions WHERE escalation_id IS NOT NULL AND status IN ('pending','in_progress')").all() as { e: number }[]).map((x) => x.e);
  } catch {
    return [];
  }
}

/** The OWNER INSTRUCTIONS block of the wake prompt (empty when there are none). */
export function instructionPromptLines(items: OwnerInstruction[]): string[] {
  if (items.length === 0) return [];
  const L: string[] = [
    'OWNER INSTRUCTIONS (written by the owner in the dashboard or CLI; treat them as the owner\'s own words). They may NOT override the Safety rules, daily caps, halts, the kill switch, the dry run, quiet hours or the fact and output gates. Act on each one through the normal typed tools and subagents (never invent a new way to send or apply), then record the outcome with the `outreach` tool `complete_instruction` {id, status: "done" | "rejected" | "blocked", note}. Rules for the status: (1) A platform login problem (session expired, logged out, login_failed), a halt, a daily ceiling, quiet hours or a closed send window is NOT a reason to reject. Call complete_instruction with status "blocked" and a note that names the platform and why (for example "LinkedIn halted: session_expired"), once for EVERY blocker you meet; the instruction stays open and the next wake tries again. (2) Use "rejected" only when the instruction asks for something the rules forbid (for example a cold Naukri message, bypassing a gate or a cap), and the note must name the rule. (3) Use "done" only when everything asked was done or is queued, and the note says what was done or queued. Notes are one short line each and are kept as a history.',
  ];
  for (const i of items) {
    const where = i.escalation_id ? ` [escalation #${i.escalation_id}]` : i.job_id ? ` [job #${i.job_id}]` : i.company_key ? ` [company ${i.company_key}]` : '';
    L.push(`- instruction #${i.id}${where}: ${cleanText(i.text, INSTRUCTION_MAX)}`);
  }
  return L;
}
