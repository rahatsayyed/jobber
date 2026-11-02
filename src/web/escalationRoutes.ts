// src/web/escalationRoutes.ts
// Dashboard Inbox API for the owner's open escalations. Reads use the read-only handle; the two actions (mark handled, snooze) go through
// deps.write on a short-lived write connection. CSRF, Origin and Host checks are enforced by the server for every POST before these handlers
// run. Text is cleaned in listEscalations and rendered as plain text by the frontend; nothing here sends anything to a third party.
import type BetterSqlite3 from 'better-sqlite3';
import { audit, type AuthDb } from '../dash/authStore.js';
import {
  countEscalations, countOpenCards, GROUP_ORDER, listEscalations, NOTE_MAX, type EscGroup, type EscStatus,
} from '../outreach/escalations.js';
import { questionCounts } from '../apply/questionInbox.js';
import { json, readJson, type Ctx } from './router.js';

export interface EscalationDeps {
  /** Marks rows handled (with an optional owner note); returns the number of rows changed. */
  resolve: (ids: number[], now: Date, note?: string) => number;
  /** Puts handled rows back in the open list; returns the number of rows changed. Absent: the reopen route answers a write failure. */
  reopen?: (ids: number[], now: Date) => number;
  /** Hides rows until `until`; returns the number of rows changed. */
  snooze: (ids: number[], until: Date, now: Date) => number;
}

export interface EscalationRoute { method: 'GET' | 'POST'; pattern: string; fn: (c: Ctx) => Promise<void> | void }

export const SNOOZE_HOURS = [1, 4, 24, 72, 168] as const;
const STATUSES: EscStatus[] = ['open', 'snoozed', 'resolved', 'all'];
const PLATFORM_RE = /^[a-z]{1,20}$/;
const MAX_IDS = 200;

function idsOf(body: unknown): number[] | null {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).ids : undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDS) return null;
  if (!raw.every((x) => Number.isInteger(x) && (x as number) > 0)) return null;
  return raw as number[];
}

export function createEscalationRoutes(
  deps: EscalationDeps,
  env: { auth: AuthDb; data: BetterSqlite3.Database; now: () => Date },
): EscalationRoute[] {
  const { auth, data, now } = env;
  const act = async (c: Ctx, kind: 'resolve' | 'snooze' | 'reopen'): Promise<void> => {
    const body = await readJson(c.req, 4096);
    const ids = idsOf(body);
    if (!ids) return json(c.res, 400, { error: 'invalid ids' });
    const t = now();
    let changed: number;
    try {
      if (kind === 'resolve') {
        const note = (body as Record<string, unknown>).note;
        if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > NOTE_MAX)) return json(c.res, 400, { error: 'invalid note' });
        changed = deps.resolve(ids, t, typeof note === 'string' && note.trim() ? note : undefined);
      } else if (kind === 'reopen') {
        if (!deps.reopen) throw new Error('no escalation reopen writer configured');
        changed = deps.reopen(ids, t);
      } else {
        const hours = (body as Record<string, unknown>).hours;
        if (typeof hours !== 'number' || !(SNOOZE_HOURS as readonly number[]).includes(hours)) return json(c.res, 400, { error: 'invalid hours' });
        changed = deps.snooze(ids, new Date(t.getTime() + hours * 3_600_000), t);
      }
    } catch (e) {
      console.error(`web: escalation ${kind} failed: ${e instanceof Error ? e.name : 'error'}`);
      return json(c.res, 502, { error: 'write failed' });
    }
    // Audit carries the kind and the row ids only, never the note or any escalation text.
    audit(auth, kind === 'resolve' ? 'escalation_resolve' : kind === 'reopen' ? 'escalation_reopen' : 'escalation_snooze', { ip: c.ip, note: `${changed} of ${ids.length}; ids ${ids.slice(0, 10).join(',')}` }, t);
    json(c.res, 200, { ok: true, changed, counts: countEscalations(data, t) });
  };

  return [
    {
      method: 'GET', pattern: '/api/escalations',
      fn: (c) => {
        const status = (c.url.searchParams.get('status') ?? 'open') as EscStatus;
        const platform = c.url.searchParams.get('platform') ?? undefined;
        const group = c.url.searchParams.get('group') ?? undefined;
        if (!STATUSES.includes(status)) return json(c.res, 400, { error: 'invalid status' });
        if (platform !== undefined && !PLATFORM_RE.test(platform)) return json(c.res, 400, { error: 'invalid platform' });
        if (group !== undefined && !(GROUP_ORDER as string[]).includes(group)) return json(c.res, 400, { error: 'invalid group' });
        json(c.res, 200, listEscalations(data, { now: now(), status, platform, group: group as EscGroup | undefined }));
      },
    },
    // `cards` is what the Inbox list shows as open (one card per conversation); open/snoozed/resolved stay raw row counts.
    { method: 'GET', pattern: '/api/escalations/count', fn: (c) => {
        const cards = countOpenCards(data, now());
        const q = questionCounts(data);
        // `badge` is what the Inbox tab shows: the cards plus the jobs that wait for an answer.
        json(c.res, 200, { ...countEscalations(data, now()), cards, questions: q.questions, questionJobs: q.jobs, badge: cards + q.jobs });
      },
    },
    { method: 'POST', pattern: '/api/escalations/resolve', fn: (c) => act(c, 'resolve') },
    { method: 'POST', pattern: '/api/escalations/reopen', fn: (c) => act(c, 'reopen') },
    { method: 'POST', pattern: '/api/escalations/snooze', fn: (c) => act(c, 'snooze') },
  ];
}
