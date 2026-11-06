// src/outreach/replyFacts.ts
// user-data/reply-facts.json: the plain facts the OWNER pre-answered for email replies (current and expected CTC, notice period, location,
// relocation, availability, work authorization). The agent never invents one: an ask whose field is empty is escalated to the owner, and while
// `confirmed` is not true NOTHING is auto-answered. The file is personal data: it is never logged, never put in a prompt to another agent and
// never sent anywhere except as the words of a reply the owner enabled (EMAIL_AUTO_REPLY=true).
// The values are also added to the fact gate allow-lists for the reply text ONLY (the same allow_facts / allow_metrics mechanism as
// user-data/fact-gate.json), so a CTC figure passes the gate in a reply and nowhere else.
import { existsSync, readFileSync } from 'node:fs';
import { userDataPath } from '../lib/userData.js';
import { loadFactGateConfig, type FactGateConfig } from '../resumeFacts.js';

export const FACT_FIELDS = ['current_ctc', 'expected_ctc', 'notice_period', 'current_location', 'open_to_relocate', 'available_from', 'work_authorization'] as const;
export type FactField = (typeof FACT_FIELDS)[number];
export const MAX_FACT_CHARS = 120;

export type ReplyFacts = Partial<Record<FactField, string>>;

export type ReplyFactsState =
  | { status: 'missing' }
  | { status: 'invalid'; problem: string }
  | { status: 'unconfirmed'; facts: ReplyFacts }
  | { status: 'ready'; facts: ReplyFacts };

/** One value: a short single line the owner wrote. Returns a problem text (never the value) or null. */
function valueProblem(v: string): string | null {
  if (v.length > MAX_FACT_CHARS) return `longer than ${MAX_FACT_CHARS} characters`;
  if (/[\r\n\t\0]/.test(v)) return 'must be one line';
  if (/[–—]/.test(v)) return 'must not contain a long dash (use a plain hyphen)';
  if (/https?:\/\/|www\./i.test(v)) return 'must not contain a link';
  if (/[<>@]/.test(v)) return 'must not contain < > or @';
  if (/[*_`#]/.test(v)) return 'must be plain text (no markdown)';
  return null;
}

/** Pure check of a parsed file. Throws nothing; returns the state. */
export function validateReplyFacts(raw: unknown): ReplyFactsState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'invalid', problem: 'top level must be an object' };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k === '_note' || k === 'confirmed' || (FACT_FIELDS as readonly string[]).includes(k)) continue;
    return { status: 'invalid', problem: `unknown key "${k.slice(0, 40)}"` };
  }
  if ('confirmed' in o && typeof o.confirmed !== 'boolean') return { status: 'invalid', problem: 'confirmed must be true or false' };
  const facts: ReplyFacts = {};
  for (const f of FACT_FIELDS) {
    const v = o[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return { status: 'invalid', problem: `${f} must be a string` };
    const t = v.trim();
    if (t === '') continue;
    const p = valueProblem(t);
    if (p) return { status: 'invalid', problem: `${f}: ${p}` };
    facts[f] = t;
  }
  return o.confirmed === true ? { status: 'ready', facts } : { status: 'unconfirmed', facts };
}

/** Reads the file fresh on every call. Missing file = `missing`; unreadable or invalid = `invalid` (fail closed, nothing is answered). */
export function loadReplyFacts(file: string = userDataPath('reply-facts.json')): ReplyFactsState {
  if (!existsSync(file)) return { status: 'missing' };
  try {
    return validateReplyFacts(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { status: 'invalid', problem: 'file is not valid JSON' };
  }
}

/** The fact gate config for a reply: the owner's fact-gate.json plus the reply fact values as allowed facts and metrics. */
export function replyGateConfig(facts: ReplyFacts, base?: FactGateConfig): FactGateConfig {
  const cfg = base ?? loadFactGateConfig().config;
  const values = Object.values(facts).filter((v): v is string => typeof v === 'string' && v !== '');
  const nums = values.flatMap((v) => v.match(/\d[\d.,]*\s*(?:lpa|lakhs?|lacs?|k|l|cr|crores?|days?|weeks?|months?|years?|yrs?)?/gi) ?? []);
  return {
    ...cfg,
    allow_facts: [...cfg.allow_facts, ...values],
    allow_metrics: [...cfg.allow_metrics, ...values, ...nums.map((n) => n.trim())],
  };
}

/** Human line for the doctor and the Telegram notice: why replies are not answered, or null when the file is usable. */
export function replyFactsProblem(s: ReplyFactsState): string | null {
  if (s.status === 'ready') return null;
  if (s.status === 'missing') return 'user-data/reply-facts.json is missing';
  if (s.status === 'invalid') return `user-data/reply-facts.json is invalid: ${s.problem}`;
  return 'user-data/reply-facts.json is not confirmed yet (set "confirmed": true after you check the values)';
}
