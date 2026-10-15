// Owner CLI for layout memory (plan 8B). Offline: no browser, no network.
//   npm run layout -- status
//   npm run layout -- show <platform>
//   npm run layout -- reset <platform> [--kind <id>] [--yes]
//   npm run layout -- clear-halt <platform> [--yes]
//   npm run layout -- learn <platform>
// Separate from scripts/linkedin-clear-halt.ts, which clears any LinkedIn halt.
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { loadLayoutConfig, loadLayoutEnv, type LayoutConfig } from '../src/layout/config.js';
import { renderLayout } from '../src/layout/render.js';
import { emptyLayout, saveLayout, withLayoutLock } from '../src/layout/store.js';
import {
  LAYOUT_HALT_PREFIX, layoutFilePath, layoutHaltReason, ownHaltReason, readLayoutFile, renderSummary, summarize,
} from '../src/layout/summary.js';
import type { Platform } from '../src/layout/types.js';
import { KINDS } from '../src/layout/vocab.js';
import { openDb } from '../src/db.js';
import { clearHalt } from '../src/outreach/limits.js';

export interface CliDeps {
  cfg: LayoutConfig;
  now: () => Date;
  db: () => BetterSqlite3.Database | null;
  prompt: (question: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  fs?: { exists(p: string): boolean; rename(from: string, to: string): void };
}

const PLATFORMS: readonly Platform[] = ['linkedin', 'naukri'];
const USAGE = [
  'usage: npm run layout -- <command>',
  '  status                                  summary for both platforms',
  '  show <platform>                         the memory as the operator sees it',
  '  reset <platform> [--kind <id>] [--yes]  move the file (or one kind) aside to *.reset-<time>',
  '  clear-halt <platform> [--yes]           clear a layout_drift halt only',
  '  learn <platform>                        learning-run instructions and promotion progress',
].join('\n');

const isPlatform = (s: string | undefined): s is Platform => PLATFORMS.includes(s as Platform);

async function confirm(d: CliDeps, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  return (await d.prompt(`${question} Type yes to continue: `)).trim() === 'yes';
}

function resetPath(file: string, now: Date, exists: (p: string) => boolean): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let dest = `${file}.reset-${stamp}`;
  for (let n = 1; exists(dest); n++) dest = `${file}.reset-${stamp}-${n}`;
  return dest;
}

export async function main(argv: string[], d: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const yes = rest.includes('--yes');
  const kindIdx = rest.indexOf('--kind');
  const kindArg = kindIdx >= 0 ? rest[kindIdx + 1] : undefined;
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(kindIdx >= 0 && i === kindIdx + 1));
  const fsx = d.fs ?? { exists: (p: string) => fs.existsSync(p), rename: (a: string, b: string) => fs.renameSync(a, b) };
  const now = d.now();

  if (cmd === 'status') {
    if (positional.length > 0) { d.err(USAGE); return 2; }
    const db = d.db();
    for (const p of PLATFORMS) d.out(renderSummary(summarize(p, d.cfg, now, db ?? undefined)));
    return 0;
  }

  if (cmd !== 'show' && cmd !== 'reset' && cmd !== 'clear-halt' && cmd !== 'learn') { d.err(USAGE); return 2; }
  const platform = positional[0];
  if (!isPlatform(platform) || positional.length !== 1) { d.err(USAGE); return 2; }
  const file = layoutFilePath(d.cfg, platform);

  if (cmd === 'show') {
    const r = readLayoutFile(platform, d.cfg);
    if (r.present && !r.data) { d.err(`layout memory invalid (${r.why ?? 'unknown'}); not shown`); return 1; }
    d.out(renderLayout(r.data, d.cfg.renderMaxChars));
    return 0;
  }

  if (cmd === 'learn') {
    d.out(`Learning run for ${platform} (no browser is started by this command):`);
    d.out('  1. Make sure the scheduler (or a supervised run) uses the normal operator, in dry-run or canary mode.');
    d.out('  2. Let the operator visit each kind through the typed tools; every page load is one observation.');
    d.out(`  3. A variant is promoted after ${d.cfg.promoteN} observations across ${d.cfg.promoteRuns} distinct runs.`);
    d.out('  4. Check progress with: npm run layout -- learn ' + platform + ' (this) or npm run layout -- status.');
    d.out('Promotion progress:');
    const r = readLayoutFile(platform, d.cfg);
    if (r.present && !r.data) { d.err(`layout memory invalid (${r.why ?? 'unknown'})`); return 1; }
    let any = false;
    for (const k of Object.keys(r.data?.kinds ?? {}).sort()) {
      for (const v of r.data!.kinds[k].variants) {
        if (v.promoted) continue;
        any = true;
        d.out(`  ${k} variant ${v.id}: obs ${v.obs}/${d.cfg.promoteN} runs ${v.runs}/${d.cfg.promoteRuns}`);
      }
    }
    if (!any) d.out('  no variant is learning right now');
    return 0;
  }

  if (cmd === 'reset') {
    if (kindArg !== undefined && !(KINDS[platform] as readonly string[]).includes(kindArg)) {
      d.err(`unknown kind for ${platform}: expected one of ${KINDS[platform].join(' ')}`);
      return 2;
    }
    if (kindIdx >= 0 && kindArg === undefined) { d.err(USAGE); return 2; }
    if (!fsx.exists(file)) { d.out(`no layout memory for ${platform}, nothing to reset`); return 1; }
    if (kindArg !== undefined) {
      const r = readLayoutFile(platform, d.cfg);
      if (!r.data) { d.err(`layout memory invalid (${r.why ?? 'unknown'}); reset the whole file instead`); return 1; }
      if (!r.data.kinds[kindArg]) { d.out(`kind ${kindArg} is not in the ${platform} layout memory`); return 1; }
    }
    const what = kindArg ? `kind ${kindArg} of ${platform} layout memory` : `the whole ${platform} layout memory`;
    if (!(await confirm(d, `Move ${what} aside?`, yes))) { d.out('aborted, nothing changed'); return 1; }
    const dest = resetPath(file, now, fsx.exists);
    try {
      withLayoutLock(file, () => {
        if (kindArg === undefined) {
          fsx.rename(file, dest);
          return;
        }
        const r = readLayoutFile(platform, d.cfg);
        if (!r.data || !r.data.kinds[kindArg]) throw new Error('layout memory changed, nothing moved');
        const moved = { ...emptyLayout(platform, now), kinds: { [kindArg]: r.data.kinds[kindArg] } };
        saveLayout(dest, moved, d.cfg.maxBytes, platform);
        const rest2 = { ...r.data, updated_at: now.toISOString(), kinds: { ...r.data.kinds } };
        delete rest2.kinds[kindArg];
        saveLayout(file, rest2, d.cfg.maxBytes, platform);
      });
    } catch (e) {
      d.err(`reset failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      return 1;
    }
    d.out(`moved ${what} to ${path.basename(dest)}`);
    return 0;
  }

  // clear-halt
  const db = d.db();
  if (!db) { d.err('no database available'); return 1; }
  const reason = layoutHaltReason(db, platform);
  if (reason === null) { d.out(`no active halt for ${platform}`); return 0; }
  if (!reason.startsWith(LAYOUT_HALT_PREFIX)) {
    d.err(`not a layout halt (reason: ${reason.slice(0, 80)}); refusing. Use npm run linkedin:clear-halt or npm run jobber:control for other halts.`);
    return 1;
  }
  // The platform's own row must carry the reason; an `all` halt is not ours to clear.
  const own = ownHaltReason(db, platform);
  if (own === null || !own.startsWith(LAYOUT_HALT_PREFIX)) {
    d.err(`the layout_drift reason comes from the global all halt, not a ${platform} halt; nothing cleared. Use npm run jobber:control -- resume.`);
    return 1;
  }
  if (!(await confirm(d, `Clear the ${platform} layout halt (${own})?`, yes))) { d.out('aborted, nothing changed'); return 1; }
  // Reset the streak of the kind that caused the halt first, so the next dead profile cannot re-halt at once.
  const haltKind = own.slice(LAYOUT_HALT_PREFIX.length);
  let streakNote = '';
  if ((KINDS[platform] as readonly string[]).includes(haltKind)) {
    try {
      withLayoutLock(file, () => {
        const r = readLayoutFile(platform, d.cfg);
        const km = r.data?.kinds[haltKind];
        if (!r.data || !km) return;
        km.drift_streak = 0;
        km.drift_window_start = null;
        km.drift_run_ids = [];
        r.data.updated_at = now.toISOString();
        saveLayout(file, r.data, d.cfg.maxBytes, platform);
        streakNote = ` Drift streak of kind ${haltKind} reset.`;
      });
    } catch (e) {
      streakNote = ` Streak reset failed (${e instanceof Error ? e.message.split('\n')[0] : 'error'}); run reset for the kind.`;
    }
  }
  clearHalt(db, platform, now);
  d.out(`cleared ${platform} layout halt.${streakNote} Drift totals are kept: reset the kind if the page has changed for good.`);
  return 0;
}

async function defaultDeps(): Promise<CliDeps> {
  // LAYOUT_* settings only, from .env when the process environment lacks them (shared helper).
  const env = loadLayoutEnv();
  let db: BetterSqlite3.Database | null | undefined;
  return {
    cfg: loadLayoutConfig(env),
    now: () => new Date(),
    db: () => {
      if (db !== undefined) return db;
      db = null;
      try {
        // Opened only when a command asks for it, so show/learn/reset never touch the database.
        const p = process.env.JOBAPPLIER_DB?.trim() || 'data.sqlite';
        if (p !== ':memory:' && fs.existsSync(p)) {
          db = openDb(p);
        }
      } catch { db = null; }
      return db;
    },
    prompt: (q) => new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (a) => { rl.close(); resolve(a); });
    }),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  defaultDeps()
    .then((d) => main(process.argv.slice(2), d))
    .then((c) => { process.exitCode = c; });
}
