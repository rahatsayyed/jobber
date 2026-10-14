// Shared dependencies and result helpers for the typed LinkedIn tools (Tasks 10 to 13).
import type BetterSqlite3 from 'better-sqlite3';
import type { StyleConfig } from '../safety/styleGate.js';
import type { LinkedinConfig } from './config.js';
import type { FactCheck } from './guard.js';
import type { Runtime } from './runtime.js';

export interface ToolDeps {
  rt: Runtime;
  db: BetterSqlite3.Database;
  now: () => Date;
  cfg: LinkedinConfig;
  env: NodeJS.ProcessEnv;
  factCheck: FactCheck;
  styleCfg: StyleConfig;
}

export type SendStatus =
  | 'sent' | 'dry_run' | 'already_sent' | 'refused' | 'rate_limited'
  | 'halted' | 'unconfirmed' | 'failed';
export interface TypedResult {
  status: SendStatus;
  code: string;
  reason?: string;
  touch_id?: number;
  would_send?: { kind: string; chars: number; recipient: string };
}

/** Build a non-sending result (refused, halted or failed) with no page text in `reason`. */
export function refusal(status: 'refused' | 'halted' | 'failed', code: string, reason?: string): TypedResult {
  return { status, code, ...(reason ? { reason } : {}) };
}
