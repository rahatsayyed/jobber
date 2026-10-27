// ONE-OFF backfill (the owner runs it once, then it is deleted): fills sender and message text on open LinkedIn escalations that were
// stored before those columns existed. READ-ONLY on LinkedIn: it opens each thread page through the shared linkedin runtime and reads the
// page text; it never clicks, types or sends. At most 15 threads per run with a random 3 to 8 second pause, and it stops at once on the
// kill switch, a halt, or any open failure. Message text goes through the input screen: a blocked text is kept only in raw_text.
// Usage: npx tsx scripts/backfill-escalation-details.ts [--dry]   (database: JOBAPPLIER_DB, default data.sqlite). Prints counts only.
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { cleanText } from '../src/dash/clean.js';
import { createRuntime } from '../src/linkedin/runtime.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import type { RawSnapshot } from '../src/linkedin/types.js';
import { deriveAskKind, linkedinThreadUrl } from '../src/outreach/escalations.js';
import { defaultDeps, readControl } from '../src/scheduler/control.js';
import { screenUntrusted, type ScreenVerdict } from '../src/safety/screen.js';

type Db = BetterSqlite3.Database;

export const BACKFILL_MAX_THREADS = 15;
export const BACKFILL_PAUSE_MS: readonly [number, number] = [3000, 8000];
const EXCERPT_MAX = 1500;

export interface ThreadDetails { sender: string | null; excerpt: string | null }

/** Sender = the name in the thread header; excerpt = the latest message from them (the page lists the last 6, oldest first). */
export function extractThreadDetails(snap: Pick<RawSnapshot, 'messages' | 'messageHeaderName'>): ThreadDetails {
  const sender = snap.messageHeaderName ? cleanText(snap.messageHeaderName, 120).trim() || null : null;
  const lastThem = [...snap.messages].reverse().find((m) => m.from === 'them');
  const excerpt = lastThem ? cleanText(lastThem.text, EXCERPT_MAX).trim() || null : null;
  return { sender, excerpt };
}

export interface BackfillDeps {
  db: Db;
  /** Opens a thread URL and returns its snapshot, or the failure code. Reads only. */
  open: (url: string) => Promise<{ ok: true; snapshot: Pick<RawSnapshot, 'messages' | 'messageHeaderName'> } | { ok: false; code: string }>;
  screen: (text: string) => Promise<ScreenVerdict>;
  /** True when the kill switch or a LinkedIn halt is active. */
  stopped: () => boolean;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  dry?: boolean;
}

export interface BackfillResult { candidates: number; read: number; updated: number; flagged: number; unreadable: number; stopped: string | null }

export async function backfillEscalationDetails(d: BackfillDeps): Promise<BackfillResult> {
  const rand = d.random ?? Math.random;
  const threads = d.db
    .prepare(
      `SELECT DISTINCT thread_ref FROM escalations
        WHERE platform = 'linkedin' AND thread_ref IS NOT NULL AND resolved_at IS NULL AND message_excerpt IS NULL AND raw_text IS NULL
        ORDER BY thread_ref`,
    )
    .all() as Array<{ thread_ref: string }>;
  const res: BackfillResult = { candidates: threads.length, read: 0, updated: 0, flagged: 0, unreadable: 0, stopped: null };
  if (d.dry) return res;
  const rows = d.db.prepare("SELECT id, reason, detail FROM escalations WHERE platform = 'linkedin' AND thread_ref = ? AND resolved_at IS NULL AND message_excerpt IS NULL AND raw_text IS NULL");
  const setExcerpt = d.db.prepare('UPDATE escalations SET message_excerpt = ?, sender_name = COALESCE(sender_name, ?), thread_url = COALESCE(thread_url, ?), ask_kind = ? WHERE id = ?');
  const setRaw = d.db.prepare('UPDATE escalations SET raw_text = ?, sender_name = COALESCE(sender_name, ?), thread_url = COALESCE(thread_url, ?) WHERE id = ?');
  for (const t of threads.slice(0, BACKFILL_MAX_THREADS)) {
    if (res.read > 0) await d.sleep(BACKFILL_PAUSE_MS[0] + Math.floor(rand() * (BACKFILL_PAUSE_MS[1] - BACKFILL_PAUSE_MS[0])));
    if (d.stopped()) { res.stopped = 'killed_or_halted'; break; }
    const url = linkedinThreadUrl('linkedin', t.thread_ref);
    if (!url) { res.unreadable += 1; continue; }
    const o = await d.open(url);
    if (!o.ok) { res.stopped = o.code; break; }
    res.read += 1;
    const { sender, excerpt } = extractThreadDetails(o.snapshot);
    if (!excerpt) { res.unreadable += 1; continue; }
    const verdict = await d.screen(excerpt);
    for (const r of rows.all(t.thread_ref) as Array<{ id: number; reason: string; detail: string | null }>) {
      if (verdict.blocked) setRaw.run(excerpt, sender, url, r.id);
      else setExcerpt.run(excerpt, sender, url, deriveAskKind({ reason: r.reason, detail: r.detail, excerpt }), r.id);
      res.updated += 1;
    }
    if (verdict.blocked) res.flagged += 1;
  }
  return res;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const db = openDb(dbPath());
  const cfg = loadLinkedinConfig(env);
  const rt = createRuntime({ db, env, idleMs: cfg.idleMs, settleMs: cfg.settleMs });
  const control = defaultDeps(env);
  try {
    const r = await backfillEscalationDetails({
      db,
      dry: process.argv.includes('--dry'),
      open: async (url) => {
        const o = await rt.open(url);
        return o.ok ? { ok: true, snapshot: o.snapshot } : { ok: false, code: o.code };
      },
      screen: (t) => screenUntrusted(t, 'read', { env }),
      stopped: () => {
        const c = readControl(db, control);
        return c.killed || c.halted.linkedin !== null || c.readError !== null;
      },
      sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    });
    console.log(`threads to fill: ${r.candidates}; read: ${r.read}; rows updated: ${r.updated}; flagged by the screen: ${r.flagged}; unreadable: ${r.unreadable}; stopped: ${r.stopped ?? 'no'}`);
  } finally {
    await rt.close();
    db.close();
  }
}
