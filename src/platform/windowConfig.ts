// src/platform/windowConfig.ts
// Validation of the optional per-window fields of config/manager-windows.json (kind worker, role prompt, env allowlist,
// fixed markers, lane). Pure; used by loadManagerConfig. A window without these fields is unchanged (old behaviour).
import { validateWindowEnvSpec, type WindowEnvSpec } from './windowEnv.js';

export const WINDOW_KINDS = ['worker'] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];
export const WORKER_LAUNCHER = 'scripts/claude-window.sh';
const ROLE_PROMPT_RE = /^config\/windows\/[A-Za-z0-9_-]{1,64}\.md$/;
const LANE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface WindowFields extends WindowEnvSpec {
  kind?: WindowKind;
  /** Path under config/windows/ of the role prompt the startup line points at. */
  role_prompt?: string;
  /** Scheduler lane name this window serves (descriptive; also read by scripts/window-env.ts for the start-time records). */
  lane?: string;
  /** Per-window override of WINDOW_RECYCLE_HOURS (1..72). */
  recycle_hours?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const strArray = (name: string, field: string, v: unknown): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`manager config: ${name}.${field} must be a string array`);
  return v as string[];
};

/** Extracts and validates the optional worker fields of one window entry. Throws on the first problem. */
export function parseWindowFields(name: string, w: Record<string, unknown>): WindowFields {
  const out: WindowFields = {};
  if (w.kind !== undefined) {
    if (typeof w.kind !== 'string' || !(WINDOW_KINDS as readonly string[]).includes(w.kind)) {
      throw new Error(`manager config: ${name}.kind must be one of ${WINDOW_KINDS.join(', ')}`);
    }
    out.kind = w.kind as WindowKind;
  }
  if (w.role_prompt !== undefined) {
    if (typeof w.role_prompt !== 'string' || !ROLE_PROMPT_RE.test(w.role_prompt)) {
      throw new Error(`manager config: ${name}.role_prompt must be a file under config/windows/ (name.md)`);
    }
    out.role_prompt = w.role_prompt;
  }
  if (w.lane !== undefined) {
    if (typeof w.lane !== 'string' || !LANE_RE.test(w.lane)) throw new Error(`manager config: ${name}.lane must be a lane name`);
    out.lane = w.lane;
  }
  if (w.recycle_hours !== undefined) {
    if (typeof w.recycle_hours !== 'number' || !Number.isInteger(w.recycle_hours) || w.recycle_hours < 1 || w.recycle_hours > 72) {
      throw new Error(`manager config: ${name}.recycle_hours must be an integer 1..72`);
    }
    out.recycle_hours = w.recycle_hours;
  }
  if (w.env_keys !== undefined) out.env_keys = strArray(name, 'env_keys', w.env_keys);
  if (w.env_prefixes !== undefined) out.env_prefixes = strArray(name, 'env_prefixes', w.env_prefixes);
  if (w.env !== undefined) {
    if (!isObj(w.env)) throw new Error(`manager config: ${name}.env must be an object`);
    out.env = w.env as Record<string, string>;
  }
  const hasWorkerFields = out.role_prompt !== undefined || out.lane !== undefined || out.recycle_hours !== undefined || out.env_keys !== undefined || out.env_prefixes !== undefined || out.env !== undefined;
  if (hasWorkerFields && out.kind !== 'worker') throw new Error(`manager config: ${name} sets worker fields but kind is not worker`);
  if (out.kind === 'worker') validateWindowEnvSpec(name, out);
  return out;
}
