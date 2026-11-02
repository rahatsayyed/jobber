// src/status/snapshot.ts
import type BetterSqlite3 from 'better-sqlite3';
import { funnelStats } from '../funnel.js';
import type { OutreachConfig } from '../outreach/config.js';
import { ceilings, type CeilingStatus, type LimitKey } from '../outreach/limits.js';
import { openQuestionViews, type OpenQuestionView } from '../outreach/escalations.js';

export interface Snapshot {
  generatedAt: string;
  ceilings: Record<LimitKey, CeilingStatus>;
  dailyCounters: { key: string; count: number }[];
  halts: { platform: string; reason: string; setAt: string }[];
  queue: { status: string; count: number }[];
  funnel: { discovered: number; matched: number; contacted: number; replied: number; interview: number; offer: number };
  lastSend: { kind: string; at: string } | null;
  /** Applications paused for an owner answer: the open apply_questions (capped list) and the total count. */
  openQuestions: { count: number; items: OpenQuestionView[] };
  /** Applications paused for a human step (login, CAPTCHA, MFA): job count per host; the command is `npm run apply:assist -- <job_id>`. */
  needsHuman: { count: number; hosts: { host: string; jobs: number; example_job_id: string; command: string }[] };
  // Sections not readable because a table is missing; their values are fallbacks, not facts.
  degraded: string[];
}

// Run one read section; a missing table yields the fallback and is recorded in `degraded`, any other error rethrows.
function makeSection(degraded: string[]) {
  return function section<T>(name: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) {
        degraded.push(name);
        return fallback;
      }
      throw e;
    }
  };
}

/** SQLite `datetime('now')` strings have no zone and are UTC; ISO strings pass through. */
function toIso(s: string): string {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

export function buildSnapshot(db: BetterSqlite3.Database, cfg: OutreachConfig, now: Date): Snapshot {
  const degraded: string[] = [];
  const section = makeSection(degraded);
  // Fail-safe: if the counters cannot be read, report every ceiling as not ok rather than a fabricated safe state.
  const zeroCeilings = Object.fromEntries(
    (['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message', 'wellfound_apply', 'wellfound_message', 'wellfound_discover', 'apply_attempt', 'site_account', 'linkedin_discover', 'external_resolve', 'linkedin_profile_view'] as LimitKey[]).map((k) => [
      k,
      { used: 0, limit: 0, ok: false },
    ]),
  ) as Record<LimitKey, CeilingStatus>;
  const day = now.toISOString().slice(0, 10);

  const dailyCounters = section(
    'dailyCounters',
    () =>
      db
        .prepare('SELECT key, count FROM daily_counters WHERE day = ? ORDER BY key')
        .all(day) as { key: string; count: number }[],
    [],
  );

  const halts = section(
    'halts',
    () =>
      (
        db
          .prepare('SELECT platform, reason, set_at FROM halt_flags WHERE cleared_at IS NULL ORDER BY platform')
          .all() as { platform: string; reason: string; set_at: string }[]
      ).map((r) => ({ platform: r.platform, reason: r.reason, setAt: r.set_at })),
    [],
  );

  const queue = section(
    'queue',
    () =>
      db
        .prepare('SELECT coalesce(status, \'unknown\') AS status, COUNT(*) AS count FROM outreach_queue GROUP BY status ORDER BY status')
        .all() as { status: string; count: number }[],
    [],
  );

  const funnel = section(
    'funnel',
    () => {
      const f = funnelStats(db);
      return {
        discovered: f.discovered,
        matched: f.matched,
        contacted: f.contacted,
        replied: f.replied,
        interview: f.interview,
        offer: f.offer,
      };
    },
    { discovered: 0, matched: 0, contacted: 0, replied: 0, interview: 0, offer: 0 },
  );

  const candidates: { kind: string; at: string }[] = [];
  section('lastSend.touches', () => {
    const r = db
      .prepare("SELECT kind, sent_at AS at FROM touches WHERE status = 'sent' AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1")
      .get() as { kind: string; at: string } | undefined;
    if (r) candidates.push({ kind: r.kind, at: toIso(r.at) });
  }, undefined);
  section('lastSend.outreach_queue', () => {
    const r = db
      .prepare('SELECT MAX(email_sent_at) AS at FROM outreach_queue WHERE email_sent_at IS NOT NULL')
      .get() as { at: string | null };
    if (r.at) candidates.push({ kind: 'email', at: toIso(r.at) });
  }, undefined);
  candidates.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    generatedAt: now.toISOString(),
    ceilings: section('ceilings', () => ceilings(db, cfg, now), zeroCeilings),
    dailyCounters,
    halts,
    queue,
    funnel,
    lastSend: candidates[0] ?? null,
    openQuestions: section('openQuestions', () => ({
      count: (db.prepare("SELECT COUNT(*) AS n FROM apply_questions WHERE status = 'open'").get() as { n: number }).n,
      items: openQuestionViews(db),
    }), { count: 0, items: [] }),
    needsHuman: section('needsHuman', () => {
      const rows = db.prepare(
        `SELECT j.id AS job_id, COALESCE(NULLIF(j.external_apply_url, ''), j.apply_url) AS url FROM outreach_queue q JOIN jobs j ON j.id = q.job_id
         WHERE q.apply_status = 'needs_human' ORDER BY q.id`,
      ).all() as { job_id: string; url: string | null }[];
      const byHost = new Map<string, { host: string; jobs: number; example_job_id: string; command: string }>();
      for (const r of rows) {
        let host = '';
        try { host = new URL(r.url ?? '').hostname.toLowerCase(); } catch { host = 'unknown'; }
        const e = byHost.get(host);
        if (e) e.jobs += 1;
        else byHost.set(host, { host, jobs: 1, example_job_id: r.job_id, command: `npm run apply:assist -- ${r.job_id}` });
      }
      return { count: rows.length, hosts: [...byHost.values()] };
    }, { count: 0, hosts: [] }),
    degraded,
  };
}
