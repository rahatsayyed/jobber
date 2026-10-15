// Layout observer (plan 8B): classify each fresh snapshot against stored layout memory, learn from
// consistent observations, persist, and forward events. It is advisory: every failure is swallowed
// to stderr and never reaches a tool result. One writer per platform file: each observation is a
// synchronous load -> apply -> save inside withLayoutLock.
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { BlockKind } from '../linkedin/state.js';
import type { RawSnapshot } from '../linkedin/types.js';
import type { LayoutConfig } from './config.js';
import { applyObservation, type ApplyResult } from './classify.js';
import { observeLinkedin } from './fingerprint.js';
import { renderLayout } from './render.js';
import { emptyLayout, loadLayout, saveLayout, withLayoutLock } from './store.js';
import type { KindId, LandmarkId, LayoutFile, Platform, Recipe, Verdict } from './types.js';
import { ACTION_LABELS } from './vocab.js';

export type LayoutEventName = ApplyResult['events'][number];
export interface LayoutEvent { platform: Platform; kind: KindId; event: LayoutEventName }

export interface LayoutObserver {
  observe(raw: RawSnapshot, block: BlockKind | null): Verdict;      // classify + learn + persist + events
  /** `landmarks` is the observation's own landmark set (what is on the page now). */
  last(): { kind: KindId; verdict: Verdict; landmarks?: LandmarkId[] } | null;
  recordOutcome(label: string, ok: boolean, action?: Recipe['action']): void;  // vocabulary label only
  render(): string;                                                // <= renderMaxChars
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_RECIPES = 24;
const MAX_COUNT = 1_000_000;
const PROCESS_START = Date.now();
const UNKNOWN: Verdict = { class: 'unknown', score: 0, missing: [], variant: null };

const warn = (where: string, e: unknown) =>
  console.error(`[layout] ${where}: ${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 160)}`);

/**
 * Run id for distinct-run counting: JOBBER_RUN_ID, else SCHEDULER_RUN_ID, when it matches
 * ^[A-Za-z0-9_-]{1,40}$; otherwise a per-process id `p<pid>-<base36 start time>` (at most 40 chars),
 * so one server process counts as one run.
 */
export function resolveRunId(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid, start: number = PROCESS_START): string {
  for (const k of ['JOBBER_RUN_ID', 'SCHEDULER_RUN_ID']) {
    const v = env[k]?.trim();
    if (v && RUN_ID_RE.test(v)) return v;
  }
  return `p${pid}-${start.toString(36)}`.slice(0, 40);
}

/** Vocabulary id of a clicked label; anything outside the vocabulary is `action:other`. */
export function actionLabelId(platform: Platform, text: string): string {
  return ACTION_LABELS[platform]?.[text.replace(/\s+/g, ' ').trim().toLowerCase()] ?? 'action:other';
}

export function createLayoutObserver(d: {
  platform: Platform; cfg: LayoutConfig; now: () => Date; runId: string | null;
  db?: BetterSqlite3.Database; path?: string; onEvent?: (e: LayoutEvent) => void;
}): LayoutObserver {
  const { platform, cfg } = d;
  const file = d.path ?? path.join(cfg.dir, `${platform}.json`);
  const labels = new Set<string>([...Object.values(ACTION_LABELS[platform] ?? {}), 'action:other']);
  let lastSeen: { kind: KindId; verdict: Verdict; landmarks: LandmarkId[] } | null = null;

  const load = (): LayoutFile => {
    const r = loadLayout(file, platform, d.now(), cfg.maxBytes);
    if (r.note) warn('load', r.note);
    return r.file;
  };

  function observe(raw: RawSnapshot, block: BlockKind | null): Verdict {
    if (platform !== 'linkedin') return UNKNOWN;
    try {
      const obs = observeLinkedin(raw, block, { unloadedMaxChars: cfg.unloadedMaxChars });
      const res = withLayoutLock(file, () => {
        const out = applyObservation(load(), obs, { now: d.now(), runId: d.runId }, cfg);
        // Blocked, logged out and unloaded pages change nothing: skip the write.
        if (out.verdict.class !== 'blocked' && out.verdict.class !== 'logged_out' && out.verdict.class !== 'unloaded') {
          saveLayout(file, out.file, cfg.maxBytes, platform);
        }
        return out;
      });
      lastSeen = { kind: obs.kind, verdict: res.verdict, landmarks: obs.landmarks };
      for (const event of res.events) {
        try { d.onEvent?.({ platform, kind: obs.kind, event }); } catch (e) { warn('onEvent', e); }
      }
      return res.verdict;
    } catch (e) {
      warn('observe', e);
      lastSeen = null;
      return UNKNOWN;
    }
  }

  function recordOutcome(label: string, ok: boolean, action: Recipe['action'] = 'click'): void {
    try {
      const seen = lastSeen;
      if (!seen) return;
      const v = seen.verdict;
      // Only a page that matched (or partly matched) a promoted variant carries outcomes.
      if ((v.class !== 'match' && v.class !== 'partial') || !v.variant) return;
      const id = labels.has(label) ? label : 'action:other';
      const now = d.now().toISOString();
      withLayoutLock(file, () => {
        const f = load();
        const variant = f.kinds[seen.kind]?.variants.find((x) => x.id === v.variant);
        if (!variant || !variant.promoted) return;
        let r = variant.recipes.find((x) => x.action === action && x.label === id);
        // Recipes are created only from a successful outcome on a page that was a full match.
        if (!r && ok && v.class === 'match' && variant.recipes.length < MAX_RECIPES) {
          r = { action, label: id, how: 'text', v: 1, ok: 0, fail: 0, last_ok: null };
          variant.recipes.push(r);
        }
        if (ok) {
          variant.ok = Math.min(variant.ok + 1, MAX_COUNT);
          if (r) { r.ok = Math.min(r.ok + 1, MAX_COUNT); r.last_ok = now; }
        } else {
          variant.fail = Math.min(variant.fail + 1, MAX_COUNT);
          if (r) r.fail = Math.min(r.fail + 1, MAX_COUNT);
        }
        f.updated_at = now;
        saveLayout(file, f, cfg.maxBytes, platform);
      });
    } catch (e) {
      warn('recordOutcome', e);
    }
  }

  function render(): string {
    try {
      return renderLayout(load(), cfg.renderMaxChars);
    } catch (e) {
      warn('render', e);
      return renderLayout(emptyLayout(platform, d.now()), cfg.renderMaxChars);
    }
  }

  return { observe, last: () => lastSeen, recordOutcome, render };
}
