// src/platform/updateBackupChecks.ts
// Doctor checks for auto-update, permission opt-in and backup (plan 7D). Registered in scripts/doctor.ts.
// No check here prints an env value, a recipient, key material, a database row or file contents.
import { isAbsolute, join, relative } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { parseEnv } from './envFile.js';
import { loadUpdateConfig } from '../update/config.js';
import { readStateChecked, STATE_PATH, type StateFs } from '../update/state.js';
import { loadBackupConfig } from '../backup/config.js';
import { readBackupStateChecked } from '../backup/state.js';
import { BACKUP_NAME_RE } from '../backup/retention.js';
import { detectSet, resolveSet, SET_NAMES, type LocalSettings, type RawSets } from './permissions.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });
const skipped = (detail: string, fix?: string): CheckResult => ({ status: 'skip', detail, fix });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function mergedEnv(ctx: DoctorContext): NodeJS.ProcessEnv {
  const file = join(ctx.root, '.env');
  let fromFile: Record<string, string> = {};
  try {
    if (ctx.fs.exists(file)) fromFile = parseEnv(ctx.fs.read(file));
  } catch {
    fromFile = {};
  }
  return { ...fromFile, ...ctx.env };
}

// Read-only adapter so the real state readers can run over ctx.fs.
function readFs(ctx: DoctorContext): StateFs {
  const nope = (): never => {
    throw new Error('read-only');
  };
  return { exists: (p) => ctx.fs.exists(p), read: (p) => ctx.fs.read(p), write: nope, mkdir: nope, rename: nope };
}

const now = (ctx: DoctorContext): Date => (ctx.now ? ctx.now() : new Date());
const ageMs = (iso: string | null, at: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : at.getTime() - t;
};
const hours = (ms: number): string => `${Math.floor(ms / HOUR)}h`;

const IDENTITY_NAME = /^(?:[A-Za-z0-9._-]*\.key|jobber-backup[A-Za-z0-9._-]*\.(?:key|txt)|age-[A-Za-z0-9._-]*\.txt)$/;
const safeName = (n: string): string => n.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 80);

function identityFiles(ctx: DoctorContext, dir: string, label: string): string[] {
  if (!ctx.fs.list) return [];
  const found: string[] = [];
  for (const name of ctx.fs.list(dir)) {
    if (BACKUP_NAME_RE.test(name) || name.endsWith('.sha256') || name.endsWith('.age')) continue;
    if (/\.(?:tar|gz|tgz|zip|sqlite)$/.test(name)) continue;
    if (!IDENTITY_NAME.test(name)) continue;
    try {
      if (ctx.fs.read(join(dir, name)).slice(0, 16).startsWith('AGE-SECRET-KEY-')) found.push(`${label}${safeName(name)}`);
    } catch {
      // unreadable or a directory: not reported
    }
  }
  return found;
}

export function updateBackupChecks(): Check[] {
  return [
    {
      id: 'auto-update-config',
      title: 'auto-update: configuration',
      async run(ctx) {
        const cfg = loadUpdateConfig(mergedEnv(ctx));
        if (!cfg.enabled) return pass('AUTO_UPDATE off');
        if (cfg.problems.length > 0) {
          return fail(cfg.problems.join('; '), 'fix the AUTO_UPDATE_* settings in .env');
        }
        const r = await ctx.run('git', ['remote'], { cwd: ctx.root });
        if (r.code !== 0) return skipped('git remote list unavailable');
        if (!r.stdout.split(/\r?\n/).map((s) => s.trim()).includes(cfg.remote)) {
          return warn('AUTO_UPDATE on but the configured remote does not exist', 'add the git remote or set AUTO_UPDATE_REMOTE');
        }
        if (!cfg.requireSigned) {
          return warn('AUTO_UPDATE on with signature verification off', 'set AUTO_UPDATE_REQUIRE_SIGNED=true and AUTO_UPDATE_SIGNERS_FILE');
        }
        return pass('AUTO_UPDATE on, signed updates required, remote present');
      },
    },
    {
      id: 'auto-update-state',
      title: 'auto-update: state',
      async run(ctx) {
        const cfg = loadUpdateConfig(mergedEnv(ctx));
        const rev = await ctx.run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ctx.root });
        const commit = rev.code === 0 && /^[0-9a-f]{4,40}$/.test(rev.stdout.trim()) ? rev.stdout.trim() : 'unknown';
        const head = `commit ${commit}, AUTO_UPDATE ${cfg.enabled ? 'on' : 'off'}`;
        const { state, corrupt } = readStateChecked(readFs(ctx), ctx.root);
        if (corrupt) return warn(`${head}, state file unreadable`, `inspect or remove ${STATE_PATH}`);
        if (state.in_progress) {
          const age = ageMs(state.in_progress.started_at, now(ctx));
          if (age === null || age > HOUR) {
            return fail(`${head}, an update has been in progress for over 60 minutes`, 'check the auto-update log; the runner may have died');
          }
        }
        const last = state.last_result;
        if (!last) return pass(`${head}, last: none`);
        const line = `${head}, last: ${last.outcome} ${last.at} ${last.from}..${last.to ?? '-'}`;
        if (last.outcome === 'rollback_failed') return fail(line, 'repair the checkout by hand, then clear the state');
        if (last.outcome === 'rolled_back') return warn(`${line}, step ${last.step ?? 'unknown'}`);
        if (last.outcome === 'error') return warn(line);
        return pass(line);
      },
    },
    {
      id: 'new-tools-not-allowed',
      title: 'permissions: new tools opted in',
      async run(ctx) {
        const setsPath = join(ctx.root, 'config', 'permission-sets.json');
        const localPath = join(ctx.root, '.claude', 'settings.local.json');
        if (!ctx.fs.exists(setsPath) || !ctx.fs.exists(localPath)) {
          return skipped('no local permission settings to compare');
        }
        let sets: RawSets;
        try {
          sets = JSON.parse(ctx.fs.read(setsPath)) as RawSets;
        } catch {
          return skipped('config/permission-sets.json is not readable');
        }
        let settings: LocalSettings;
        try {
          const parsed: unknown = JSON.parse(ctx.fs.read(localPath));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
          settings = parsed as LocalSettings;
        } catch {
          return fail('.claude/settings.local.json is not valid JSON', 'fix or delete the file, then run setup');
        }
        const allow = settings.permissions?.allow;
        const allowed = new Set(Array.isArray(allow) ? allow.filter((e): e is string => typeof e === 'string') : []);
        let chosen: string | null = null;
        let resolved: string[] = [];
        try {
          const detected = detectSet(settings, sets);
          const managed = new Set<string>();
          for (const n of Object.keys(sets)) for (const e of resolveSet(sets, n)) managed.add(e);
          const active = [...allowed].filter((e) => managed.has(e));
          if (active.length === 0) return skipped('no permission set applied yet', 'run setup to choose one');
          // Exact match, else the smallest known set that contains everything currently allowed.
          const order = detected === 'custom' ? SET_NAMES : [detected];
          for (const name of order) {
            const list = resolveSet(sets, name);
            if (active.every((e) => list.includes(e))) {
              chosen = name;
              resolved = list;
              break;
            }
          }
        } catch {
          return skipped('permission sets could not be resolved');
        }
        if (!chosen) return skipped('current allow list matches no known permission set');
        const missing = resolved.filter((e) => !allowed.has(e));
        if (missing.length === 0) return pass(`all tools of set ${chosen} are allowed`);
        const shown = missing.slice(0, 5).join(', ');
        const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
        return warn(`set ${chosen}: ${missing.length} tool(s) not allowed: ${shown}${more}`, 'run setup to opt in');
      },
    },
    {
      id: 'backup-config',
      title: 'backup: configuration',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const cfg = loadBackupConfig(env, ctx.root);
        const fails: string[] = [];
        const warns: string[] = [];
        let fix: string | undefined;

        if (env.BACKUP_AGE_RECIPIENT?.trim().startsWith('AGE-SECRET-KEY-')) {
          fails.push('BACKUP_AGE_RECIPIENT holds a private key; use the public key');
          fix = 'replace it with the age1... public key and move the private key out of .env';
        } else {
          for (const p of cfg.problems) fails.push(p);
        }

        if (!cfg.configured) {
          if (fails.length === 0) {
            return warn('no backup configured: set BACKUP_DIR and BACKUP_AGE_RECIPIENT', 'see docs/backup-and-restore.md');
          }
          return fail(fails.join('; '), fix);
        }

        const age = await ctx.run('age', ['--version']);
        if (age.code !== 0) {
          fails.push('age is not installed');
          fix = fix ?? 'install age (https://age-encryption.org)';
        }
        const dir = cfg.dir as string;
        const mode = ctx.fs.mode(dir);
        if (mode === null) warns.push('BACKUP_DIR does not exist yet');
        else if ((mode & 0o077) !== 0) {
          fails.push('BACKUP_DIR is readable by others');
          fix = fix ?? 'chmod 700 on BACKUP_DIR';
        }
        const rel = relative(ctx.root, dir);
        if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
          warns.push('BACKUP_DIR is inside the project (same disk, and git clean -fdx would remove it)');
        }
        if (cfg.includeSecrets) warns.push('BACKUP_INCLUDE_SECRETS=true: the archive contains credentials');
        if (cfg.rcloneRemote) {
          const rc = await ctx.run('rclone', ['--version']);
          if (rc.code !== 0) warns.push('BACKUP_RCLONE_REMOTE is set but rclone is not installed');
        }
        if (!cfg.enabled) {
          warns.push('backup configured but scheduled backups are off: set BACKUP_ENABLED=true');
        }
        const keys = [...identityFiles(ctx, ctx.root, ''), ...identityFiles(ctx, dir, 'BACKUP_DIR/')];
        if (keys.length > 0) {
          warns.push(`age private key file next to the backups: ${keys.join(', ')}`);
          fix = fix ?? 'move the age private key off this machine or to a separate secure location';
        }

        if (fails.length > 0) return fail([...fails, ...warns].join('; '), fix);
        if (warns.length > 0) return warn(warns.join('; '), fix);
        return pass('backup configured, age installed, BACKUP_DIR private');
      },
    },
    {
      id: 'backup-freshness',
      title: 'backup: freshness',
      async run(ctx) {
        const { state: st, corrupt } = readBackupStateChecked(readFs(ctx), ctx.root);
        if (corrupt) return warn('backup state unreadable', 'inspect or remove .backups/state.json');
        const at = now(ctx);
        const age = ageMs(st.last_backup_at, at);
        if (st.last_error && (age === null || age > 7 * DAY)) {
          return fail('the last backup failed and there is no success in the last 7 days', 'run npm run backup and read its output');
        }
        if (age === null) return warn('no backup recorded yet', 'run npm run backup');
        if (age > 36 * HOUR) return warn(`last backup is ${hours(age)} old`, 'check the scheduler and BACKUP_ENABLED');
        if (st.last_error?.startsWith('partial:')) {
          return warn(`last backup ${hours(age)} ago, but a destination copy failed (partial)`, 'run npm run backup -- --status and check the destination');
        }
        return pass(`last backup ${hours(age)} ago`);
      },
    },
    {
      id: 'backup-drill',
      title: 'backup: restore drill',
      async run(ctx) {
        const { state: st, corrupt } = readBackupStateChecked(readFs(ctx), ctx.root);
        if (corrupt) return warn('backup state unreadable', 'inspect or remove .backups/state.json');
        const age = ageMs(st.last_drill_at, now(ctx));
        if (age === null) return warn('restore drill never run', 'run the restore drill');
        if (age > 90 * DAY) return warn(`last restore drill ${Math.floor(age / DAY)} days ago`, 'run the restore drill');
        return pass(`last restore drill ${Math.floor(age / DAY)} days ago`);
      },
    },
    {
      id: 'db-private',
      title: 'data.sqlite is private',
      async run(ctx) {
        const mode = ctx.fs.mode(join(ctx.root, 'data.sqlite'));
        if (mode === null) return pass('data.sqlite not present');
        // 600 and 640 pass; group write or any world access fails.
        if ((mode & 0o027) !== 0) return fail('data.sqlite is group-writable or accessible by others', 'chmod 600 data.sqlite');
        return pass('data.sqlite mode is private');
      },
    },
    {
      id: 'update-dirs-private',
      title: '.update and .backups are private',
      async run(ctx) {
        const wide = ['.update', '.backups'].filter((d) => {
          const m = ctx.fs.mode(join(ctx.root, d));
          return m !== null && (m & 0o077) !== 0;
        });
        if (wide.length > 0) return fail(`${wide.join(', ')} readable by others`, `chmod 700 ${wide.join(' ')}`);
        return pass('.update and .backups are mode 700 or absent');
      },
    },
  ];
}
