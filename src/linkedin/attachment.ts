// src/linkedin/attachment.ts
// The one file a LinkedIn message may carry: the tailored resume PDF of the latest job tied to the person. CODE resolves it, never the model:
// touches.job_id (newest first) -> outreach_queue.resume_pdf_path. The path must lie inside <repo>/renderer/automation/ (symlinks resolved),
// end in .pdf, exist (a missing PDF is re-rendered from resume.html in the same folder) and be at most ATTACH_MAX_BYTES. The file is uploaded
// under a generic name built from resume.json `name` (Rahat-Sayyed-Resume.pdf), never the on-disk name. No tool accepts a path.
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { PROJECT_ROOT } from '../layout/config.js';

type Db = BetterSqlite3.Database;

export const ATTACH_MAX_BYTES = 2 * 1024 * 1024;
/** Arm argument: the only attachment there is. */
export const ATTACH_KIND = 'job_resume';
/** Arm kinds that may carry an attachment (replies with attach_resume always; the others only when LINKEDIN_DM_ATTACH_RESUME allows). */
export const ATTACH_KINDS: readonly string[] = ['reply', 'role_ask', 'rapport', 'followup'];

export interface ResolvedAttachment {
  /** Absolute path of the PDF (inside renderer/automation). */
  path: string;
  /** Generic upload name, for example Rahat-Sayyed-Resume.pdf. */
  name: string;
  bytes: number;
  /** True when the PDF had to be re-rendered from resume.html. */
  rendered: boolean;
}
export type ResolveResult = { ok: true; attachment: ResolvedAttachment } | { ok: false; code: string; reason: string };

export interface ResolveDeps {
  /** Repo root (default PROJECT_ROOT). */
  root?: string;
  /** Re-render a missing PDF from its resume.html (default src/pdfRender.ts htmlToPdf). Tests pass a fake. */
  render?: (htmlPath: string, pdfPath: string) => Promise<void>;
  /** The full name from resume.json (default: the base resume). Tests pass a value. */
  resumeName?: () => string | null;
}

/** LINKEDIN_DM_ATTACH_RESUME: true lets first DMs (role_ask, rapport, followup) carry the resume. Anything else, or unset, is false. */
export function dmAttachAllowed(env: NodeJS.ProcessEnv): boolean {
  return (env.LINKEDIN_DM_ATTACH_RESUME ?? '').trim().toLowerCase() === 'true';
}

/** Rahat Sayyed -> Rahat-Sayyed-Resume.pdf. ASCII letters and digits only; an empty or odd name gives Resume.pdf. */
export function attachmentFileName(fullName: string | null | undefined): string {
  const ascii = String(fullName ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 4)
    .join('-')
    .slice(0, 60);
  return ascii ? `${ascii}-Resume.pdf` : 'Resume.pdf';
}

async function readResumeName(deps: ResolveDeps): Promise<string | null> {
  if (deps.resumeName) return deps.resumeName();
  try {
    const { getBaseResume } = await import('../resume.js');
    const r = getBaseResume() as { name?: unknown };
    return typeof r?.name === 'string' ? r.name : null;
  } catch {
    return null;
  }
}

const within = (dir: string, p: string): boolean => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** The directory every attachable PDF lives under. */
export function attachRoot(root: string = PROJECT_ROOT): string {
  return path.resolve(root, 'renderer', 'automation');
}

/** True when `p` (absolute or relative to root) is a .pdf lexically inside renderer/automation. No filesystem access. */
export function lexicallyAllowed(p: string, root: string = PROJECT_ROOT): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024 || p.includes('\0')) return false;
  const abs = path.resolve(root, p);
  return abs.toLowerCase().endsWith('.pdf') && within(attachRoot(root), abs) && abs !== attachRoot(root);
}

/** Existing file checks: real path still inside the automation folder, a regular file, 1 byte to ATTACH_MAX_BYTES. */
export function checkFile(abs: string, root: string = PROJECT_ROOT): { ok: true; bytes: number; real: string } | { ok: false; code: string; reason: string } {
  try {
    const realDir = realpathSync(attachRoot(root));
    const real = realpathSync(abs);
    if (!within(realDir, real) || !real.toLowerCase().endsWith('.pdf')) return { ok: false, code: 'attachment_outside_dir', reason: 'resume file is not inside renderer/automation' };
    const st = statSync(real);
    if (!st.isFile()) return { ok: false, code: 'attachment_not_file', reason: 'resume path is not a regular file' };
    if (st.size <= 0) return { ok: false, code: 'attachment_empty', reason: 'resume file is empty' };
    if (st.size > ATTACH_MAX_BYTES) return { ok: false, code: 'attachment_too_large', reason: `resume file is over ${ATTACH_MAX_BYTES} bytes` };
    return { ok: true, bytes: st.size, real };
  } catch {
    return { ok: false, code: 'attachment_missing', reason: 'resume file could not be read' };
  }
}

/** Job ids tied to the person, newest touch first. */
function jobIdsOf(db: Db, personId: number): string[] {
  const rows = db
    .prepare('SELECT job_id FROM touches WHERE person_id = ? AND job_id IS NOT NULL ORDER BY id DESC LIMIT 20')
    .all(personId) as { job_id: string }[];
  return [...new Set(rows.map((r) => r.job_id))];
}

/** Resolve the tailored resume PDF for this person. Never throws. */
export async function resolveJobResume(db: Db, personId: number, deps: ResolveDeps = {}): Promise<ResolveResult> {
  try {
    for (const jobId of jobIdsOf(db, personId)) {
      const r = await resolveJobIdResume(db, jobId, deps);
      if (r.ok || r.code !== 'attachment_no_resume') return r;
    }
    return { ok: false, code: 'attachment_no_resume', reason: 'no tailored resume is on file for a job tied to this person' };
  } catch {
    return { ok: false, code: 'attachment_error', reason: 'resume attachment could not be resolved' };
  }
}

/** Resolve the tailored resume PDF stored for ONE job (newest queue row with a resume). Same checks as resolveJobResume. Never throws. */
export async function resolveJobIdResume(db: Db, jobId: string, deps: ResolveDeps = {}): Promise<ResolveResult> {
  try {
    const r = db
      .prepare("SELECT resume_pdf_path FROM outreach_queue WHERE job_id = ? AND resume_pdf_path IS NOT NULL AND resume_pdf_path <> '' ORDER BY id DESC LIMIT 1")
      .get(jobId) as { resume_pdf_path: string } | undefined;
    if (!r) return { ok: false, code: 'attachment_no_resume', reason: 'no tailored resume is on file for this job' };
    return await resolveStoredResume(r.resume_pdf_path, deps);
  } catch {
    return { ok: false, code: 'attachment_error', reason: 'resume attachment could not be resolved' };
  }
}

/** The shared checks for a stored resume path: inside renderer/automation, re-rendered when missing, size-checked, generic upload name. */
export async function resolveStoredResume(stored: string, deps: ResolveDeps = {}): Promise<ResolveResult> {
  const root = deps.root ?? PROJECT_ROOT;
  const fail = (code: string, reason: string): ResolveResult => ({ ok: false, code, reason });
  try {
    if (!lexicallyAllowed(stored, root)) return fail('attachment_outside_dir', 'resume path is not a .pdf inside renderer/automation');
    const abs = path.resolve(root, stored);
    let rendered = false;
    if (!existsSync(abs)) {
      const html = path.join(path.dirname(abs), 'resume.html');
      if (!existsSync(html) || !lexicallyAllowed(abs, root) || !within(attachRoot(root), html)) return fail('attachment_missing', 'resume PDF is missing and cannot be re-rendered');
      const render = deps.render ?? (async (h: string, p: string) => { const m = await import('../pdfRender.js'); await m.htmlToPdf(h, p); });
      try { await render(html, abs); } catch { return fail('attachment_render_failed', 'resume PDF could not be re-rendered'); }
      rendered = true;
    }
    const chk = checkFile(abs, root);
    if (!chk.ok) return fail(chk.code, chk.reason);
    return { ok: true, attachment: { path: chk.real, name: attachmentFileName(await readResumeName(deps)), bytes: chk.bytes, rendered } };
  } catch {
    return fail('attachment_error', 'resume attachment could not be resolved');
  }
}
