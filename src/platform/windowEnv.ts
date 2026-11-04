// src/platform/windowEnv.ts
// The environment of a long-lived worker window (scripts/claude-window.sh). Unlike claude-session.sh (the whole .env),
// a worker window gets an ALLOWLIST: a safe base, the dry-run flag and kill switch, the keys its config lists, keys
// that match its listed prefixes (secret-looking ones skipped), and fixed markers. Same scrub idea as buildEnv in
// runner.ts (SECRET_KEY_RE, always-dropped keys). Nothing here prints a value.
import { isDroppedKey, SAFE_BASE_KEYS, SECRET_KEY_RE } from './runner.js';

export const WINDOW_BASE_KEYS = [...SAFE_BASE_KEYS, 'TERM', 'COLORTERM'];
/** Always passed from the process or .env when set: the dry-run flag and the kill switch must reach every window. */
export const WINDOW_PASSTHROUGH = ['JOBBER_DRY_RUN', 'JOBBER_KILL'];
/** Name prefixes a window config may never list, set as a marker or match with a prefix. */
export const FORBIDDEN_PREFIXES = ['JOBBER_', 'SCHEDULER_', 'TELEGRAM_', 'CLAUDE_CODE_', 'ANTHROPIC_'];
/** The one JOBBER_ marker a window config may set. */
export const ALLOWED_JOBBER_MARKER = 'JOBBER_RUN_LANE';
const NEVER_KEYS = new Set(['ALLOWED_USERS', 'IS_SANDBOX', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);

const KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const PREFIX_RE = /^[A-Z][A-Z0-9_]{2,62}_$/;
const MARKER_VALUE_RE = /^[A-Za-z0-9_.:,@=+/-]{0,200}$/;
const LANE_VALUE_RE = /^[a-z][a-z0-9_]{0,31}$/;

export interface WindowEnvSpec {
  env_keys?: string[];
  env_prefixes?: string[];
  /** Fixed markers set last (validated). */
  env?: Record<string, string>;
}

const forbiddenPrefix = (k: string): boolean => FORBIDDEN_PREFIXES.some((p) => k.startsWith(p));

/** Throws on the first problem; the messages never echo values. */
export function validateWindowEnvSpec(name: string, spec: WindowEnvSpec): void {
  const where = `window ${name}`;
  if (spec.env_keys !== undefined) {
    if (!Array.isArray(spec.env_keys)) throw new Error(`${where}: env_keys must be an array`);
    for (const k of spec.env_keys) {
      if (typeof k !== 'string' || !KEY_RE.test(k)) throw new Error(`${where}: env_keys entry is not a plain KEY name`);
      if (forbiddenPrefix(k) || NEVER_KEYS.has(k) || isDroppedKey(k)) throw new Error(`${where}: env_keys may not list ${k}`);
    }
  }
  if (spec.env_prefixes !== undefined) {
    if (!Array.isArray(spec.env_prefixes)) throw new Error(`${where}: env_prefixes must be an array`);
    for (const p of spec.env_prefixes) {
      if (typeof p !== 'string' || !PREFIX_RE.test(p)) throw new Error(`${where}: env_prefixes entry must look like NAME_ (3+ characters, ends with _)`);
      if (FORBIDDEN_PREFIXES.some((f) => f.startsWith(p) || p.startsWith(f))) throw new Error(`${where}: env_prefixes may not cover ${p}`);
    }
  }
  if (spec.env !== undefined) {
    if (spec.env === null || typeof spec.env !== 'object' || Array.isArray(spec.env)) throw new Error(`${where}: env must be an object`);
    for (const [k, v] of Object.entries(spec.env)) {
      if (!KEY_RE.test(k)) throw new Error(`${where}: env marker name is not a plain KEY name`);
      if (typeof v !== 'string' || !MARKER_VALUE_RE.test(v)) throw new Error(`${where}: env marker ${k} has an invalid value`);
      if (k.startsWith('JOBBER_') || k.startsWith('SCHEDULER_')) {
        if (k !== ALLOWED_JOBBER_MARKER) throw new Error(`${where}: env marker ${k} is refused (only ${ALLOWED_JOBBER_MARKER} is allowed)`);
        if (!LANE_VALUE_RE.test(v)) throw new Error(`${where}: ${ALLOWED_JOBBER_MARKER} must be a lane name`);
        continue;
      }
      if (forbiddenPrefix(k) || NEVER_KEYS.has(k) || isDroppedKey(k) || SECRET_KEY_RE.test(k)) {
        throw new Error(`${where}: env marker ${k} is refused`);
      }
    }
  }
}

const printable = (v: string): boolean => !/[\0\r\n]/.test(v);

/**
 * The environment for one window. `base` is the process env, `dotenv` the parsed .env (it wins, like claude-session.sh).
 * The spec is validated again here, so a hand-built spec cannot smuggle a key past the config loader.
 */
export function buildWindowEnv(
  name: string,
  spec: WindowEnvSpec,
  base: Record<string, string | undefined>,
  dotenv: Record<string, string> = {},
): Record<string, string> {
  validateWindowEnvSpec(name, spec);
  const out: Record<string, string> = {};
  for (const k of WINDOW_BASE_KEYS) if (base[k] !== undefined && printable(base[k] as string)) out[k] = base[k] as string;
  const src: Record<string, string | undefined> = { ...base, ...dotenv };
  for (const k of WINDOW_PASSTHROUGH) if (src[k] !== undefined && printable(src[k] as string)) out[k] = src[k] as string;
  const keys = spec.env_keys ?? [];
  const prefixes = spec.env_prefixes ?? [];
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || !printable(v) || !KEY_RE.test(k)) continue;
    const listed = keys.includes(k);
    if (!listed && !prefixes.some((p) => k.startsWith(p))) continue;
    if (!listed && SECRET_KEY_RE.test(k)) continue; // a prefix never pulls in a secret; only an explicit key does
    out[k] = v;
  }
  for (const k of Object.keys(out)) {
    if (isDroppedKey(k) || NEVER_KEYS.has(k) || (forbiddenPrefix(k) && !WINDOW_PASSTHROUGH.includes(k))) delete out[k];
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) out[k] = v;
  return out;
}

/** `KEY=value` lines, one per entry, sorted; what `env -i` receives. */
export function windowEnvLines(env: Record<string, string>): string[] {
  return Object.keys(env).sort().map((k) => `${k}=${env[k]}`);
}
