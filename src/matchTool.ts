// file: src/matchTool.ts
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import { saveMatchResultsChecked } from './db.js';

/** Rows are validated one at a time in saveMatchResultsChecked / normalizeMatchRow, never here:
 *  a strict schema (or a missing job_id, or a null row) would reject the WHOLE call and stop the hunt. */
// The descriptions are field hints for the caller only; items stay z.unknown() so one bad row never fails the call (W2).
export const matchResultsInputShape = {
  results: z
    .array(
      z.unknown().describe(
        'One matcher row: {job_id: string, score: int 0-100, score_dims: {skills, seniority, domain, location: int 0-25 each}, reasons: string, ' +
          'missing_keywords: string[], requirements: [{req: string, category: skill|experience|education|location|language|other, ' +
          'importance: critical|high|meaningful|preferred|low_signal, evidence: stated|structural|inferred, jd_quote: verbatim posting text 12-300 chars for stated evidence, else null (only a verified stated quote can make a critical missing row a hard stop), ' +
          'match: strong|partial|missing}] (max 12 rows; critical/high always kept), strengths: string[1-3], gaps: string[1-3], deadline: "YYYY-MM-DD" | short text | null, ' +
          'location_verdict: PASS|FAIL|FLAG, language_gate: PASS|FAIL|FLAG, language_note: string}. Or an error row {job_id, error: string}, which is reported, never saved.',
      ),
    )
    .describe('Matcher rows, passed through unchanged from the matcher stage (expired rows {job_id, score: 0, reasons: "expired", missing_keywords: []} are valid rows).'),
};

export function handleSaveMatchResults(db: BetterSqlite3.Database, args: { results: unknown[] }) {
  const out = saveMatchResultsChecked(db, args.results as any);
  return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
}
