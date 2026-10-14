// src/scheduler/notify.ts
// Append-only JSONL notifier. Never throws. Detail is redacted before it is written and is never
// passed to the optional notify command (the title is its only argument).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Run } from '../platform/tmux.js';
import { redactPane } from '../platform/redact.js';

export interface Notice {
  level: 'info' | 'warn' | 'halt';
  title: string;
  detail?: string;
  runId?: string;
}
export interface Notifier {
  notify(n: Notice): Promise<void>;
}

const TITLE_MAX = 200;
const DETAIL_MAX = 1000;

export function fileNotifier(path: string, now: () => Date, runCmd?: Run, cmd?: string): Notifier {
  return {
    async notify(n) {
      let title = '';
      try {
        title = redactPane(String(n.title ?? '')).replace(/[\r\n]+/g, ' ').slice(0, TITLE_MAX);
        const rec: Record<string, unknown> = { ts: now().toISOString(), level: n.level, title };
        if (n.detail) rec.detail = redactPane(String(n.detail)).slice(0, DETAIL_MAX);
        if (n.runId) rec.run_id = n.runId;
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(rec) + '\n', { mode: 0o600 });
      } catch {
        // a notifier must never break the scheduler
      }
      if (runCmd && cmd && cmd.trim()) {
        try {
          await runCmd(cmd, [title || 'scheduler notice']);
        } catch {
          // ignore
        }
      }
    },
  };
}
