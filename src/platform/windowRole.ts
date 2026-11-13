// src/platform/windowRole.ts
// The role of a worker window survives /clear because scripts/claude-window.sh starts claude with the role file
// config/windows/<window>.md as an APPENDED SYSTEM PROMPT (`--append-system-prompt`), and /clear never drops the system prompt.
// This module holds the pieces that code and the launcher agree on: the role file path, a hash of (start version + role text) that is
// recorded in .jobber/window-start/<window>.json at start, and the check "is this running window older than the role it should have".
// Pure file reads; no tmux here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertName } from './tmux.js';

/**
 * Bump when the way a worker window is started changes in a way an old running window cannot have (for example the role prompt
 * was added). It is part of the hash, so every window started before the bump reads as stale.
 */
export const ROLE_START_VERSION = 1;

export const windowRoleFile = (root: string, window: string): string => {
  assertName(window);
  return path.join(root, 'config', 'windows', `${window}.md`);
};

/** The role text, or null when the file is missing (the window then starts without a role prompt). */
export function readWindowRole(root: string, window: string): string | null {
  try {
    const t = readFileSync(windowRoleFile(root, window), 'utf8');
    return t.trim() === '' ? null : t;
  } catch {
    return null;
  }
}

/** Short hash of the start version and the role text; null when there is no role file. */
export function roleHash(root: string, window: string): string | null {
  const t = readWindowRole(root, window);
  if (t === null) return null;
  return createHash('sha256').update(`v${ROLE_START_VERSION}\n${t}`).digest('hex').slice(0, 16);
}

/** The record of how a window was started (.jobber/window-start/<window>.json), or null. Only the role hash is read here. */
export function recordedRoleHash(root: string, window: string): string | null {
  try {
    const j = JSON.parse(readFileSync(path.join(root, '.jobber', 'window-start', `${window}.json`), 'utf8')) as { role_hash?: unknown };
    return typeof j.role_hash === 'string' ? j.role_hash : null;
  } catch {
    return null;
  }
}

/**
 * True when the window should be restarted to carry the current role: a role file exists and the recorded hash of the running
 * window is missing (started before this feature) or different (the role file or the start version changed since).
 */
export function roleIsStale(root: string, window: string): boolean {
  const now = roleHash(root, window);
  if (now === null) return false;
  return recordedRoleHash(root, window) !== now;
}
