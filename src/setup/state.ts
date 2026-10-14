// src/setup/state.ts
// Resumable wizard state: which steps are done plus non-secret answers. Never holds a secret.
import type { EnvFs } from './envWriter.js';

export interface SetupState {
  version: 1;
  steps: Record<string, { status: 'done' | 'skipped'; at: string }>;
  answers: Record<string, string | number | boolean>; // non-secret only
}

const SECRET_KEY_RE = /token|password|secret|key|cookie|client_secret|WEB_OIDC_CLIENT_SECRET/i;

export function emptyState(): SetupState {
  return { version: 1, steps: {}, answers: {} };
}

/** A missing, unreadable or malformed file gives an empty state (never throws). */
export function loadState(
  path: string,
  fs: { exists(p: string): boolean; read(p: string): string },
): SetupState {
  try {
    if (!fs.exists(path)) return emptyState();
    const raw: unknown = JSON.parse(fs.read(path));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyState();
    const o = raw as Record<string, unknown>;
    if (o.version !== 1) return emptyState();
    const state = emptyState();
    if (typeof o.steps === 'object' && o.steps !== null && !Array.isArray(o.steps)) {
      for (const [id, v] of Object.entries(o.steps as Record<string, unknown>)) {
        const s = v as { status?: unknown; at?: unknown } | null;
        if (s && (s.status === 'done' || s.status === 'skipped') && typeof s.at === 'string') {
          state.steps[id] = { status: s.status, at: s.at };
        }
      }
    }
    if (typeof o.answers === 'object' && o.answers !== null && !Array.isArray(o.answers)) {
      for (const [k, v] of Object.entries(o.answers as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k)) continue; // never trust a secret-named key from disk
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          state.answers[k] = v;
        }
      }
    }
    return state;
  } catch {
    return emptyState();
  }
}

/** Throws when an answers key looks like a secret. The message names the key, never a value. */
export function assertNoSecretKeys(answers: Record<string, unknown>): void {
  for (const k of Object.keys(answers)) {
    if (SECRET_KEY_RE.test(k)) {
      throw new Error(`refusing to store secret-looking answer key "${k}" in the setup state`);
    }
  }
}

/** Atomic (tmp + rename + chmod), mode 600, no backup. `now` is accepted for call-site symmetry. */
export function saveState(path: string, state: SetupState, fs: EnvFs, _now: () => Date): void {
  assertNoSecretKeys(state.answers);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    fs.write(tmp, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    fs.chmod(tmp, 0o600);
    fs.rename(tmp, path);
  } catch (e) {
    try {
      fs.remove?.(tmp);
    } catch {
      /* best effort */
    }
    throw new Error(`could not write setup state: ${(e as Error).message}`);
  }
  fs.chmod(path, 0o600);
}
