// src/stack/stale.ts
// Worker windows read their environment once, when their claude starts (scripts/window-env.ts records the values that matter in
// .jobber/window-start/<window>.json). `npm run up` leaves an already running window alone, so a window that started before a .env
// change keeps the old values. This module finds those windows (same comparison as the doctor check `window-foundation`) so `up`
// can restart the idle ones: after that the "running with old settings" warning is true only when a window is really stale and busy.
import { linkedinStartDiff } from '../scheduler/linkedinWindowStart.js';
import { mailDailyLimit } from '../scheduler/mailLimit.js';
import { wakeStartDiff, windowStartFile } from '../scheduler/wakeWindowStart.js';
import { LINKEDIN_WINDOW, WAKE_WINDOWS } from '../scheduler/wakeWindows.js';
import type { StackFs } from './up.js';

/** The recorded keys of window `name` that differ from `env` now. Empty when there is no record or it cannot be read. */
export function staleKeys(root: string, fs: StackFs, name: string, env: NodeJS.ProcessEnv): string[] {
  const file = windowStartFile(root, name);
  try {
    if (!fs.exists(file)) return [];
    const rec = JSON.parse(fs.read(file)) as Record<string, unknown>;
    if (name === 'mail') {
      const started = rec.SEND_LIMIT_PER_RUN;
      return typeof started === 'string' && started !== String(mailDailyLimit(env)) ? ['SEND_LIMIT_PER_RUN'] : [];
    }
    if (name === LINKEDIN_WINDOW) return linkedinStartDiff(rec, env);
    if ((WAKE_WINDOWS as readonly string[]).includes(name)) return wakeStartDiff(rec, env);
  } catch {
    // unreadable record: nothing to compare
  }
  return [];
}
