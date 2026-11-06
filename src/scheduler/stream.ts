// src/scheduler/stream.ts
// Reads the final JSON report line of one window item (the last assistant text of the turn, see windowDispatch.ts) to decide whether the
// steps of the item FINISHED. Pure: no fs, no clock. (The stream-json log inspector of the old headless wake is gone.)
import type { Step } from './plan.js';

const MAX_REPORT_TEXT = 200_000;

export interface WakeCounts { done: number; skipped: number; escalated: number; stopped: number }
/** `counts` are sums over every task of the final JSON line. */
export interface WakeReport { run_id: string; operators: Array<{ operator: string; platform?: string; kinds: string[] }>; counts: WakeCounts }

const countOf = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.min(Math.floor(x), 100000) : x === true ? 1 : 0);

export function describeStep(s: Step, index: number): string {
  return `${index + 1}. ${s.operator}${s.platform ? ` ${s.platform}` : ''} ${s.kind}`;
}

/**
 * Which steps of an item the report PROVES were done (conservative: unsure means unproven). An operator step is proven by the final report
 * listing that operator with that task kind; the pipeline step has no operator of its own (it is many Agent calls), so it is proven by the
 * presence of the final report. Code steps ran before the item.
 */
export function unprovenSteps(order: Step[], report: WakeReport | null): { proven: Set<number>; unproven: number[] } {
  const proven = new Set<number>();
  order.forEach((s, i) => {
    if (s.operator === 'code') {
      proven.add(i);
      return;
    }
    if (s.operator === 'pipeline') {
      if (report) proven.add(i);
      return;
    }
    const inReport = report?.operators.some(
      (o) => o.operator === s.operator && (!s.platform || !o.platform || o.platform === s.platform) && o.kinds.includes(s.kind),
    );
    if (inReport) proven.add(i);
  });
  const unproven: number[] = [];
  order.forEach((_s, i) => {
    if (!proven.has(i)) unproven.push(i);
  });
  return { proven, unproven };
}

/** The final JSON line `{run_id, operators: [...]}` of a plain text (a code fence around it is fine); null when absent or for another run id. */
export function reportFromText(text: string | null, runIds: string[]): WakeReport | null {
  if (!text) return null;
  let found: WakeReport | null = null;
  for (const raw of text.slice(0, MAX_REPORT_TEXT).split('\n')) {
    const s = raw.trim().replace(/^`+|`+$/g, '').trim();
    if (!s.startsWith('{') || !s.endsWith('}')) continue;
    try {
      const v = JSON.parse(s) as { run_id?: unknown; operators?: unknown };
      if (typeof v.run_id !== 'string' || !runIds.includes(v.run_id) || !Array.isArray(v.operators)) continue;
      const operators: WakeReport['operators'] = [];
      const counts: WakeCounts = { done: 0, skipped: 0, escalated: 0, stopped: 0 };
      for (const op of v.operators as Array<Record<string, unknown>>) {
        if (!op || typeof op.operator !== 'string') continue;
        const kinds = Array.isArray(op.tasks)
          ? (op.tasks as Array<Record<string, unknown>>).map((t) => (t && typeof t.kind === 'string' ? t.kind : '')).filter(Boolean)
          : [];
        operators.push({ operator: op.operator, platform: typeof op.platform === 'string' ? op.platform : undefined, kinds });
        if (Array.isArray(op.tasks)) {
          for (const t of op.tasks as Array<Record<string, unknown>>) {
            if (!t) continue;
            counts.done += countOf(t.done);
            counts.skipped += countOf(t.skipped);
            counts.escalated += countOf(t.escalated);
            counts.stopped += countOf(t.stopped);
          }
        }
      }
      found = { run_id: v.run_id, operators, counts };
    } catch {
      // not the report line
    }
  }
  return found;
}
