// src/scheduler/windowTick.ts
// The window upkeep tick of the scheduler daemon (zero LLM calls):
//  1. handoff reminders: every HANDOFF_REMIND_EVERY_MIN, entries of `.jobber/handoff.md` that are open for more than
//     30 minutes go into ONE Telegram notice to the `alerts` topic (grouped by window), at most once per entry per
//     interval; an idle worker window with due entries also gets one short reminder line typed in (same guarded path as
//     the manager `send`). Reminder state: `.jobber/handoff-remind.json` (entry id -> last reminded ISO time).
//  2. recycle: `manager` and every worker window are restarted when old AND idle (recycleWindow), one `alerts` line each.
// Never throws. Nothing runs while the kill switch is on; reminders also wait out quiet hours.
// Handoff text may come from model output: it is sanitised and shortened here, and the notifier escapes it for HTML.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listHandoff, type HandoffEntry } from '../platform/handoff.js';
import { formatAge, loadManagerConfig, recycleWindow, type ManagerConfig } from '../platform/manager.js';
import { sendToWindow } from '../platform/managerTyping.js';
import type { Run } from '../platform/tmux.js';

export const HANDOFF_MIN_AGE_MS = 30 * 60_000;
const NOTICE_LINE_MAX = 110;
const NOTICE_LINES = 12;
const CHECK_EVERY_MS = 60_000;

/** HANDOFF_REMIND_EVERY_MIN: integer 15..1440, default 120; blank, invalid or out of range gives the default. */
export function handoffRemindEveryMin(env: NodeJS.ProcessEnv): number {
  const raw = (env.HANDOFF_REMIND_EVERY_MIN ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 15 && n <= 1440 ? n : 120;
}

export const remindStateFile = (root: string): string => path.join(root, '.jobber', 'handoff-remind.json');

export function readRemindState(root: string): Record<string, string> {
  try {
    const j = JSON.parse(readFileSync(remindStateFile(root), 'utf8')) as unknown;
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeRemindState(root: string, state: Record<string, string>): void {
  const p = remindStateFile(root);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

/** Open entries older than 30 minutes that were not reminded within the interval. Pure. */
export function dueEntries(entries: HandoffEntry[], state: Record<string, string>, now: number, everyMin: number): HandoffEntry[] {
  return entries.filter((e) => {
    const since = Date.parse(e.since);
    if (!Number.isFinite(since) || now - since < HANDOFF_MIN_AGE_MS) return false;
    const last = Date.parse(state[e.id] ?? '');
    return !Number.isFinite(last) || now - last >= everyMin * 60_000;
  });
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** ONE notice for all due entries, grouped by window. */
export function composeReminder(due: HandoffEntry[], now: number): string {
  const byWindow = new Map<string, HandoffEntry[]>();
  for (const e of due) byWindow.set(e.window, [...(byWindow.get(e.window) ?? []), e]);
  const lines = [`Handoff: ${due.length} pending item${due.length === 1 ? '' : 's'} need attention`];
  let shown = 0;
  for (const [win, list] of byWindow) {
    if (shown >= NOTICE_LINES) break;
    lines.push(`${win}:`);
    for (const e of list) {
      if (shown >= NOTICE_LINES) break;
      const age = formatAge(Math.max(0, now - Date.parse(e.since)));
      lines.push(`- ${short(`${e.what} (${e.why})`, NOTICE_LINE_MAX)} [${e.id}, ${age}]`);
      shown++;
    }
  }
  if (due.length > shown) lines.push(`... and ${due.length - shown} more`);
  lines.push('List: npx tsx scripts/handoff.ts list');
  return lines.join('\n');
}

export interface WindowTickDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  /** Loads the manager config on every check (so an edit is picked up); null when unreadable. */
  config: () => ManagerConfig | null;
  killed: () => boolean;
  inQuiet: () => boolean;
  /** Sends one text to the `alerts` topic. */
  alert: (text: string) => Promise<{ ok: boolean }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One check: reminders, then recycle. Returns short facts for tests and logs. */
export async function windowUpkeep(d: WindowTickDeps): Promise<{ reminded: string[]; typed: string[]; recycled: string[] }> {
  const out = { reminded: [] as string[], typed: [] as string[], recycled: [] as string[] };
  if (d.killed()) return out;
  const cfg = d.config();
  if (!cfg) return out;
  const now = (d.now ?? Date.now)();
  const quiet = d.inQuiet();

  // 1. Reminders.
  if (!quiet) {
    const entries = listHandoff(d.root);
    const state = readRemindState(d.root);
    const due = dueEntries(entries, state, now, handoffRemindEveryMin(d.env));
    if (due.length > 0) {
      const sent = await d.alert(composeReminder(due, now));
      if (sent.ok) {
        const next: Record<string, string> = {};
        for (const e of entries) if (state[e.id]) next[e.id] = state[e.id];
        for (const e of due) next[e.id] = new Date(now).toISOString();
        writeRemindState(d.root, next);
        out.reminded = due.map((e) => e.id);
        const wins = [...new Set(due.map((e) => e.window))];
        for (const w of wins) {
          if (cfg.windows[w]?.kind !== 'worker') continue;
          const n = due.filter((e) => e.window === w).length;
          try {
            await sendToWindow(d.run, cfg, d.env, w, `Reminder: ${n} pending handoff item${n === 1 ? '' : 's'} for window ${w}, see .jobber/handoff.md`, { root: d.root, killed: d.killed });
            out.typed.push(w);
          } catch {
            // busy, missing or not a claude pane: the Telegram notice already went out
          }
        }
      }
    }
  }

  // 2. Recycle (manager first, then the worker windows). A recycle is not an outbound action, so quiet hours do not stop it.
  const names = ['manager', ...Object.keys(cfg.windows).filter((n) => cfg.windows[n].kind === 'worker')];
  for (const name of names) {
    try {
      const r = await recycleWindow(d.run, cfg, d.env, name, { root: d.root, killed: d.killed, now: d.now, startup: d.sleep ? { sleep: d.sleep } : undefined });
      if (r.status === 'recycled') {
        out.recycled.push(name);
        await d.alert(`recycled window ${name} (${formatAge(r.ageMs)})${r.startup === 'typed' ? '' : `, startup line ${r.startup}`}`);
      }
    } catch {
      // a failing window never stops the others
    }
  }
  return out;
}

/** The daemon's tick (called about every 30 seconds): runs the upkeep at most once a minute. Never throws. */
export function windowTick(d: WindowTickDeps): () => Promise<void> {
  let last = 0;
  return async () => {
    const now = (d.now ?? Date.now)();
    if (now - last < CHECK_EVERY_MS) return;
    last = now;
    try {
      await windowUpkeep(d);
    } catch {
      // the upkeep is a convenience: a failure must never stop the scheduler
    }
  };
}

/** Reads the manager config from a project root; null when missing or invalid. */
export function configReader(root: string): () => ManagerConfig | null {
  return () => {
    try {
      return loadManagerConfig(readFileSync(path.join(root, 'config', 'manager-windows.json'), 'utf8'));
    } catch {
      return null;
    }
  };
}
