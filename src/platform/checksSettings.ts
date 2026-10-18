// Doctor checks for the dashboard settings editor (plan 8H, Task 14): catalog, backup store, exposure and the
// editable config files. Offline and read-only. Checks print key names and file ids only, never a value.
import { basename, join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { parseEnv } from './envFile.js';
import { mergedEnv } from './checksSources.js';
import { ENV_CATALOG, INTERNAL_NAMES } from '../settings/envCatalog.js';
import { ENV_EXAMPLE_HEADER, renderEnvExample } from '../settings/exampleGen.js';
import { allEntries } from '../settings/fileRegistry.js';
import type { EnvSpec } from '../settings/types.js';
import { isLoopbackBind } from '../web/env.js';
import { userDataDir } from '../lib/userData.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

export interface SettingsCheckDeps {
  /** default: the real catalog */
  catalog?: EnvSpec[];
}

// Backup store location (matches src/web/server.ts); built from parts, this module only inspects modes and counts.
const STORE_PARTS = ['.jobber', 'settings-backups'] as const;
const STORE_REL = STORE_PARTS.join('/');

const NAME_CAP = 8;
const names = (list: string[]): string => (list.length > NAME_CAP ? `${list.slice(0, NAME_CAP).join(', ')} and ${list.length - NAME_CAP} more` : list.join(', '));

/** The catalog's own rules that matter at runtime. Returns key names with a short reason, no values. */
export function catalogRuleProblems(catalog: EnvSpec[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of catalog) {
    if (seen.has(s.key)) out.push(`${s.key}: duplicate key`);
    seen.add(s.key);
    if (!s.about || s.about.trim() === '') out.push(`${s.key}: no about text`);
    if (s.secret !== (s.type === 'secret')) out.push(`${s.key}: secret flag and type disagree`);
    if (/_DRY_RUN$/.test(s.key) && s.tier !== 'safety') out.push(`${s.key}: a dry-run flag must be safety tier`);
    if ((s.type === 'path' || /_(CMD|PATH|REMOTE|DIR)$/.test(s.key)) && s.tier !== 'never') out.push(`${s.key}: a path or command key must be never tier`);
  }
  return out;
}

function readText(ctx: DoctorContext, p: string): string | null {
  try {
    return ctx.fs.exists(p) ? ctx.fs.read(p) : null;
  } catch {
    return null;
  }
}

const isTrue = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'true';
const DATA_FILE = /\.(env|json)$/;

export function settingsChecks(deps: SettingsCheckDeps = {}): Check[] {
  const catalog = deps.catalog ?? ENV_CATALOG;
  return [
    {
      id: 'settings_catalog',
      title: 'settings: env catalog, .env keys and .env.example',
      async run(ctx) {
        const problems = catalogRuleProblems(catalog);
        if (problems.length > 0) {
          return fail(`catalog breaks its own rules: ${names(problems)}`, 'fix src/settings/envCatalog.ts, then npx vitest run tests/settings-env-catalog.test.ts');
        }
        const known = new Set([...catalog.map((s) => s.key), ...Object.keys(INTERNAL_NAMES)]);
        const envText = readText(ctx, join(ctx.root, '.env'));
        let keys: string[] = [];
        try {
          keys = envText === null ? [] : Object.keys(parseEnv(envText));
        } catch {
          keys = [];
        }
        const unknown = keys.filter((k) => !known.has(k)).sort();
        const example = readText(ctx, join(ctx.root, '.env.example'));
        const drift = example !== renderEnvExample(catalog, ENV_EXAMPLE_HEADER);
        if (unknown.length > 0) {
          return warn(`${unknown.length} unknown key(s) in .env: ${names(unknown)}`, 'remove them or add them to the catalog (src/settings/envCatalog.ts); the dashboard keeps them as they are');
        }
        if (drift) return warn('.env.example differs from the catalog', 'npm run env:example');
        return pass(`${catalog.length} catalog keys, 0 unknown keys in .env, .env.example is current`);
      },
    },
    {
      id: 'settings_store',
      title: 'settings: backup store permissions and retention',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const rawKeep = (env.SETTINGS_BACKUP_KEEP ?? '').trim();
        const keep = /^\d+$/.test(rawKeep) && Number(rawKeep) >= 1 && Number(rawKeep) <= 100 ? Number(rawKeep) : 10;
        const base = join(ctx.root, ...STORE_PARTS);
        const ignore = readText(ctx, join(ctx.root, '.gitignore')) ?? '';
        const ignored = ignore.split(/\r?\n/).some((l) => /^\/?\.jobber\/?$/.test(l.trim()));
        const list = ctx.fs.list?.bind(ctx.fs);
        if (!ignored) return fail('.jobber/ is not ignored by git, backups could be committed', 'add .jobber/ to .gitignore');
        if (!ctx.fs.exists(base)) {
          return warn('no backups yet (the first dashboard apply creates the store)', 'nothing to do until you change a setting from the dashboard');
        }
        const loose: string[] = [];
        const dirs: string[] = [base];
        let overKeep = 0;
        let total = 0;
        const walk = (dir: string): void => {
          if (!list) return;
          let fileCount = 0;
          for (const n of list(dir)) {
            const p = join(dir, n);
            if (DATA_FILE.test(n)) {
              fileCount++;
              total++;
              const m = ctx.fs.mode(p);
              if (m === null || (m & 0o077) !== 0) loose.push(n);
            } else {
              dirs.push(p);
              walk(p);
            }
          }
          if (fileCount > keep) overKeep++;
        };
        walk(base);
        const badDirs = dirs.filter((d) => {
          const m = ctx.fs.mode(d);
          return m === null || (m & 0o077) !== 0;
        }).map((d) => basename(d));
        if (badDirs.length > 0) return fail(`backup directory too open: ${names(badDirs)}`, `chmod 700 ${STORE_REL} and its subdirectories`);
        if (loose.length > 0) return fail(`${loose.length} backup file(s) readable by others`, `chmod 600 the files under ${STORE_REL}`);
        if (total === 0) return warn('no backups yet', 'nothing to do until you change a setting from the dashboard');
        if (overKeep > 0) return warn(`${overKeep} backup folder(s) hold more than SETTINGS_BACKUP_KEEP (${keep})`, 'the next dashboard apply prunes them, or delete the oldest by hand');
        return pass(`${total} backup file(s), modes 0700/0600, within keep ${keep}`);
      },
    },
    {
      id: 'settings_exposure',
      title: 'settings: dashboard editing exposure',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const edit = isTrue(env.WEB_SETTINGS_EDIT);
        const hosts = (env.WEB_ALLOWED_HOSTS ?? '').trim();
        if (isTrue(env.WEB_SETTINGS_REMOTE_SAFETY) && hosts === '') {
          return fail('WEB_SETTINGS_REMOTE_SAFETY=true without WEB_ALLOWED_HOSTS', 'set WEB_ALLOWED_HOSTS to the proxy host name, or set WEB_SETTINGS_REMOTE_SAFETY=false');
        }
        if (!edit) return pass('settings editing is off (WEB_SETTINGS_EDIT is not true)');
        const issues: string[] = [];
        const bind = (env.WEB_BIND ?? '').trim() || '127.0.0.1';
        if (isTrue(env.WEB_TRUST_PROXY)) issues.push('editing is on behind a trusted proxy (WEB_TRUST_PROXY=true)');
        if (!isLoopbackBind(bind)) issues.push('editing is on with a non-loopback WEB_BIND');
        if (isTrue(env.WEB_CHAT_ENABLED)) issues.push('editing and the chat box are both on (WEB_CHAT_ENABLED=true)');
        if (issues.length > 0) return warn(issues.join('; '), 'set WEB_SETTINGS_EDIT=false, or keep the dashboard on loopback with the chat box off');
        return pass('settings editing is on, loopback only, chat box off');
      },
    },
    {
      id: 'settings_files',
      title: 'settings: editable config and user-data files',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const udir = userDataDir(env, ctx.root);
        const pathOf = (rel: string, area: string): string => (area === 'user-data' ? join(udir, basename(rel)) : join(ctx.root, rel));
        const readById = (id: string): string | null => {
          const e = allEntries().find((x) => x.id === id);
          return e ? readText(ctx, pathOf(e.rel, e.area)) : null;
        };
        const missing: string[] = [];
        const invalid: string[] = [];
        let ok = 0;
        for (const e of allEntries()) {
          if (!e.edit) continue;
          const text = readText(ctx, pathOf(e.rel, e.area));
          if (text === null) {
            missing.push(e.id);
            continue;
          }
          let good = false;
          try {
            good = e.validate(text, { readText: readById }).ok;
          } catch {
            good = false;
          }
          if (good) ok++;
          else invalid.push(e.id);
        }
        let modified = 0;
        try {
          const g = await ctx.run('git', ['status', '--porcelain', '--', 'config'], { cwd: ctx.root, timeoutMs: 5000 });
          if (g.code === 0) modified = g.stdout.split('\n').filter((l) => l.trim() !== '').length;
        } catch {
          modified = 0;
        }
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`missing: ${names(missing)}`);
        if (invalid.length > 0) parts.push(`invalid: ${names(invalid)}`);
        if (modified > 0) parts.push(`${modified} committed config file(s) modified locally`);
        if (parts.length > 0) {
          return warn(parts.join('; '), 'open the file in the dashboard Files view (or npm run settings -- check) and fix or restore it');
        }
        return pass(`${ok} editable files present and valid`);
      },
    },
  ];
}
