// Submit confirmation (plan 8G-2 task 18). Three layers, strictest first; anything else is not a
// confirmation and the caller reports `unconfirmed` (manual_review), never `submitted`.
import type { FormModel, RawFormSnapshot } from '../webcore/formModel.js';

/** Per-platform signals a recipe may ship (task 19). Regexes only, matched against page text or URL path. */
export interface ConfirmSignals { text?: RegExp[]; urlPath?: RegExp[] }
export interface ConfirmResult { confirmed: boolean; layer: 'recipe' | 'url' | 'text' | 'none' }

const URL_PATH = /\/(?:thanks?|thank-you|confirm(?:ation|ed)?|success|submitted|complete[d]?)(?:\/|$|\?)/i;
const GENERIC_TEXT = /thank you for (?:applying|your application)|application (?:has been |was )?(?:submitted|received|sent)|we(?:'ve| have) received your application/i;

const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return ''; } };

export function detectConfirmation(
  before: FormModel,
  after: { raw: RawFormSnapshot; model: FormModel },
  signals?: ConfirmSignals | null,
): ConfirmResult {
  const none: ConfirmResult = { confirmed: false, layer: 'none' };
  const m = after.model;
  if (m.block) return none;
  if ((m.notices ?? []).length > 0) return none;
  // The form must be gone: no visible field and no submit/next control left on the page.
  const formGone = !m.fields.some((f) => !f.hidden) && !m.controls.some((c) => c.kind === 'submit' || c.kind === 'next');
  if (!formGone) return none;
  const text = `${after.raw.title ?? ''}\n${after.raw.text ?? ''}`;
  const p = pathOf(m.url);
  if (signals && ((signals.text ?? []).some((r) => r.test(text)) || (signals.urlPath ?? []).some((r) => r.test(p)))) {
    return { confirmed: true, layer: 'recipe' };
  }
  if (p !== pathOf(before.url) && URL_PATH.test(p)) return { confirmed: true, layer: 'url' };
  if (GENERIC_TEXT.test(text)) return { confirmed: true, layer: 'text' };
  return none;
}
