// src/platform/checksScheduler.ts
// Doctor checks for the scheduler (plan 6D). Registered in scripts/doctor.ts next to the other lists.
// No check here prints an env value.
import { join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { skip } from './doctor.js';
import { parseEnv } from './envFile.js';
import { isDryRun, LEGACY_DRY_RUN_KEYS } from '../safety/dryRun.js';
import { loadDripConfig } from '../scheduler/mailDrip.js';
import { DEFAULT_LABEL, SERVICE_NAME } from '../scheduler/units.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

const OPERATORS = [
  { name: 'linkedin-operator', otherPrefix: 'mcp__naukri__' },
  { name: 'naukri-operator', otherPrefix: 'mcp__linkedin__' },
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
        for (const { name: w, otherPrefix } of OPERATORS) {
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
            else if (t.startsWith(otherPrefix)) bad.push(`${w}: lists ${t} (other platform)`);
          }
        }
        return bad.length === 0
          ? pass('two operator agents match config/worker-tools.json')
          : fail(bad.join('; '), 'align the agent tools line with config/worker-tools.json');
      },
    },
  ];
}
