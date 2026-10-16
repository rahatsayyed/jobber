// Prepared resume lookup and upload-path validation for the typed apply tools (plan 8G-2 task 18).
// findPreparedResumePath moved here from src/apply/linkedin.ts (which re-exports it until task 23).
import type BetterSqlite3 from 'better-sqlite3';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Where render_resume writes PDFs (src/resume.ts: renderer/automation/<id>/resume.pdf). */
export const DEFAULT_RESUME_ROOT = path.join(ROOT, 'renderer', 'automation');
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export function findPreparedResumePath(
  database: BetterSqlite3.Database,
  job_id: string,
): string | undefined {
  const legacy = database
    .prepare('SELECT resume_path, created_at FROM outreach WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(job_id) as { resume_path: string; created_at: string } | undefined;
  const queued = database
    .prepare(
      'SELECT resume_pdf_path as resume_path, created_at FROM outreach_queue WHERE job_id = ? AND resume_pdf_path IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get(job_id) as { resume_path: string; created_at: string } | undefined;

  if (!legacy && !queued) return undefined;
  if (!legacy) return queued!.resume_path;
  if (!queued) return legacy.resume_path;
  return new Date(queued.created_at) >= new Date(legacy.created_at) ? queued.resume_path : legacy.resume_path;
}

/**
 * The real path of the prepared PDF when it is a regular `.pdf` file of sane size inside `root`
 * (symlinks resolved, so a link out of the directory fails); otherwise null. Never throws.
 */
export function validateResumePath(p: string | undefined, root: string = DEFAULT_RESUME_ROOT): string | null {
  if (!p || !/\.pdf$/i.test(p)) return null;
  try {
    const real = realpathSync(path.resolve(p));
    const realRoot = realpathSync(root);
    if (!real.startsWith(realRoot + path.sep)) return null;
    const st = lstatSync(real);
    if (!st.isFile() || st.size < 1 || st.size > MAX_PDF_BYTES) return null;
    return real;
  } catch {
    return null;
  }
}
