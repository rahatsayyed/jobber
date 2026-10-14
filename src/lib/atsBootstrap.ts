import { z } from 'zod';
import { runClaudeCli, extractJson, type FallbackDeps } from './domFallback.js';
import type { FieldMap } from '../ats/types.js';
import type { FormControlSnapshot } from './domSnapshot.js';

export const BOOTSTRAP_REQUIRED_FIELDS = ['name', 'email', 'resumeUpload', 'submitButton'] as const;
export const BOOTSTRAP_OPTIONAL_FIELDS = ['phone', 'coverLetter'] as const;

/**
 * Guaranteed to match no real element on any page — used to fill an optional FieldMap slot
 * Claude couldn't resolve, so external.ts's existing `page.$(selector)` optional-field checks
 * see a safe "not found" instead of an invalid/empty selector string.
 */
export const UNRESOLVED_OPTIONAL_SELECTOR = '[data-ats-bootstrap-unresolved="true"]';

const BootstrapResponseSchema = z.object({
  fieldMap: z.record(z.string(), z.string()).nullable(),
  missing: z.array(z.string()).optional(),
});

export type BootstrapResult = { fieldMap: FieldMap } | { missing: string[] };

function selectorsInSnapshot(snapshot: FormControlSnapshot): Set<string> {
  return new Set([
    ...snapshot.inputs.map((i) => i.selector),
    ...snapshot.buttons.map((b) => b.selector),
  ]);
}

/**
 * Given a live-page form-control snapshot, asks Claude to pick selectors for a FieldMap —
 * only from selectors actually present in the snapshot (never invent one; re-validated here
 * independently of the prompt's own "never invent" instruction). Returns the complete
 * FieldMap on success (with UNRESOLVED_OPTIONAL_SELECTOR filled in for any unresolved optional
 * field), or the list of unresolved REQUIRED fields on failure.
 */
export async function bootstrapFieldMap(
  snapshot: FormControlSnapshot,
  deps: FallbackDeps = {}
): Promise<BootstrapResult> {
  const invoke = deps.runClaude ?? ((command: string, input: unknown) => runClaudeCli(command, input, deps.model));

  const raw = await invoke('ats-bootstrap-fieldmap', {
    snapshot,
    requiredFields: BOOTSTRAP_REQUIRED_FIELDS,
    optionalFields: BOOTSTRAP_OPTIONAL_FIELDS,
  });
  if (!raw) return { missing: [...BOOTSTRAP_REQUIRED_FIELDS] };

  const parsed = extractJson(raw, BootstrapResponseSchema);
  if (!parsed) return { missing: [...BOOTSTRAP_REQUIRED_FIELDS] };
  if (!parsed.fieldMap) {
    return { missing: parsed.missing && parsed.missing.length > 0 ? parsed.missing : [...BOOTSTRAP_REQUIRED_FIELDS] };
  }

  const validSelectors = selectorsInSnapshot(snapshot);
  const missing: string[] = [];
  for (const field of BOOTSTRAP_REQUIRED_FIELDS) {
    const selector = parsed.fieldMap[field];
    if (!selector || !validSelectors.has(selector)) missing.push(field);
  }
  if (missing.length > 0) return { missing };

  const fieldMap: Record<string, string> = {};
  for (const field of BOOTSTRAP_REQUIRED_FIELDS) {
    fieldMap[field] = parsed.fieldMap[field];
  }
  for (const field of BOOTSTRAP_OPTIONAL_FIELDS) {
    const selector = parsed.fieldMap[field];
    fieldMap[field] = selector && validSelectors.has(selector) ? selector : UNRESOLVED_OPTIONAL_SELECTOR;
  }

  return { fieldMap: fieldMap as unknown as FieldMap };
}
