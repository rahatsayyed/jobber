// Layout memory for browser-applier ATS pages (plan 8G-2 task 19). One observer per ats_<id> file; every
// page read the typed tools make is an observation (vocabulary ids only). Under LAYOUT_ENFORCE=enforce a
// drifted verdict makes apply_autofill and apply_submit refuse; under warn or off it is only recorded.
import type BetterSqlite3 from 'better-sqlite3';
import type { FormModel } from '../../webcore/formModel.js';
import type { LayoutConfig } from '../../layout/config.js';
import { createLayoutObserver } from '../../layout/runtime.js';
import type { Verdict } from '../../layout/types.js';
import { isAtsPlatform } from '../../layout/vocab.js';
import type { Notice } from '../../scheduler/notify.js';

export interface AtsLayoutGuard {
  /** Classifies and learns the page; null for a platform that has no layout memory (unknown host, bad id). */
  observe(platform: string, model: FormModel): Verdict | null;
  /** True when LAYOUT_ENFORCE=enforce. */
  enforce(): boolean;
}

const SKIP = new Set(['browser', 'none']);

export function createAtsLayoutGuard(d: {
  cfg: LayoutConfig; db?: BetterSqlite3.Database; now: () => Date; runId: string | null;
  notify?: (n: Notice) => void | Promise<void>;
}): AtsLayoutGuard {
  const observers = new Map<string, ReturnType<typeof createLayoutObserver>>();
  return {
    observe(platform, model) {
      const id = `ats_${platform}`;
      if (SKIP.has(platform) || !isAtsPlatform(id)) return null;
      let o = observers.get(id);
      if (!o) {
        o = createLayoutObserver({ platform: id, cfg: d.cfg, now: d.now, runId: d.runId, db: d.db, notify: d.notify });
        observers.set(id, o);
      }
      return o.observeAts(model);
    },
    enforce: () => d.cfg.enforce === 'enforce',
  };
}
