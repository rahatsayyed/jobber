// apply_upload({field}): attaches the prepared PDF (outreach_queue.resume_pdf_path, inside the output
// directory, .pdf) to the resume field. Cover letters are never uploaded (D12).
import { z } from 'zod';
import { hostOfUrl } from '../../webcore/login.js';
import { FieldIdSchema } from '../refs.js';
import { DEFAULT_RESUME_ROOT, findPreparedResumePath, validateResumePath } from '../resume.js';
import { dryRunResult, findField, inPage, refuse, type ApplierDeps, type ApplyResult } from './common.js';

export const UploadInput = z.object({ field: FieldIdSchema }).strict();
export type UploadInputT = z.infer<typeof UploadInput>;

export async function handleUpload(input: UploadInputT, deps: ApplierDeps): Promise<ApplyResult> {
  return inPage(deps, async ({ page, job, model }) => {
    const f = findField(model, input.field);
    if (!f) return refuse('unknown_field', 'no such field on this page');
    if (f.hidden) return refuse('hidden_field', 'the field is not visible');
    if (f.type !== 'file') return refuse('not_a_file_field', 'this is not a file field');
    if (f.role === 'cover_letter') {
      return f.required
        ? { status: 'needs_owner', code: 'cover_letter', reason: 'a cover letter is required and none is prepared' }
        : refuse('cover_letter_not_supplied', 'optional cover letters stay empty');
    }
    if (f.role !== 'resume') return refuse('unsupported_upload', 'only the resume is uploaded');
    const pdf = validateResumePath(findPreparedResumePath(deps.db, job.jobId), deps.resumeRoot ?? DEFAULT_RESUME_ROOT);
    if (!pdf) return refuse('no_resume', 'no prepared resume PDF for this job');

    const dry = dryRunResult(deps, 'apply_upload', { job_id: job.jobId, field: f.id });
    if (dry) return dry;
    // Same re-check as a typed value: nothing is attached once the page left the host.
    if (hostOfUrl(page.url()) !== job.host) return refuse('host_changed', 'the page moved to another host; nothing was uploaded');
    const loc = page.locator(`[data-jf="${Number(f.id.slice(1)) - 1}"]`).first();
    if (!loc.setInputFiles) return { status: 'failed', code: 'error', reason: 'page interaction failed' };
    try {
      await loc.setInputFiles(pdf, { timeout: 15000 });
    } catch {
      return { status: 'failed', code: 'error', reason: 'page interaction failed' };
    }
    return { status: 'ok', code: 'uploaded' };
  });
}
