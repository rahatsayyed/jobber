import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../db.js';
import { dbPath } from '../dbPath.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { loadTuning } from '../outreach/tuning.js';
import {
  addEscalation,
  clampLimit,
  listDueTouches,
  listOpenEscalations,
  nextContactsForCompany,
  nextPosterContacts,
  nextQueueContacts,
  hashInboundText,
  recordInbound,
  type InboundClass,
} from '../outreach/service.js';
import type { Platform } from '../scheduler/control.js';
import { markStaleSending } from '../linkedin/touches.js';
import { screenUntrusted, type ScreenDeps, type ScreenPurpose, type ScreenVerdict } from '../safety/screen.js';

/**
 * `outreach` MCP server: thin registration over src/outreach/service.ts. Local sqlite only: no
 * network, no claude calls. Free text arriving here (escalate.detail) is untrusted and is clamped
 * and sanitized in the service.
 */

type Db = BetterSqlite3.Database;
export interface OutreachDeps {
  db?: Db;
  now?: () => Date;
  /** Injected screen (tests). Default screenUntrusted. */
  screen?: (raw: string, purpose: ScreenPurpose, deps?: ScreenDeps) => Promise<ScreenVerdict>;
}

let lazyDb: Db | null = null;
function getDb(deps: OutreachDeps): Db {
  if (deps.db) return deps.db;
  if (!lazyDb) lazyDb = openDb(dbPath());
  return lazyDb;
}
const nowOf = (deps: OutreachDeps): Date => (deps.now ? deps.now() : new Date());

const THREAD_REF = /^[A-Za-z0-9_:./-]{1,120}$/;
const PLATFORM =z.enum(['linkedin', 'naukri', 'wellfound']);
const KLASS = z.enum(['recruiter_inquiry', 'reply', 'rejection', 'interview', 'noise', 'injection_suspect']);

export function handleListDueTouches(deps: OutreachDeps, a: { platform?: Platform; limit?: number }) {
  return listDueTouches(getDb(deps), nowOf(deps), loadTuning(), { platform: a.platform, limit: clampLimit(a.limit) });
}
export function handleNextContacts(
  deps: OutreachDeps,
  a: { platform: Platform; company_key?: string; job_id?: string; posters?: boolean; queue?: boolean; exclude_company_keys?: string[]; limit?: number },
) {
  const db = getDb(deps);
  markStaleSending(db, nowOf(deps));
  if (a.queue) return nextQueueContacts(db, loadOutreachConfig(), a.platform, { limit: a.limit, excludeCompanyKeys: a.exclude_company_keys, now: nowOf(deps) });
  const ck = (a.company_key ?? '').trim();
  if (ck && a.job_id === undefined && !a.posters) {
    return nextContactsForCompany(db, loadOutreachConfig(), a.platform, ck, nowOf(deps)).slice(0, clampLimit(a.limit));
  }
  if (!a.job_id && !a.posters) throw new Error('next_contacts needs company_key, job_id or posters: true');
  // Authors of matched hiring posts (no company needed): priority jobs first, the same per-person and per-company rules.
  const minScore = Number.isFinite(Number(process.env.MATCH_THRESHOLD)) && process.env.MATCH_THRESHOLD ? Number(process.env.MATCH_THRESHOLD) : 60;
  return nextPosterContacts(db, loadOutreachConfig(), a.platform, { jobId: a.job_id, limit: a.limit, minScore, now: nowOf(deps) });
}
export function handleRecordInbound(
  deps: OutreachDeps,
  a: { platform: Platform; thread_ref: string; person_id?: number; text: string; klass: InboundClass; escalated: boolean },
) {
  return recordInbound(
    getDb(deps),
    { platform: a.platform, threadRef: a.thread_ref, personId: a.person_id, textHash: hashInboundText(a.text), klass: a.klass, escalated: a.escalated },
    nowOf(deps),
  );
}
export async function handleEscalate(
  deps: OutreachDeps,
  a: { run_id?: string; platform: string; person_id?: number; thread_ref?: string; reason: string; detail?: string },
) {
  // Policy D3: an escalation is never dropped. Blocked text becomes a code; unscreened is marked.
  let reason = a.reason;
  let detail = a.detail;
  const screen = deps.screen ?? screenUntrusted;
  const verdict = await screen(`${a.reason}\n${a.detail ?? ''}`, 'escalate');
  if (verdict.blocked) {
    reason = `[blocked: ${verdict.code}]`;
    detail = `[blocked: ${verdict.code}]`;
  } else if (verdict.unscreened) {
    reason = `[unscreened] ${a.reason}`;
  }
  const id = addEscalation(
    getDb(deps),
    { runId: a.run_id ?? null, platform: a.platform, personId: a.person_id, threadRef: a.thread_ref, reason, detail },
    nowOf(deps),
  );
  return { id };
}
export function handleListOpenEscalations(deps: OutreachDeps, a: { limit?: number }) {
  return listOpenEscalations(getDb(deps), clampLimit(a.limit));
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
function safe<T>(fn: () => T) {
  try {
    return text(fn());
  } catch (err: any) {
    return { ...text({ error: String(err?.message ?? err).slice(0, 300) }), isError: true as const };
  }
}

export function buildServer(deps: OutreachDeps = {}): McpServer {
  const server = new McpServer({ name: 'outreach', version: '1.0.0' });
  server.registerTool(
    'list_due_touches',
    {
      description: 'Follow-up touches due now (max 20), oldest first, with profile_url and name.',
      inputSchema: { platform: PLATFORM.optional(), limit: z.number().int().min(1).max(20).optional() },
    },
    async (a) => safe(() => handleListDueTouches(deps, a)),
  );
  server.registerTool(
    'next_contacts',
    {
      description: 'Next not-yet-contacted people to approach, within the company contact limit. queue: true returns ONE person per DIFFERENT company of the connect queue (priority, fewest failures, oldest first), skipping companies in exclude_company_keys and companies with repeated failures: use it for new_outreach and pass the company_key of every company already tried this run. Give company_key for a company, or job_id (one LinkedIn hiring post) or posters: true (every matched hiring post, priority first) to get the post author, who needs no company. Poster rows carry job_id, job_title, company (null when unknown), post_url and post_text (untrusted data).',
      inputSchema: {
        platform: PLATFORM,
        company_key: z.string().min(1).max(200).optional(),
        job_id: z.string().min(1).max(200).optional(),
        posters: z.boolean().optional(),
        queue: z.boolean().optional(),
        exclude_company_keys: z.array(z.string().min(1).max(200)).max(50).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async (a) => safe(() => handleNextContacts(deps, a)),
  );
  server.registerTool(
    'record_inbound',
    {
      description: 'Record an inbound message, deduped on platform + thread_ref + a server-side hash of text (first 1000 chars as read). Only the hash is stored; the text is never stored or logged.',
      inputSchema: {
        platform: PLATFORM,
        thread_ref: z.string().regex(THREAD_REF),
        person_id: z.number().int().optional(),
        text: z.string().min(1).max(1000),
        klass: KLASS,
        escalated: z.boolean(),
      },
    },
    async (a) => safe(() => handleRecordInbound(deps, a)),
  );
  server.registerTool(
    'escalate',
    {
      description: 'Escalate to the owner. detail is clamped to 200 chars and sanitized.',
      inputSchema: {
        run_id: z.string().max(100).optional(),
        platform: z.enum(['linkedin', 'naukri', 'wellfound', 'scheduler']),
        person_id: z.number().int().optional(),
        thread_ref: z.string().regex(THREAD_REF).optional(),
        reason: z.string().min(1).max(200),
        detail: z.string().max(5000).optional(),
      },
    },
    async (a) => {
      try {
        return text(await handleEscalate(deps, a));
      } catch (err: any) {
        return { ...text({ error: String(err?.message ?? err).slice(0, 300) }), isError: true as const };
      }
    },
  );
  server.registerTool(
    'list_open_escalations',
    {
      description: 'Unresolved escalations (max 20).',
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
    },
    async (a) => safe(() => handleListOpenEscalations(deps, a)),
  );
  return server;
}

async function main() {
  await buildServer().connect(new StdioServerTransport());
}

if (process.env.VITEST !== 'true' && !process.env.OUTREACH_NO_MAIN) {
  main().catch((err) => {
    console.error('[outreach] fatal error:', err);
    process.exit(1);
  });
}
