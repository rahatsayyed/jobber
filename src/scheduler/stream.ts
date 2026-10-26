// src/scheduler/stream.ts
// Reads the `claude -p --output-format stream-json` log of a wake to decide whether the wake FINISHED.
// Pure: no fs, no clock. Found live (run 7d1744d06833e7d1): the session started two `contact-finder` subagents in the
// background (the Agent tool's `run_in_background` was unset), wrote "I'm waiting for both to return", ended its turn, and
// claude exited 0 and stopped the still-running subagents. The scheduler saw exit 0 and recorded `ok`.
//
// What the stream carries (claude 2.1.x): `system/init` has `session_id`; every Agent call emits `system/task_started`
// (tool_use_id, subagent_type, is_backgrounded) and, when the subagent ends, `system/task_notification`
// (tool_use_id, status: completed | failed | stopped ...); the final `result` event has the last assistant text.
import type { Step } from './plan.js';

/** A wake that ends `incomplete` is resumed at most this many times (one `claude --resume` run each). */
export const MAX_CONTINUATIONS = 2;

const MAX_LINE = 4_000_000;
const MAX_REPORT_TEXT = 200_000;

export interface TaskInfo { id: string; subagent: string; description: string; status: string | null; backgrounded: boolean }
export interface WakeReport { run_id: string; operators: Array<{ operator: string; platform?: string; kinds: string[] }> }

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

export class StreamInspector {
  sessionId: string | null = null;
  resultSeen = false;
  resultError = false;
  resultText: string | null = null;
  readonly tasks = new Map<string, TaskInfo>();
  private buf = '';
  private overflow = false;

  feed(chunk: string): void {
    const parts = chunk.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const terminated = i < parts.length - 1;
      if (!this.overflow) {
        if (this.buf.length + part.length > MAX_LINE) {
          this.buf = '';
          this.overflow = true;
        } else this.buf += part;
      }
      if (terminated) {
        if (!this.overflow) this.line(this.buf);
        this.buf = '';
        this.overflow = false;
      }
    }
  }

  /** Process an unterminated last line. */
  finish(): void {
    if (!this.overflow && this.buf) this.line(this.buf);
    this.buf = '';
  }

  private line(l: string): void {
    // Cheap prefilter: the log is large (progress and thinking events dominate).
    if (!(l.includes('"init"') || l.includes('"task_started"') || l.includes('"task_notification"') || l.includes('"type":"result"'))) return;
    let o: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(l);
      if (!v || typeof v !== 'object') return;
      o = v as Record<string, unknown>;
    } catch {
      return;
    }
    if (o.type === 'system') {
      if (o.subtype === 'init' && typeof o.session_id === 'string' && o.session_id) this.sessionId = o.session_id;
      else if (o.subtype === 'task_started' && typeof o.tool_use_id === 'string') {
        this.tasks.set(o.tool_use_id, {
          id: o.tool_use_id, subagent: clean(o.subagent_type, 60), description: clean(o.description, 80),
          status: null, backgrounded: o.is_backgrounded === true,
        });
      } else if (o.subtype === 'task_notification' && typeof o.tool_use_id === 'string') {
        const t = this.tasks.get(o.tool_use_id);
        const status = typeof o.status === 'string' ? o.status : 'unknown';
        if (t) t.status = status;
        else this.tasks.set(o.tool_use_id, { id: o.tool_use_id, subagent: '', description: '', status, backgrounded: false });
      }
    } else if (o.type === 'result') {
      this.resultSeen = true;
      this.resultError = o.is_error === true;
      this.resultText = typeof o.result === 'string' ? o.result.slice(0, MAX_REPORT_TEXT) : '';
      if (!this.sessionId && typeof o.session_id === 'string' && o.session_id) this.sessionId = o.session_id;
    }
  }

  /** Subagents that never reported back: still running when the session ended, or stopped with it. A `failed` one did report (an error). */
  pending(): TaskInfo[] {
    return [...this.tasks.values()].filter((t) => t.status === null || t.status === 'stopped' || t.status === 'killed');
  }

  completedCount(subagent: string): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.subagent === subagent && t.status === 'completed') n++;
    return n;
  }

  /** The wake's final JSON line `{run_id, operators: [...]}` from the result text (a code fence around it is fine); null when absent or for another run id. */
  report(runIds: string[]): WakeReport | null {
    const text = this.resultText;
    if (!text) return null;
    let found: WakeReport | null = null;
    for (const raw of text.split('\n')) {
      const s = raw.trim().replace(/^`+|`+$/g, '').trim();
      if (!s.startsWith('{') || !s.endsWith('}')) continue;
      try {
        const v = JSON.parse(s) as { run_id?: unknown; operators?: unknown };
        if (typeof v.run_id !== 'string' || !runIds.includes(v.run_id) || !Array.isArray(v.operators)) continue;
        const operators: WakeReport['operators'] = [];
        for (const op of v.operators as Array<Record<string, unknown>>) {
          if (!op || typeof op.operator !== 'string') continue;
          const kinds = Array.isArray(op.tasks)
            ? (op.tasks as Array<Record<string, unknown>>).map((t) => (t && typeof t.kind === 'string' ? t.kind : '')).filter(Boolean)
            : [];
          operators.push({ operator: op.operator, platform: typeof op.platform === 'string' ? op.platform : undefined, kinds });
        }
        found = { run_id: v.run_id, operators };
      } catch {
        // not the report line
      }
    }
    return found;
  }
}

export function describeStep(s: Step, index: number): string {
  return `${index + 1}. ${s.operator}${s.platform ? ` ${s.platform}` : ''} ${s.kind}`;
}

/**
 * Which steps of the wake the stream PROVES were done (conservative: unsure means unproven).
 * Code steps ran before the session. An operator step is proven by a completed Agent call to that operator or by the
 * final report listing it with that task kind; a chunked sending step (`chunks`) needs one completed call per chunk. The pipeline step has no operator of its own (it is many Agent calls), so
 * it is proven only by a final report with no subagent left pending.
 */
export function unprovenSteps(
  order: Step[],
  insp: StreamInspector,
  runIds: string[],
  already: Set<number>,
): { proven: Set<number>; unproven: number[] } {
  const proven = new Set(already);
  const report = insp.report(runIds);
  const noPending = insp.pending().length === 0;
  const used = new Map<string, number>();
  order.forEach((s, i) => {
    if (proven.has(i)) return;
    if (s.operator === 'code') {
      proven.add(i);
      return;
    }
    if (s.operator === 'pipeline') {
      if (report && noPending) proven.add(i);
      return;
    }
    const inReport = report?.operators.some(
      (o) => o.operator === s.operator && (!s.platform || !o.platform || o.platform === s.platform) && o.kinds.includes(s.kind),
    );
    if (inReport) {
      proven.add(i);
      return;
    }
    // A chunked step is several Agent calls; it counts only when every one of them returned.
    const spent = used.get(s.operator) ?? 0;
    const calls = s.chunks?.length ?? 1;
    if (spent + calls <= insp.completedCount(s.operator)) {
      used.set(s.operator, spent + calls);
      proven.add(i);
    }
  });
  const unproven: number[] = [];
  order.forEach((_s, i) => {
    if (!proven.has(i)) unproven.push(i);
  });
  return { proven, unproven };
}
