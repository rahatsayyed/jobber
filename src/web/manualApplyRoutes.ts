// src/web/manualApplyRoutes.ts
// Dashboard Inbox API for the MANUAL APPLY queue (src/manual/manualApply.ts): the jobs the owner applies to by hand. Reads use the
// read-only handle; done and skip run the SAME service functions as `npm run apply:manual` through deps.write on a short-lived write
// connection. CSRF, Origin and Host checks are enforced by the server for every POST before these handlers run. The audit log carries the
// action and the queue row ids only, never the note. The resume download takes only a queue row id: the file is whatever the existing
// attachment resolver returns (inside renderer/automation, at most 2 MB, generic download name); no path ever comes from the client, and
// the web process never re-renders a missing PDF (the CLI does that).
import BetterSqlite3 from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { audit, type AuthDb } from '../dash/authStore.js';
import { ATTACH_MAX_BYTES, resolveJobIdResume, type ResolveDeps } from '../linkedin/attachment.js';
import { buildManualQueue, manualReasonLabel, markDone, markSkip, MANUAL_NOTE_MAX, type ManualApplyItem, type MarkResult } from '../manual/manualApply.js';
import { json, readJson, type Ctx } from './router.js';

type Db = BetterSqlite3.Database;

export interface ManualApplyDeps {
  /** Runs `fn` on a short-lived write connection (the dashboard's own handle is read-only). */
  write: <T>(fn: (db: Db) => T) => T;
  /** The full name from resume.json for the generic download name; default: the base resume. */
  resumeName?: () => string | null;
  /** Test seam: repo root the resume resolver uses (default PROJECT_ROOT). */
  root?: string;
}

export function withManualApplyWriter<T>(path: string, fn: (db: Db) => T): T {
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

export interface ManualApplyRoute { method: 'GET' | 'POST'; pattern: string; fn: (c: Ctx, params: string[]) => Promise<void> | void }

export interface ManualApplyWebItem {
  id: number; job_id: string; title: string; company: string; platform: string; open_url: string;
  /** The generic download name (Rahat-Sayyed-Resume.pdf) when a tailored resume file is available now, else null. Never a disk path. */
  resume_pdf: string | null;
  /** Same-origin API URL that streams the PDF, or null. */
  resume_download: string | null;
  ats_note: string | null; reason: string; reason_label: string; since: string;
}

const MAX_IDS = 100;
const BODY_MAX = 8 * 1024;
const ID_RE = /^\d{1,9}$/;

const isId = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0 && (x as number) < 1_000_000_000;
const obj = (b: unknown): Record<string, unknown> | null => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null);

interface ItemResult { id: number; ok: boolean; error?: string }

export function createManualApplyRoutes(
  deps: ManualApplyDeps,
  env: { auth: AuthDb; data: Db; now: () => Date; processEnv?: NodeJS.ProcessEnv },
): ManualApplyRoute[] {
  const { auth, data, now } = env;
  const penv = (): NodeJS.ProcessEnv => env.processEnv ?? process.env;

  // The resolver with re-render switched off: a missing PDF is simply "not available" here.
  const resolveDeps = (): ResolveDeps => ({
    root: deps.root,
    render: async () => { throw new Error('no render in the web process'); },
    resumeName: deps.resumeName ?? undefined,
  });

  const view = (): { count: number; easyApplyOff: number; items: ManualApplyItem[] } => buildManualQueue(data, penv());
  const counts = (): { count: number; easyApplyOff: number } => { const v = view(); return { count: v.count, easyApplyOff: v.easyApplyOff }; };

  const bad = (c: Ctx, why: string): void => {
    audit(auth, 'manual_apply_reject', { ip: c.ip, note: why }, now());
    json(c.res, 400, { error: why });
  };

  const act = async (c: Ctx, kind: 'done' | 'skip'): Promise<void> => {
    const b = obj(await readJson(c.req, BODY_MAX));
    const raw = b?.ids;
    if (!b || !Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDS || !raw.every(isId)) return bad(c, 'invalid ids');
    const note = b.note;
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MANUAL_NOTE_MAX)) return bad(c, 'invalid note');
    const text = typeof note === 'string' && note.trim() ? note : null;
    const ids = [...new Set(raw as number[])];
    const t = now();
    const results: ItemResult[] = ids.map((id) => {
      try {
        const r: MarkResult = deps.write((db) => (kind === 'done' ? markDone(db, id, penv(), t, text) : markSkip(db, id, penv(), text)));
        return r.ok ? { id, ok: true } : { id, ok: false, error: 'not on the list (already handled, or no longer waiting)' };
      } catch (e) {
        console.error(`web: manual apply ${kind} failed: ${e instanceof Error ? e.name : 'error'}`);
        return { id, ok: false, error: 'write failed' };
      }
    });
    const okIds = results.filter((r) => r.ok).map((r) => r.id);
    audit(auth, kind === 'done' ? 'manual_apply_done' : 'manual_apply_skip',
      { ip: c.ip, note: `${okIds.length} of ${results.length}; ids ${results.map((r) => r.id).slice(0, 10).join(',')}` }, t);
    const failed = okIds.length === 0;
    let current = { count: 0, easyApplyOff: 0 };
    try { current = counts(); } catch { /* counts are a hint only */ }
    json(c.res, failed ? 422 : 200, { ok: !results.some((r) => !r.ok), results, error: failed ? results[0]?.error : undefined, counts: current });
  };

  return [
    {
      method: 'GET', pattern: '/api/manual-apply',
      fn: async (c) => {
        const v = view();
        const rd = resolveDeps();
        const items: ManualApplyWebItem[] = [];
        for (const it of v.items) {
          const r = await resolveJobIdResume(data, it.job_id, rd);
          items.push({
            id: it.id, job_id: it.job_id, title: it.title, company: it.company, platform: it.platform, open_url: it.open_url,
            resume_pdf: r.ok ? r.attachment.name : null,
            resume_download: r.ok ? `/api/manual-apply/${it.id}/resume` : null,
            ats_note: it.ats_note, reason: it.reason, reason_label: manualReasonLabel(it.reason), since: it.since,
          });
        }
        json(c.res, 200, { count: v.count, easyApplyOff: v.easyApplyOff, easyApplyEnabled: penv().APPLY_LINKEDIN_EASY === 'true', items });
      },
    },
    {
      // The tailored resume of one listed job. The client sends a queue row id and nothing else.
      method: 'GET', pattern: '/api/manual-apply/:id/resume',
      fn: async (c, [id]) => {
        if (!ID_RE.test(id)) return json(c.res, 400, { error: 'invalid id' });
        const item = view().items.find((i) => i.id === Number(id));
        if (!item) return json(c.res, 404, { error: 'not found' });
        const r = await resolveJobIdResume(data, item.job_id, resolveDeps());
        if (!r.ok) return json(c.res, 404, { error: 'resume not available' });
        let bytes: Buffer;
        try { bytes = readFileSync(r.attachment.path); } catch { return json(c.res, 404, { error: 'resume not available' }); }
        if (bytes.length === 0 || bytes.length > ATTACH_MAX_BYTES || bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
          return json(c.res, 404, { error: 'resume not available' });
        }
        audit(auth, 'manual_apply_resume', { ip: c.ip, note: `id ${item.id}` }, now());
        c.res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${r.attachment.name}"`,
          'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store',
        });
        c.res.end(bytes);
      },
    },
    { method: 'POST', pattern: '/api/manual-apply/done', fn: (c) => act(c, 'done') },
    { method: 'POST', pattern: '/api/manual-apply/skip', fn: (c) => act(c, 'skip') },
  ];
}
