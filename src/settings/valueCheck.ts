// src/settings/valueCheck.ts
// Pure value validation and weakening semantics for env specs. No I/O.
// Reasons never echo the rejected value for secret specs.
import { normaliseEmail } from '../dash/account.js';
import { validatePairs } from '../setup/limitsCatalog.js';
import { isSecret, type EnvSpec } from './types.js';

const DEFAULT_MAX_LEN = 2000;
const PATH_MAX = 1024;

function show(spec: EnvSpec, v: string): string {
  return isSecret(spec) ? 'value' : `"${v.length > 60 ? v.slice(0, 60) + '...' : v}"`;
}

function intIn(spec: EnvSpec, raw: string): string | null {
  const t = raw.trim();
  if (t === '') return 'value is empty';
  if (!/^\d+$/.test(t)) return `${show(spec, t)} is not a whole number`;
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return 'number is too large';
  if (spec.min !== undefined && n < spec.min) return `${n} is below ${spec.min}`;
  if (spec.max !== undefined && n > spec.max) return `${n} is above ${spec.max}`;
  return null;
}

function listItems(spec: EnvSpec, raw: string): string | null {
  if (raw.trim() === '') return 'value is empty';
  const parts = raw.split(',');
  if (spec.itemCount !== undefined && parts.length !== spec.itemCount) {
    return `needs exactly ${spec.itemCount} comma-separated items`;
  }
  for (const p of parts) {
    if (spec.type === 'intList') {
      const r = intIn(spec, p);
      if (r) return r;
    } else if (p.trim() === '') {
      return 'list has an empty item';
    }
  }
  return null;
}

function singleLine(spec: EnvSpec, raw: string, max: number): string | null {
  if (/[\r\n]/.test(raw)) return 'value must be a single line';
  if (raw.includes('\0')) return 'value contains a NUL character';
  if (raw.length > max) return `value is longer than ${max} characters`;
  return null;
}

// null = ok, else the reason.
export function validateEnvValue(spec: EnvSpec, raw: string): string | null {
  if (typeof raw !== 'string') return 'value must be text';
  switch (spec.type) {
    case 'bool': {
      const ok = spec.allowed ?? ['true', 'false'];
      return ok.includes(raw) ? null : `must be one of: ${ok.join(', ')}`;
    }
    case 'int':
      return intIn(spec, raw);
    case 'enum':
      if (!spec.allowed) return 'enum spec has no allowed values';
      return spec.allowed.includes(raw) ? null : `must be one of: ${spec.allowed.join(', ')}`;
    case 'list':
    case 'intList':
      return listItems(spec, raw);
    case 'url': {
      if (/[\r\n\0]/.test(raw)) return 'value must be a single line';
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return 'not a valid URL';
      }
      if (u.username || u.password) return 'URL must not contain credentials';
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if (u.protocol === 'https:') return null;
      if (u.protocol === 'http:' && loopback) return null;
      return 'URL must be https (http only for loopback)';
    }
    case 'email':
      if (/[\r\n]/.test(raw)) return 'value must be a single line';
      return normaliseEmail(raw) === null ? 'not a valid email address' : null;
    case 'path':
      return singleLine(spec, raw, PATH_MAX);
    case 'string':
    case 'secret':
      return singleLine(spec, raw, spec.maxLen ?? DEFAULT_MAX_LEN);
    default:
      return 'unknown type';
  }
}

// Cross-key checks (min/max pairs). Only keys present in the catalog are considered.
export function validateCross(values: Record<string, string>, catalog: readonly EnvSpec[]): string[] {
  const known = new Set(catalog.map((s) => s.key));
  const scoped: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (known.has(k)) scoped[k] = v;
  return validatePairs(scoped);
}

const isLive = (v: string | undefined): boolean => v !== undefined && ['true', '1'].includes(v.trim().toLowerCase());

// True when the change from `before` to `after` loosens a safety control, per spec.weakens.
// A missing/blank value counts as the spec default.
export function weakens(spec: EnvSpec, before: string | null | undefined, after: string | null | undefined): boolean {
  const eff = (v: string | null | undefined): string | undefined => {
    const t = v === null || v === undefined ? '' : v.trim();
    return t === '' ? (spec.default ?? undefined) : t;
  };
  const b = eff(before);
  const a = eff(after);
  switch (spec.weakens) {
    case null:
      return false;
    case 'true':
      return isLive(a) && !isLive(b);
    case 'false':
      return isLive(b) && !isLive(a);
    case 'increase':
    case 'decrease': {
      if (a === undefined || b === undefined) return false;
      const x = Number(a);
      const y = Number(b);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return spec.weakens === 'increase' ? x > y : x < y;
    }
    case 'cleared': {
      const nb = before === null || before === undefined ? '' : before.trim();
      const na = after === null || after === undefined ? '' : after.trim();
      return nb !== '' && na === '';
    }
    case 'any': {
      const nb = before === null || before === undefined ? '' : before;
      const na = after === null || after === undefined ? '' : after;
      return nb !== na;
    }
    default:
      return false;
  }
}
