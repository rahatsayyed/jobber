// scripts/backup.ts
// Flags: --tick (scheduler hook), --now (owner triggered), --plan (list only), --status.
// Environment values (including .env) are used for config and the notifier only and never printed.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadBackupConfig, type BackupConfig } from '../src/backup/config.js';
import { createBackup, nodeCreateFs, packWithAge, type CreateResult } from '../src/backup/create.js';
import { LocalDirDestination, RcloneDestination, type BackupDestination } from '../src/backup/destination.js';
import {
  nodeStateFs, readBackupState, recordBackupResult, writeBackupState, type BackupState,
} from '../src/backup/state.js';
import { defaultExec } from '../src/lib/exec.js';
import { checkSnapshot, snapshotDb } from '../src/lib/sqliteSnapshot.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { parseEnv } from '../src/platform/envFile.js';
import { consoleNotifier, telegramNotifier, type Notifier } from '../src/platform/notify.js';
import { isDue, pickRunTime, type QuietWindow } from '../src/update/schedule.js';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const IST_OFFSET_MIN = 330;
const STALE_MS = 36 * 60 * 60 * 1000;

function mergedEnv(): NodeJS.ProcessEnv {
  let fromFile: Record<string, string> = {};
  try {
    const p = join(root, '.env');
    if (existsSync(p)) fromFile = parseEnv(readFileSync(p, 'utf8'));
  } catch {
    // unreadable .env: continue with the process environment
  }
  return { ...fromFile, ...process.env };
}

function quietWindow(env: NodeJS.ProcessEnv): QuietWindow {
  const c = loadOutreachConfig(env);
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 24;
  let startHour = ok(c.quietStartHour) ? c.quietStartHour : 1;
  let endHour = ok(c.quietEndHour) ? c.quietEndHour : 7;
  if (startHour === endHour) {
    startHour = 1;
    endHour = 7;
  }
  return { startHour, endHour, tzOffsetMinutes: IST_OFFSET_MIN };
}

function status(cfg: BackupConfig): number {
  const st = readBackupState(nodeStateFs, root);
  console.log(`enabled: ${cfg.enabled}`);
  console.log(`configured: ${cfg.configured}`);
  console.log(`destinations: ${cfg.dir ? 'local dir' : 'none'}${cfg.rcloneRemote ? ' + rclone' : ''}`);
  console.log(`include secrets: ${cfg.includeSecrets}`);
  console.log(`last backup: ${st.last_backup_at ?? 'never'}${st.last_backup_name ? ` (${st.last_backup_name})` : ''}`);
  console.log(`last error: ${st.last_error ?? 'none'}`);
  console.log(`last drill: ${st.last_drill_at ?? 'never'}`);
  console.log(`next run: ${st.next_run_at ?? 'unscheduled'}`);
  if (cfg.problems.length > 0) console.log(`config problems: ${cfg.problems.join('; ')}`);
  return 0;
}

function printPlan(r: CreateResult): void {
  const p = r.plan;
  if (!p) return;
  console.log('entries:');
  for (const e of p.entries) console.log(`  ${e.kind} ${e.path}: ${e.why}`);
  console.log(`files: ${p.files.length}`);
  console.log('excluded:');
  for (const x of p.excluded) console.log(`  ${x.path}: ${x.why}`);
}

async function main(): Promise<number> {
  const env = mergedEnv();
  const cfg = loadBackupConfig(env, root);
  if (args.has('--status')) return status(cfg);

  const tick = args.has('--tick');
  const plan = args.has('--plan');
  if (!tick && !args.has('--now') && !plan) {
    console.error('usage: backup (--tick | --now | --plan | --status)');
    return 2;
  }
  // the scheduler hook is a silent no-op unless the owner enabled backups
  if (tick && !plan && !cfg.enabled) return 0;

  const exec = defaultExec;
  const now = () => new Date();
  const quiet = quietWindow(env);
  const state = readBackupState(nodeStateFs, root);
  if (tick && !isDue(now(), state.next_run_at, quiet)) return 0;

  const destinations: BackupDestination[] = [];
  if (!plan && cfg.configured && cfg.problems.length === 0) {
    try {
      destinations.push(new LocalDirDestination(cfg.dir as string));
      if (cfg.rcloneRemote) destinations.push(new RcloneDestination(cfg.rcloneRemote, exec));
    } catch {
      destinations.length = 0;
    }
  }

  const result = await createBackup(
    {
      root, now, exec, fs: nodeCreateFs,
      snapshotDb: (dest) => snapshotDb(join(root, 'data.sqlite'), dest),
      checkSnapshot,
      pack: packWithAge(),
      destinations,
      commit: async () => {
        const r = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000 });
        const sha = r.stdout.trim();
        return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
      },
    },
    cfg,
    { planOnly: plan },
  );

  if (plan) {
    printPlan(result);
    return 0;
  }

  const at = now();
  // re-read right before writing so a concurrent restore --drill (last_drill_at) is not overwritten
  const next: BackupState = recordBackupResult(readBackupState(nodeStateFs, root), result, at);
  if (tick) next.next_run_at = pickRunTime(at, Math.random, quiet).toISOString();
  try {
    writeBackupState(nodeStateFs, root, next);
  } catch {
    console.error('backup: could not write state');
  }

  const baseNotifier = telegramNotifier(env);
  const notify: Notifier = {
    async send(text) {
      const r = await baseNotifier.send(text);
      if (r.ok) return r;
      await consoleNotifier.send(text);
      return r;
    },
  };
  const lastOk = next.last_backup_at ? Date.parse(next.last_backup_at) : NaN;
  const stale = Number.isFinite(lastOk) && at.getTime() - lastOk > STALE_MS;
  if (!result.ok || result.failed.length > 0 || stale) {
    const lines = ['Jobber backup problem', `reason: ${result.code ?? (stale ? 'stale' : 'unknown')}`];
    if (result.error) lines.push(result.error);
    for (const f of result.failed) lines.push(`${f.label}: ${f.error}`);
    if (stale) lines.push('last successful backup is older than 36 hours');
    await notify.send(lines.join('\n'));
  } else if (args.has('--now')) {
    await notify.send(`Jobber backup done: ${result.name} (${result.bytes} bytes, ${result.uploaded.join(', ')})`);
  }

  console.log(result.ok ? `backup: ok ${result.name}${result.failed.length ? ' (partial)' : ''}` : `backup: failed (${result.code})`);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error('backup: unexpected failure');
    process.exit(1);
  },
);
