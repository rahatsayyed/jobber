// src/platform/checksScheduler.ts
// Doctor checks for the scheduler (plan 6D). Registered in scripts/doctor.ts next to the other lists.
// No check here prints an env value.
import { join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { skip } from './doctor.js';
import { parseEnv } from './envFile.js';
import { isDryRun, LEGACY_DRY_RUN_KEYS } from '../safety/dryRun.js';
import { budgetEnvWarnings } from '../scheduler/budget.js';
import { loadDripConfig } from '../scheduler/mailDrip.js';
import { loadActiveHours } from '../linkedin/activeHours.js';
import { loadLinkedinDripConfig } from '../scheduler/linkedinDrip.js';
import { parseWindowLanes } from '../scheduler/windowLanes.js';
import { mailDailyLimit } from '../scheduler/mailLimit.js';
import { linkedinStartDiff } from '../scheduler/linkedinWindowStart.js';
import { wakeStartDiff } from '../scheduler/wakeWindowStart.js';
import { LINKEDIN_WINDOW, WAKE_WINDOWS } from '../scheduler/wakeWindows.js';
import { DEFAULT_LABEL, SERVICE_NAME } from '../scheduler/units.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

const OPERATORS = [
  { name: 'linkedin-operator', otherPrefixes: ['mcp__naukri__', 'mcp__wellfound__'] },
  { name: 'naukri-operator', otherPrefixes: ['mcp__linkedin__', 'mcp__wellfound__'] },
  { name: 'wellfound-operator', otherPrefixes: ['mcp__linkedin__', 'mcp__naukri__'] },
] as const;
// The four per-task workers were replaced by the operators; their files must not come back.
const RETIRED_WORKERS = ['due-followups', 'new-outreach', 'inbox-recruiter-replies', 'naukri-search'] as const;
const FORBIDDEN_OPERATOR_TOOLS = ['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit'];

function mergedEnv(ctx: DoctorContext): NodeJS.ProcessEnv {
  const file = join(ctx.root, '.env');
  let fromFile: Record<string, string> = {};
  try {
    if (ctx.fs.exists(file)) fromFile = parseEnv(ctx.fs.read(file));
  } catch {
    fromFile = {};
  }
  return { ...fromFile, ...ctx.env }; // process env over .env, like the daemon
}

function parseTmuxVersion(text: string): { major: number; minor: number } | null {
  const m = /(\d+)\.(\d+)/.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function toolsLine(md: string): string[] | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/).filter((l) => /^tools\s*:/.test(l));
  if (lines.length !== 1) return null;
  return lines[0].replace(/^tools\s*:/, '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function schedulerChecks(): Check[] {
  return [
    {
      id: 'scheduler-tmux',
      title: 'scheduler: tmux >= 3.2',
      async run(ctx) {
        const r = await ctx.run('tmux', ['-V']);
        if (r.code !== 0) return fail('tmux not found', 'install tmux 3.2 or newer');
        const v = parseTmuxVersion(r.stdout);
        if (!v) return warn('tmux version not recognised', 'check `tmux -V`');
        const ok = v.major > 3 || (v.major === 3 && v.minor >= 2);
        return ok
          ? pass(`tmux ${v.major}.${v.minor}`)
          : fail(`tmux ${v.major}.${v.minor} is older than 3.2`, 'upgrade tmux to 3.2 or newer');
      },
    },
    {
      id: 'scheduler-lock-dir',
      title: 'scheduler: lock dir writable',
      async run(ctx) {
        const mode = ctx.fs.mode(join(ctx.root, '.jobber'));
        if (mode === null) return pass('.jobber not created yet (created on first run)');
        return (mode & 0o200) !== 0
          ? pass('.jobber is writable by the owner')
          : fail('.jobber is not writable', 'chmod u+w .jobber');
      },
    },
    {
      id: 'scheduler-stop-file',
      title: 'scheduler: STOP file absent or reported',
      async run(ctx) {
        return ctx.fs.exists(join(ctx.root, '.jobber', 'STOP'))
          ? warn('STOP file is present: the scheduler will not launch', 'npm run jobber:control -- resume')
          : pass('no STOP file');
      },
    },
    {
      id: 'scheduler-dry-run',
      title: 'dry run mode (JOBBER_DRY_RUN, the only dry-run flag)',
      async run(ctx) {
        const env = mergedEnv(ctx);
        if (isDryRun(env)) return pass('MODE: DRY RUN');
        const unset = typeof env.JOBBER_DRY_RUN !== 'string' || env.JOBBER_DRY_RUN.trim() === '';
        return warn(
          unset
            ? 'MODE: LIVE (JOBBER_DRY_RUN is not set, so it runs LIVE: real sends are enabled)'
            : 'MODE: LIVE (real sends are enabled)',
          'set JOBBER_DRY_RUN=true in .env to go back to dry',
        );
      },
    },
    {
      id: 'mail-drip-config',
      title: 'mail drip lane: window, batch, gap and pause settings are sane',
      async run(ctx) {
        const c = loadDripConfig(mergedEnv(ctx));
        return c.problems.length === 0
          ? pass(`window ${Math.floor(c.windowStartMin / 60)}:${String(c.windowStartMin % 60).padStart(2, '0')}-${Math.floor(c.windowEndMin / 60)}:${String(c.windowEndMin % 60).padStart(2, '0')} IST, batch ${c.minBatch}-${c.maxBatch}, gap ${c.minGapMin}-${c.maxGapMin} min, pause ${c.pauseMinSec}-${c.pauseMaxSec} s, daily cap ${c.maxPerDay || 'none'}`)
          : fail(`the mail drip lane sends nothing until fixed: ${c.problems.join('; ')}`, 'fix the EMAIL_SEND_WINDOW_*, EMAIL_DRIP_* and EMAIL_MAX_PER_DAY values in .env');
      },
    },
    {
      id: 'run-budget-config',
      title: 'run budgets (RUN_MAX_WALL_SEC, RUN_MAX_TOKENS_APPROX, RUN_STALL_SEC) are inside their allowed range',
      async run(ctx) {
        const w = budgetEnvWarnings(mergedEnv(ctx));
        return w.length === 0 ? pass('run budget values are valid or unset') : warn(w.join('; '), 'fix the value in .env, or remove the line to use the default');
      },
    },
    {
      id: 'linkedin-active-hours',
      title: 'LinkedIn active hours (LINKEDIN_ACTIVE_HOURS) are valid',
      async run(ctx) {
        const h = loadActiveHours(mergedEnv(ctx));
        const hm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        return h.problem === null
          ? pass(`LinkedIn work only ${hm(h.startMin)}-${hm(h.endMin)} IST`)
          : warn(h.problem, 'write LINKEDIN_ACTIVE_HOURS as HH:MM-HH:MM (IST, start before end) in .env, e.g. 09:30-20:30');
      },
    },
    {
      id: 'linkedin-drip-config',
      title: 'LinkedIn drip lane: switch, gap and inbox settings are sane',
      async run(ctx) {
        const c = loadLinkedinDripConfig(mergedEnv(ctx));
        if (c.problems.length > 0) {
          return fail(`the LinkedIn drip lane does nothing until fixed: ${c.problems.join('; ')}`, 'fix LINKEDIN_DRIP, LINKEDIN_DRIP_MIN_GAP_MIN, LINKEDIN_DRIP_MAX_GAP_MIN and LINKEDIN_INBOX_MIN_GAP_MIN in .env');
        }
        return pass(c.enabled
          ? `on: one LinkedIn action every ${c.minGapMin}-${c.maxGapMin} min, inbox read at most every ${c.inboxGapMin} min; wakes plan no LinkedIn sends`
          : 'off (LINKEDIN_DRIP=false): wakes plan the LinkedIn inbox, follow-ups and new outreach like before');
      },
    },
    {
      id: 'linkedin-easy-apply',
      title: 'LinkedIn Easy Apply (APPLY_LINKEDIN_EASY): a drip lane action on the main account, or the owner applies by hand',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const raw = (env.APPLY_LINKEDIN_EASY ?? '').trim();
        if (raw !== 'true') {
          if (raw === '' || raw === 'false') return pass('off (the default): LinkedIn Easy Apply jobs wait in the manual apply queue (npm run apply:manual -- list)');
          return warn('APPLY_LINKEDIN_EASY is not exactly true or false, so Easy Apply stays off', 'write APPLY_LINKEDIN_EASY=true (lower case) in .env to turn it on, or false to keep it off');
        }
        const problems: string[] = [];
        if (!loadLinkedinDripConfig(env).enabled) problems.push('the LinkedIn drip lane is off (LINKEDIN_DRIP=false), so nothing is applied');
        if (!ctx.fs.exists(join(ctx.root, 'user-data', 'easy-apply-answers.json'))) problems.push('user-data/easy-apply-answers.json is missing, so most questions park the job (npm run answers -- list)');
        const capRaw = (env.LINKEDIN_MAX_EASY_APPLIES_PER_DAY ?? '').trim();
        const cap = capRaw === '' ? 5 : Number(capRaw);
        if (!Number.isInteger(cap) || cap < 0) problems.push('LINKEDIN_MAX_EASY_APPLIES_PER_DAY is not a whole number, the default 5 applies');
        else if (cap === 0) problems.push('LINKEDIN_MAX_EASY_APPLIES_PER_DAY is 0, so nothing is applied');
        if (problems.length > 0) return warn(`on, but ${problems.join('; ')}`, 'fix the settings above in .env or user-data');
        return pass(`on: up to ${Number.isInteger(cap) ? cap : 5} per day, one application per LinkedIn drip tick on the main account, answers only from the answer book`);
      },
    },
    {
      id: 'dry-run-legacy-keys',
      title: 'no retired *_DRY_RUN keys in the environment',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const left = LEGACY_DRY_RUN_KEYS.filter((k) => env[k] !== undefined);
        return left.length === 0
          ? pass('no legacy dry-run keys')
          : warn(
            `ignored legacy keys: ${left.join(', ')} (JOBBER_DRY_RUN is the only dry-run flag)`,
            'remove them from .env: they are ignored',
          );
      },
    },
    {
      id: 'scheduler-units',
      title: 'scheduler: units generated',
      async run(ctx) {
        const dir = join(ctx.root, '.jobber', 'units');
        const have = [`${DEFAULT_LABEL}.plist`, SERVICE_NAME].filter((f) => ctx.fs.exists(join(dir, f)));
        if (have.length === 2) return pass('launchd and systemd units present');
        if (have.length === 0) return skip('units not generated yet', 'npm run scheduler:units');
        return warn('only one unit file present', 'npm run scheduler:units');
      },
    },
    {
      id: 'agents-worker-tools',
      title: 'agents: worker tool lint ok',
      async run(ctx) {
        const cfgPath = join(ctx.root, 'config', 'worker-tools.json');
        if (!ctx.fs.exists(cfgPath)) return fail('config/worker-tools.json is missing');
        let cfg: Record<string, unknown>;
        try {
          cfg = JSON.parse(ctx.fs.read(cfgPath)) as Record<string, unknown>;
        } catch {
          return fail('config/worker-tools.json is not valid JSON');
        }
        const bad: string[] = [];
        for (const w of RETIRED_WORKERS) {
          if (ctx.fs.exists(join(ctx.root, '.claude', 'agents', `${w}.md`))) {
            bad.push(`${w}: retired worker file still exists`);
          }
        }
        for (const { name: w, otherPrefixes } of OPERATORS) {
          const file = join(ctx.root, '.claude', 'agents', `${w}.md`);
          if (!ctx.fs.exists(file)) {
            bad.push(`${w}: agent file missing`);
            continue;
          }
          const tools = toolsLine(ctx.fs.read(file));
          const want = cfg[w];
          if (!tools) {
            bad.push(`${w}: no single tools line`);
            continue;
          }
          if (!Array.isArray(want) || want.join(', ') !== tools.join(', ')) bad.push(`${w}: tools differ from config`);
          for (const t of tools) {
            if (FORBIDDEN_OPERATOR_TOOLS.includes(t)) bad.push(`${w}: lists ${t}`);
            else if (otherPrefixes.some((p) => t.startsWith(p))) bad.push(`${w}: lists ${t} (other platform)`);
          }
        }
        return bad.length === 0
          ? pass('three operator agents match config/worker-tools.json')
          : fail(bad.join('; '), 'align the agent tools line with config/worker-tools.json');
      },
    },
    {
      id: 'window-foundation',
      title: 'worker windows: launcher, guard hook, unverified claude behaviours',
      async run(ctx) {
        const files = ['scripts/claude-window.sh', 'scripts/window-env.ts', '.claude/hooks/window-guard.cjs'];
        const missing = files.filter((f) => !ctx.fs.exists(join(ctx.root, f)));
        if (missing.length > 0) return fail(`missing: ${missing.join(', ')}`, 'restore the files from git');
        const { lanes, invalid } = parseWindowLanes(mergedEnv(ctx));
        if (invalid.length > 0) return warn(`WINDOW_LANES has entries that are not lane names: ${invalid.join(', ')}`, 'use lowercase names separated by commas');
        const note =
          'UNVERIFIED with the installed claude: (1) --session-id for an interactive session, (2) a first positional prompt (the startup line is typed with sendText instead)';
        // The mail window's SEND_LIMIT_PER_RUN marker is fixed at window start (scripts/window-env.ts records it). A later change of
        // EMAIL_MAX_PER_DAY does not reach the running window until it is restarted: warn when the two differ.
        if (lanes.includes('mail')) {
          const rec = join(ctx.root, '.jobber', 'window-start', 'mail.json');
          if (ctx.fs.exists(rec)) {
            try {
              const started = (JSON.parse(ctx.fs.read(rec)) as { SEND_LIMIT_PER_RUN?: string }).SEND_LIMIT_PER_RUN;
              const now = String(mailDailyLimit(mergedEnv(ctx)));
              if (started !== undefined && started !== now) {
                return warn(`the mail window started with SEND_LIMIT_PER_RUN=${started} but EMAIL_MAX_PER_DAY now gives ${now}`, 'restart the mail window: npx tsx scripts/manager.ts restart mail');
              }
            } catch {
              // unreadable record: nothing to compare
            }
          }
        }
        // The linkedin window reads the dry-run flag, the Easy Apply switch and the daily limits once at window start
        // (scripts/window-env.ts records them): warn when .env differs now. A dry-run difference matters most (the lane refuses to type
        // when the scheduler is dry but the window started live).
        if (lanes.includes('linkedin')) {
          const rec = join(ctx.root, '.jobber', 'window-start', 'linkedin.json');
          if (ctx.fs.exists(rec)) {
            try {
              const diff = linkedinStartDiff(JSON.parse(ctx.fs.read(rec)) as Record<string, unknown>, mergedEnv(ctx));
              if (diff.length > 0) {
                return warn(`the linkedin window started with different values of: ${diff.join(', ')} (.env changed since)`, 'restart the linkedin window: npx tsx scripts/manager.ts restart linkedin');
              }
            } catch {
              // unreadable record: nothing to compare
            }
          }
        }
        // The `wake` lane (Phase 3c): the wake's steps go to the sources, pipeline, boards and apply windows (and the linkedin window when its lane is
        // listed too). Warn when a window's start record differs from .env, when a required window is not in the config or not running, or
        // when the dispatcher code is missing. --once and --now always stay headless.
        if (lanes.includes('wake')) {
          const need = [...WAKE_WINDOWS, ...(lanes.includes('linkedin') ? [LINKEDIN_WINDOW] : [])];
          const cfgFile = join(ctx.root, 'config', 'manager-windows.json');
          let configured: string[] = [];
          try { configured = Object.keys((JSON.parse(ctx.fs.read(cfgFile)) as { windows?: Record<string, unknown> }).windows ?? {}); } catch { configured = need; }
          const noCfg = WAKE_WINDOWS.filter((w) => !configured.includes(w));
          if (noCfg.length > 0) return warn(`the wake lane is on but config/manager-windows.json has no window: ${noCfg.join(', ')} (their steps run in a headless session)`, 'restore config/manager-windows.json from git');
          if (!ctx.fs.exists(join(ctx.root, 'src', 'scheduler', 'windowDispatch.ts'))) return warn('the wake lane is on but the window dispatcher (src/scheduler/windowDispatch.ts) is missing', 'restore the file from git');
          const diffs: string[] = [];
          for (const w of need) {
            const rec = join(ctx.root, '.jobber', 'window-start', `${w}.json`);
            if (!ctx.fs.exists(rec)) continue;
            try {
              const diff = wakeStartDiff(JSON.parse(ctx.fs.read(rec)) as Record<string, unknown>, mergedEnv(ctx));
              if (diff.length > 0) diffs.push(`${w} (${diff.join(', ')})`);
            } catch {
              // unreadable record: nothing to compare
            }
          }
          if (diffs.length > 0) return warn(`wake windows started with different values than .env gives now: ${diffs.join('; ')}`, 'restart those windows: npx tsx scripts/manager.ts restart <window>');
          const listed = await ctx.run('tmux', ['list-windows', '-t', '=Jobber', '-F', '#{window_name}']);
          if (listed.code === 0) {
            const running = new Set(listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
            const down = need.filter((w) => !running.has(w));
            if (down.length > 0) return warn(`the wake lane is on but these windows are not running: ${down.join(', ')} (their steps run in a headless session each wake)`, 'start them: npm run up');
          }
        }
        if (lanes.length === 0) return skip(`WINDOW_LANES is empty, no lane uses a window yet. ${note}`);
        const help = await ctx.run('claude', ['--help']);
        const listed = /--session-id/.test(help.stdout) ? '--session-id is listed in claude --help' : '--session-id is NOT listed in claude --help';
        return warn(`lanes through windows: ${lanes.join(', ')}. ${note}. ${listed}`, 'run one item of the lane in dry run and watch the window before going live');
      },
    },
  ];
}
