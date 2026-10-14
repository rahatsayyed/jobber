// src/platform/checksSetup.ts
// Doctor checks added by plan 7B. Tooling, data and config checks here; account and session
// checks (setupAccountChecks) arrive in a later task. Details and fixes never carry file
// contents, env values or command output: only key names, file names and ranges.
import { isAbsolute, join, relative } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { skip } from './doctor.js';
import { parseEnv } from './envFile.js';
import { validateSets, type RawSets } from './permissions.js';
import { userDataDir } from '../lib/userData.js';
import { LIMITS, validateLimit, validatePairs } from '../setup/limitsCatalog.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

// Read by Number(process.env.KEY ?? default): an empty value becomes 0 and a comment NaN.
const DIRECT_READERS = new Set([
  'MATCH_THRESHOLD',
  'SEND_LIMIT_PER_RUN',
  'MAX_APPLIES_PER_DAY',
  'MAX_CONNECTS_PER_DAY',
  'MAX_LINKEDIN_SEARCHES_PER_DAY',
  'HUNTER_MONTHLY_CAP',
]);

function readText(ctx: DoctorContext, path: string): string | null {
  try {
    return ctx.fs.exists(path) ? ctx.fs.read(path) : null;
  } catch {
    return null;
  }
}

function readJson(ctx: DoctorContext, path: string): { ok: true; value: unknown } | { ok: false; missing: boolean } {
  const text = readText(ctx, path);
  if (text === null) return { ok: false, missing: true };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, missing: false };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function dotEnv(ctx: DoctorContext): Record<string, string> {
  const t = readText(ctx, join(ctx.root, '.env'));
  return t === null ? {} : parseEnv(t);
}

function dbFile(ctx: DoctorContext): string {
  const v = { ...dotEnv(ctx), ...ctx.env }.JOBAPPLIER_DB;
  const p = v && v.trim() ? v.trim() : 'data.sqlite'; // mirrors src/dbPath.ts
  return isAbsolute(p) ? p : join(ctx.root, p);
}

const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Field paths (never values) that break the user-data/profile.json shape.
 * Task 11's src/setup/profile.ts validateProfile must stay in step with this function
 * (Task 11 will reuse it).
 */
export function profileProblems(p: unknown): string[] {
  if (!isObj(p)) return ['(root)'];
  const bad: string[] = [];
  if (p.version !== 1) bad.push('version');
  if (!isStrArr(p.roles)) bad.push('roles');
  if (!isStrArr(p.locations)) bad.push('locations');
  if (typeof p.remote_ok !== 'boolean') bad.push('remote_ok');
  if (typeof p.remote_anywhere !== 'boolean') bad.push('remote_anywhere');
  if (!isObj(p.salary)) {
    bad.push('salary');
  } else {
    for (const [cur, v] of Object.entries(p.salary)) {
      if (!/^[A-Z]{3}$/.test(cur)) {
        bad.push('salary.(currency key)');
      } else if (!isObj(v) || !posNum(v.floor) || !posNum(v.target) || v.target < v.floor) {
        bad.push(`salary.${cur}`);
      }
    }
  }
  if (!(typeof p.notice_period_days === 'number' && Number.isInteger(p.notice_period_days) && p.notice_period_days >= 0)) {
    bad.push('notice_period_days');
  }
  const wa = p.work_authorization;
  if (!isObj(wa)) {
    bad.push('work_authorization');
  } else {
    if (typeof wa.india !== 'boolean') bad.push('work_authorization.india');
    if (!['needs_sponsorship', 'authorized', 'unknown'].includes(wa.other as string)) bad.push('work_authorization.other');
  }
  if (p.languages !== undefined && !isStrArr(p.languages)) bad.push('languages');
  return bad;
}

const SERVED = ['user-data', 'docs', 'renderer', 'reports', 'public'];

function chromiumPresent(ctx: DoctorContext): boolean {
  const list = ctx.fs.list;
  if (!list) return false;
  const home = ctx.env.HOME ?? '';
  const dirs = [
    ctx.env.PLAYWRIGHT_BROWSERS_PATH,
    home && join(home, 'Library', 'Caches', 'ms-playwright'),
    home && join(home, '.cache', 'ms-playwright'),
  ].filter((d): d is string => Boolean(d));
  return dirs.some((d) => ctx.fs.exists(d) && list(d).some((n) => n.startsWith('chromium')));
}

export const setupToolingChecks: Check[] = [
  {
    id: 'node-version',
    title: 'Node.js 20 or newer',
    async run(ctx) {
      const r = await ctx.run('node', ['-v']);
      const m = /^v(\d+)\./.exec(r.stdout.trim());
      if (r.code !== 0 || !m) return fail('could not read the Node version', 'install Node.js 20 or newer');
      return Number(m[1]) >= 20
        ? pass(`node ${r.stdout.trim()}`)
        : fail(`node ${r.stdout.trim()} is older than 20`, 'install Node.js 20 or newer');
    },
  },
  {
    id: 'claude-cli',
    title: 'Claude Code CLI installed',
    async run(ctx) {
      const r = await ctx.run('claude', ['--version']);
      return r.code === 0
        ? pass(r.stdout.trim().split('\n')[0] || 'installed')
        : fail('claude CLI not found', 'install Claude Code, then run claude once');
    },
  },
  {
    id: 'claude-login',
    title: 'Claude Code logged in',
    async run(ctx) {
      // `claude auth status` exists (listed by `claude auth --help`); only the exit code is used,
      // its output may contain account details and is never shown.
      const r = await ctx.run('claude', ['auth', 'status']);
      return r.code === 0
        ? pass('logged in')
        : fail('not logged in (or claude not installed)', 'run: claude auth login');
    },
  },
  {
    id: 'chrome',
    title: 'Google Chrome present',
    async run(ctx) {
      if (ctx.fs.exists('/Applications/Google Chrome.app')) return pass('Google Chrome found');
      const r = await ctx.run('google-chrome', ['--version']);
      if (r.code === 0) return pass('Google Chrome found');
      return warn('Google Chrome not found; Naukri headless search and session capture need it', 'install Google Chrome');
    },
  },
  {
    id: 'browser-binaries',
    title: 'browser automation packages and Chromium',
    async run(ctx) {
      const missing = ['patchright', 'playwright'].filter((p) => !ctx.fs.exists(join(ctx.root, 'node_modules', p)));
      if (missing.length) return fail(`missing packages: ${missing.join(', ')}`, 'npm ci');
      if (!chromiumPresent(ctx)) {
        return warn('Playwright Chromium binary not found', 'run npx playwright install chromium');
      }
      return pass('packages and Chromium present');
    },
  },
  {
    id: 'sqlite-file',
    title: 'SQLite database file is private',
    async run(ctx) {
      const file = dbFile(ctx);
      const rel = relative(ctx.root, file);
      const top = rel.startsWith('..') ? '' : rel.split(/[\\/]/)[0];
      if (SERVED.includes(top)) {
        return fail('database file is inside a served or shared directory', 'set JOBAPPLIER_DB to a path outside user-data/, docs/ and renderer/');
      }
      if (!ctx.fs.exists(file)) return warn('database file not created yet', 'it is created on first run');
      const mode = ctx.fs.mode(file);
      if (mode === null) return fail('database file mode could not be read', 'chmod 600 on the database file');
      if ((mode & 0o077) !== 0) {
        return fail(`database file mode is ${(mode & 0o777).toString(8)}, expected 600`, 'chmod 600 data.sqlite');
      }
      return pass('exists, mode 600');
    },
  },
  {
    id: 'sqlite-migrations',
    title: 'SQLite tables migrated',
    async run(ctx) {
      const file = dbFile(ctx);
      if (!ctx.sqliteTables || !ctx.fs.exists(file)) return skip('no database to inspect yet');
      const tables = ctx.sqliteTables(file);
      if (tables === null) return skip('database could not be opened read-only');
      const want = ['jobs', 'outreach_queue', 'daily_counters', 'rate_events'];
      const missing = want.filter((t) => !tables.includes(t));
      return missing.length
        ? fail(`missing tables: ${missing.join(', ')}`, 'run npm run status -- json once, or start any db tool, to migrate')
        : pass('expected tables present');
    },
  },
  {
    id: 'env-limits',
    title: 'limits in .env are valid',
    async run(ctx) {
      const env: Record<string, string> = { ...dotEnv(ctx) };
      for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined) env[k] = v; // process env wins, as at runtime
      const bad: string[] = [];
      for (const spec of LIMITS) {
        const raw = env[spec.key];
        if (raw === undefined) continue;
        if (raw.trim() === '' && !DIRECT_READERS.has(spec.key)) continue; // loader falls back to default
        if (validateLimit(spec, raw) !== null) {
          bad.push(`${spec.key} (expected ${spec.min}..${spec.max}${spec.key === 'CADENCE_GAPS_DAYS' ? ' per value' : ''})`);
        }
      }
      const pairs = validatePairs(Object.fromEntries(Object.entries(env).filter(([, v]) => /^\s*\d+\s*$/.test(v))));
      if (bad.length || pairs.length) {
        return fail([...bad.map((b) => `invalid ${b}`), ...pairs].join('; '), 'fix the value(s) in .env or run npm run setup -- --step limits');
      }
      return pass('all set limits are inside their ranges');
    },
  },
  {
    id: 'env-inline-comments',
    title: 'no inline comments on .env values',
    async run(ctx) {
      const text = readText(ctx, join(ctx.root, '.env'));
      if (text === null) return pass('no .env');
      const keys: string[] = [];
      for (const line of text.split('\n')) {
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=[^"'#]*\s#/.exec(line.trim());
        if (m) keys.push(m[1]);
      }
      return keys.length
        ? warn(`inline comments on: ${keys.join(', ')} (loaders read the comment as part of the value)`, 'npm run setup -- --step limits')
        : pass('none');
    },
  },
  {
    id: 'config-files',
    title: 'config/*.json files are well formed',
    async run(ctx) {
      const problems: string[] = [];
      const checkFile = (name: string, shape: (v: unknown) => boolean) => {
        const r = readJson(ctx, join(ctx.root, 'config', name));
        if (!r.ok) {
          if (!r.missing) problems.push(`${name} is not valid JSON`);
          return;
        }
        if (!shape(r.value)) problems.push(`${name} has the wrong shape`);
      };
      checkFile('target-regions.json', (v) => isObj(v) && Array.isArray(v.home) && Array.isArray(v.targets));
      checkFile('portals.json', (v) => isObj(v) && Array.isArray(v.tracked_companies));
      checkFile('permission-sets.json', (v) => {
        if (!isObj(v)) return false;
        try {
          validateSets(v as RawSets);
          return true;
        } catch {
          return false;
        }
      });
      for (const name of ['deal-breakers.json', 'replies.json', 'discover-linkedin.json']) {
        checkFile(name, (v) => v !== null && typeof v === 'object');
      }
      return problems.length ? fail(problems.join('; '), 'restore the file from git or fix the JSON') : pass('all present config files parse');
    },
  },
  {
    id: 'user-data-private',
    title: 'user-data is private and git-ignored',
    async run(ctx) {
      const dir = userDataDir(ctx.env, ctx.root);
      const problems: string[] = [];
      if (ctx.fs.exists(dir)) {
        const m = ctx.fs.mode(dir);
        if (m !== null && (m & 0o777) !== 0o700) problems.push(`user-data dir mode is ${(m & 0o777).toString(8)}`);
        for (const name of ctx.fs.list?.(dir) ?? []) {
          const fm = ctx.fs.mode(join(dir, name));
          if (fm !== null && (fm & 0o077) !== 0) problems.push(`${name} mode is ${(fm & 0o777).toString(8)}`);
        }
      }
      const gi = (readText(ctx, join(ctx.root, '.gitignore')) ?? '').split('\n').map((l) => l.trim());
      for (const want of ['user-data/', 'secrets/']) {
        if (!gi.some((l) => l === want || l === '/' + want || l === want.slice(0, -1))) {
          problems.push(`.gitignore does not list ${want}`);
        }
      }
      return problems.length
        ? fail(problems.join('; '), 'chmod 700 user-data && chmod 600 user-data/*, and add user-data/ and secrets/ to .gitignore')
        : pass('dir 700, files 600, both folders ignored');
    },
  },
  {
    id: 'resume-valid',
    title: 'user resume is filled in',
    async run(ctx) {
      const r = readJson(ctx, join(userDataDir(ctx.env, ctx.root), 'resume.json'));
      if (!r.ok) {
        return fail(r.missing ? 'user resume is missing' : 'user resume is not valid JSON', 'npm run setup -- --step resume');
      }
      if (!isObj(r.value)) return fail('user resume has the wrong shape', 'npm run setup -- --step resume');
      const need = ['name', 'jobTitle', 'email', 'phone', 'summary', 'experience', 'education', 'skills'];
      const absent = need.filter((k) => !(k in (r.value as Record<string, unknown>)));
      if (absent.length) return fail(`resume is missing keys: ${absent.join(', ')}`, 'npm run setup -- --step resume');
      const tpl = readJson(ctx, join(ctx.root, 'user-data.example', 'resume.json'));
      const email = String((r.value as Record<string, unknown>).email ?? '');
      const same = tpl.ok && JSON.stringify(tpl.value) === JSON.stringify(r.value);
      if (same || /@example\.com$/i.test(email)) {
        return warn('resume is still the template', 'npm run setup -- --step resume');
      }
      return pass('resume has the expected keys');
    },
  },
  {
    id: 'languages-confirmed',
    title: 'language list confirmed',
    async run(ctx) {
      const r = readJson(ctx, join(userDataDir(ctx.env, ctx.root), 'languages.json'));
      if (!r.ok) return warn(r.missing ? 'languages.json is missing' : 'languages.json is not valid JSON', 'npm run setup -- --step profile');
      if (!isObj(r.value) || r.value.confirmed !== true) {
        return warn('languages are not confirmed, so the language gate only flags', 'review languages.json and set "confirmed": true');
      }
      return pass('confirmed');
    },
  },
  {
    id: 'profile-valid',
    title: 'profile.json is valid',
    async run(ctx) {
      const r = readJson(ctx, join(userDataDir(ctx.env, ctx.root), 'profile.json'));
      if (!r.ok) {
        return r.missing
          ? warn('profile.json is missing', 'npm run setup -- --step profile')
          : fail('profile.json is not valid JSON', 'npm run setup -- --step profile');
      }
      const bad = profileProblems(r.value);
      return bad.length
        ? fail(`invalid fields: ${bad.join(', ')}`, 'npm run setup -- --step profile')
        : pass('profile parses');
    },
  },
  {
    id: 'mcp-config',
    title: '.mcp.json servers point at real files',
    async run(ctx) {
      const r = readJson(ctx, join(ctx.root, '.mcp.json'));
      if (!r.ok) return fail(r.missing ? '.mcp.json is missing' : '.mcp.json is not valid JSON', 'restore .mcp.json from git');
      const servers = isObj(r.value) && isObj(r.value.mcpServers) ? r.value.mcpServers : null;
      if (!servers) return fail('.mcp.json has no mcpServers', 'restore .mcp.json from git');
      const missing: string[] = [];
      for (const [name, def] of Object.entries(servers)) {
        const args = isObj(def) && Array.isArray(def.args) ? def.args : [];
        for (const a of args) {
          if (typeof a === 'string' && /^src\/mcp\/[\w.-]+\.ts$/.test(a) && !ctx.fs.exists(join(ctx.root, a))) {
            missing.push(name);
          }
        }
      }
      return missing.length ? fail(`server file missing for: ${missing.join(', ')}`, 'git checkout src/mcp') : pass(`${Object.keys(servers).length} servers configured`);
    },
  },
  {
    id: 'blocking-hooks',
    title: 'PreToolUse blocking hooks installed',
    async run(ctx) {
      const r = readJson(ctx, join(ctx.root, '.claude', 'settings.json'));
      if (!r.ok) return fail('.claude/settings.json is missing or invalid', 'restore .claude/settings.json from git');
      const pre = isObj(r.value) && isObj(r.value.hooks) ? r.value.hooks.PreToolUse : undefined;
      if (!Array.isArray(pre) || pre.length === 0) {
        return fail('no PreToolUse hooks configured', 'restore .claude/settings.json from git');
      }
      const missing: string[] = [];
      for (const entry of pre) {
        const hooks = isObj(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
        for (const h of hooks) {
          const cmd = isObj(h) && typeof h.command === 'string' ? h.command : '';
          for (const m of cmd.matchAll(/\.claude\/hooks\/[\w.-]+/g)) {
            if (!ctx.fs.exists(join(ctx.root, m[0]))) missing.push(m[0]);
          }
        }
      }
      return missing.length
        ? fail(`hook script missing: ${[...new Set(missing)].join(', ')}`, 'git checkout .claude/hooks')
        : pass('hooks present and scripts exist');
    },
  },
];

// Filled in by the account and session checks task.
export const setupAccountChecks: Check[] = [];

export const setupChecks: Check[] = [...setupToolingChecks, ...setupAccountChecks];
