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
import { observeAts, observeLinkedin, observeNaukri, type NaukriRawSnapshot } from './fingerprint.js';
import type { FormModel } from '../webcore/formModel.js';
import { renderLayout } from './render.js';
import { emptyLayout, loadLayout, saveLayout, withLayoutLock } from './store.js';
import type { KindId, LandmarkId, LayoutFile, Observation, Platform, Recipe, Verdict } from './types.js';
import { PROJECT_ROOT } from './config.js';
import { ID_RE, RUN_ID_RE, actionLabelFor, actionLabelsFor, isAtsPlatform } from './vocab.js';
import { addEscalation } from '../outreach/service.js';
import { defaultRun } from '../platform/tmux.js';
import { fileNotifier, type Notice } from '../scheduler/notify.js';

export type LayoutEventName = ApplyResult['events'][number];
export interface LayoutEvent { platform: Platform; kind: KindId; event: LayoutEventName }

export interface LayoutObserver {
  observe(raw: RawSnapshot, block: BlockKind | null): Verdict;      // classify + learn + persist + events
  /** Naukri: the same pipeline from the already parsed snapshot; it never touches the page. */
  observeNaukri(raw: NaukriRawSnapshot, loginRequired: boolean): Verdict;
  /** Browser-applier ATS pages (platform `ats_<id>`): the same pipeline from a form model; ids only. */
  observeAts?(model: FormModel): Verdict;
  /** `landmarks` is the observation's own landmark set (what is on the page now). */
  last(): { kind: KindId; verdict: Verdict; landmarks?: LandmarkId[] } | null;
  recordOutcome(label: string, ok: boolean, action?: Recipe['action']): void;  // vocabulary label only
  render(): string;                                                // <= renderMaxChars
}

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
  return actionLabelFor(platform, text);
}

const safeId = (s: string): string => (ID_RE.test(s) ? s : 'other');

export function createLayoutObserver(d: {
  platform: Platform; cfg: LayoutConfig; now: () => Date; runId: string | null;
  db?: BetterSqlite3.Database; path?: string; onEvent?: (e: LayoutEvent) => void;
  /** Notification sink; defaults to the scheduler's .jobber/notify.jsonl notifier (and JOBBER_NOTIFY_CMD). */
  notify?: (n: Notice) => void | Promise<void>;
}): LayoutObserver & { observeAts(model: FormModel): Verdict } {
  const { platform, cfg } = d;
  const ats = isAtsPlatform(platform);
  const file = d.path ?? path.join(cfg.dir, `${platform}.json`);
  const labels = new Set<string>([...Object.values(actionLabelsFor(platform)), 'action:other']);
  let lastSeen: { kind: KindId; verdict: Verdict; landmarks: LandmarkId[] } | null = null;

  let defaultNotifier: ReturnType<typeof fileNotifier> | null = null;
  const send = (n: Notice): void => {
    try {
      let r: void | Promise<void>;
      if (d.notify) r = d.notify(n);
      else {
        defaultNotifier ??= fileNotifier(
          // default layout dir is <PROJECT_ROOT>/.jobber/layout, so this is .jobber/notify.jsonl
          path.join(cfg.dir ? path.dirname(cfg.dir) : path.join(PROJECT_ROOT, '.jobber'), 'notify.jsonl'), d.now, defaultRun, process.env.JOBBER_NOTIFY_CMD);
        r = defaultNotifier.notify(n);
      }
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => warn('notify', e));
    } catch (e) { warn('notify', e); }
  };

  // Side effects of drift events (fixed templates, vocabulary tokens only, no page text). Internal
  // state, so they record in dry-run too; never throws.
  function sideEffect(event: LayoutEventName, kind: KindId, streak: number, v: Verdict): void {
    try {
      const db = d.db;
      if (!db) return;
      if (v.class === 'blocked' || v.class === 'logged_out' || v.class === 'unloaded') return;
      const k = safeId(kind);
      // ATS pages escalate to the shared 'apply' queue and never halt anything (the apply tools refuse on drift themselves).
      const escPlatform = ats ? 'apply' : platform;
      const missing = ('missing' in v ? v.missing : []).filter((m) => ID_RE.test(m)).slice(0, 8);
      const tag = ats ? ` ats=${platform.slice(4)}` : '';
      const detail = `kind=${k}${tag} streak=${Math.max(0, Math.trunc(streak))} missing=${missing.join(',') || 'none'}`;
      const now = d.now();
      const run = d.runId ? { runId: d.runId } : {};
      if (event === 'drift_escalate') {
        addEscalation(db, { runId: d.runId, platform: escPlatform, reason: 'layout_drift', detail }, now);
        send({ level: 'warn', title: `layout drift on ${platform} (${k})`, ...run });
      } else if (event === 'drift_halt') {
        // Layout drift is telemetry and an owner escalation only, never a halt (block, captcha and
        // checkpoint halts are the only halts). drift_halt repeats while the streak stays past the
        // limit: record the escalation once while one is open for this kind.
        const open = db.prepare(
          `SELECT 1 FROM escalations WHERE platform = ? AND reason = 'layout_drift_halt'
             AND resolved_at IS NULL AND detail LIKE ? ESCAPE '\\' LIMIT 1`,
        ).get(escPlatform, `kind=${k.replace(/[\\%_]/g, '\\$&')}${tag} %`);
        if (open) return;
        addEscalation(db, { runId: d.runId, platform: escPlatform, reason: 'layout_drift_halt', detail: `${detail} mode=${ats ? 'ats' : cfg.enforce}` }, now);
        send({ level: 'warn', title: `layout drift on ${platform} (${k}) is persistent (telemetry only, ${cfg.enforce} mode, not halted)`, ...run });
      } else if (event === 'variant_replaced') {
        addEscalation(db, { runId: d.runId, platform: escPlatform, reason: 'layout_changed', detail }, now);
        send({ level: 'info', title: `layout changed on ${platform} (${k})`, ...run });
      }
    } catch (e) { warn('sideEffect', e); }
  }

  const load = (): LayoutFile => {
    const r = loadLayout(file, platform, d.now(), cfg.maxBytes);
    if (r.note) warn('load', r.note);
    return r.file;
  };

  // Shared tail: apply one observation under the file lock, remember it, forward its events.
  function commit(build: () => Observation): Verdict {
    try {
      const obs = build();
      let streak = 0;
      const res = withLayoutLock(file, () => {
        const out = applyObservation(load(), obs, { now: d.now(), runId: d.runId }, cfg);
        streak = out.file.kinds[obs.kind]?.drift_streak ?? 0;
        // Blocked, logged out and unloaded pages change nothing: skip the write.
        if (out.verdict.class !== 'blocked' && out.verdict.class !== 'logged_out' && out.verdict.class !== 'unloaded') {
          saveLayout(file, out.file, cfg.maxBytes, platform);
        }
        return out;
      });
      lastSeen = { kind: obs.kind, verdict: res.verdict, landmarks: obs.landmarks };
      for (const event of res.events) {
        sideEffect(event, obs.kind, streak, res.verdict);
        try { d.onEvent?.({ platform, kind: obs.kind, event }); } catch (e) { warn('onEvent', e); }
      }
      return res.verdict;
    } catch (e) {
      warn('observe', e);
      lastSeen = null;
      return UNKNOWN;
    }
  }

  const observe = (raw: RawSnapshot, block: BlockKind | null): Verdict =>
    platform !== 'linkedin' ? UNKNOWN
      : commit(() => observeLinkedin(raw, block, { unloadedMaxChars: cfg.unloadedMaxChars }));

  const observeNaukriSnapshot = (raw: NaukriRawSnapshot, loginRequired: boolean): Verdict =>
    platform !== 'naukri' ? UNKNOWN : commit(() => observeNaukri(raw, { loginRequired }));

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

  const observeAtsModel = (model: FormModel): Verdict =>
    !ats ? UNKNOWN : commit(() => observeAts(model, platform));

  return { observe, observeNaukri: observeNaukriSnapshot, observeAts: observeAtsModel, last: () => lastSeen, recordOutcome, render };
}
