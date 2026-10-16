// Doctor checks for the browser-apply stack (plan 8G-2 task 24): web flags, site accounts, wiring, recipes,
// legacy removal, login commands, per-host caps and the browser-launch lint. Registered in checkLists.ts.
// Offline and read-only. No check prints an env value, a password or a path outside the project.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { skip } from './doctor.js';
import { parseEnv } from './envFile.js';
import { mergedEnv } from './checksSources.js';
import { loadWebConfig } from '../webcore/config.js';
import { loadAccounts } from '../webcore/accounts.js';
import { APPLY_HOST_PLATFORM_IDS, hostCapWarnings, resolveHostCap } from '../webcore/hostCaps.js';
import { callsScreen, SCREENED_SURFACES } from '../safety/screen.js';
import { validateRecipe } from '../applier/recipes/schema.js';
import { checkClassifierForLaunch } from './launchCheck.js';
import { LAUNCH_HOME, legacyAllowlist, scanLaunches } from '../lib/launchLint.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

export interface WebCheckDeps {
  /** True when the classifier is ready for a live run; default runs checkClassifierForLaunch. */
  classifierReady?: (ctx: DoctorContext, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

const WEB_SURFACE_FILES = /^(src\/applier\/|src\/mcp\/applier\.ts$|src\/scout\/|src\/mcp\/scout\.ts$|src\/webcore\/)/;
const KILL_SWITCH_HOOK = /kill-switch\.cjs/;

function readJson<T>(ctx: DoctorContext, rel: string): T | null {
  const p = join(ctx.root, rel);
  try {
    return ctx.fs.exists(p) ? (JSON.parse(ctx.fs.read(p)) as T) : null;
  } catch {
    return null;
  }
}

function agentTools(text: string): string[] | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const line = m?.[1]?.split('\n').find((l) => l.startsWith('tools:'));
  if (!line) return null;
  return line.slice('tools:'.length).split(',').map((s) => s.trim()).filter(Boolean);
}

async function defaultClassifierReady(ctx: DoctorContext, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    return (await checkClassifierForLaunch(env, ctx.root, false)).ok;
  } catch {
    return false;
  }
}

export function webChecks(deps: WebCheckDeps = {}): Check[] {
  const classifierReady = deps.classifierReady ?? defaultClassifierReady;
  return [
    {
      id: 'web_flags',
      title: 'web flags: dry run and submit mode',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const cfg = loadWebConfig(env);
        const submit = (env.APPLY_SUBMIT_MODE ?? '').trim() === 'submit';
        if (cfg.dryRun) return pass(`dry run (submit mode ${submit ? 'submit' : 'hold'})`);
        if (!submit) return pass('live, submit mode hold (the applier stops before the final click)');
        if (!(await classifierReady(ctx, env))) {
          return fail('live with submit while the classifier is not ready', 'npm run models -- fetch|pin, npm run classifier:fit, or set APPLY_SUBMIT_MODE=hold');
        }
        return warn('live with submit: the applier will send applications', 'set APPLY_SUBMIT_MODE=hold to review before each final click');
      },
    },
    {
      id: 'site_accounts',
      title: 'site accounts: store permissions and creation flags',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const problems: string[] = [];
        const dir = join(ctx.root, 'secrets');
        const file = join(dir, 'site-accounts.json');
        try {
          if (lstatSync(dir).isSymbolicLink()) problems.push('secrets directory is a symlink');
        } catch { /* absent is fine */ }
        const mode = (env.SITE_MAIL_VERIFY ?? '').trim().toLowerCase();
        if (mode !== '' && !['owner_assist', 'gmail', 'off'].includes(mode)) problems.push('SITE_MAIL_VERIFY is not owner_assist, gmail or off');
        let count = 0;
        const loaded = loadAccounts(file);
        if (!loaded.ok) problems.push(loaded.reason);
        else count = Object.keys(loaded.accounts).length;
        // A password belongs in the 0600 store, never in .env.
        const envFile = join(ctx.root, '.env');
        try {
          if (ctx.fs.exists(envFile)) {
            const keys = Object.entries(parseEnv(ctx.fs.read(envFile))).filter(([k, v]) => /^(SITE|APPLY|SCOUT|WEB)_.*(PASSWORD|PASSWD)/i.test(k) && v !== '').map(([k]) => k);
            if (keys.length) problems.push(`password in .env (${keys.join(', ')})`);
          }
        } catch { /* unreadable .env is another check's business */ }
        if (problems.length) return fail(problems.join('; '), 'chmod 700 secrets and chmod 600 secrets/site-accounts.json; keep passwords out of .env');
        const creation = env.APPLY_ALLOW_ACCOUNT_CREATION === 'true' || env.SCOUT_ALLOW_SIGNUP === 'true';
        const base = `${count} stored account${count === 1 ? '' : 's'}`;
        if (mode === 'gmail' && (env.SITE_MAIL_SENDERS ?? '').trim() === '') {
          return warn(`${base}; SITE_MAIL_VERIFY=gmail with empty SITE_MAIL_SENDERS (falls back to owner_assist)`, 'set SITE_MAIL_SENDERS or use owner_assist');
        }
        if (creation && count === 0) return warn(`${base}; account creation is allowed (APPLY_ALLOW_ACCOUNT_CREATION or SCOUT_ALLOW_SIGNUP)`, 'leave both false unless you want the agent to create site accounts');
        return pass(`${base}; account creation ${creation ? 'allowed' : 'off'}`);
      },
    },
    {
      id: 'web_wired',
      title: 'web surfaces screened, kill switch and agent tool lists',
      async run(ctx) {
        const problems: string[] = [];
        const surfaces = SCREENED_SURFACES.filter((s) => WEB_SURFACE_FILES.test(s.file));
        for (const id of ['apply_state', 'apply_escalate', 'applier_site_state']) {
          if (!surfaces.some((s) => s.id === id)) problems.push(`surface ${id} is not registered`);
        }
        for (const s of surfaces) {
          const p = join(ctx.root, s.file);
          if (!ctx.fs.exists(p)) problems.push(`${s.id} (${s.file} missing)`);
          else if (!callsScreen(ctx.fs.read(p))) problems.push(`${s.id} does not call the screen`);
        }
        // Kill-switch matcher covers every mutating applier tool.
        let tools: readonly string[] = [];
        let mutating: readonly string[] = [];
        try {
          const m = await import('../mcp/applier.js');
          tools = m.TOOL_NAMES;
          mutating = m.MUTATING_TOOLS;
        } catch {
          problems.push('applier tool list could not be loaded');
        }
        const settings = readJson<{ hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> } }>(ctx, '.claude/settings.json');
        const entry = settings?.hooks?.PreToolUse?.find((h) => h.hooks?.some((x) => KILL_SWITCH_HOOK.test(x.command ?? '')) && typeof h.matcher === 'string');
        if (!entry) problems.push('no kill-switch matcher in .claude/settings.json');
        else if (mutating.length) {
          let re: RegExp | null = null;
          try { re = new RegExp(`^(?:${entry.matcher})$`); } catch { problems.push('kill-switch matcher is not a valid pattern'); }
          if (re) {
            const open = mutating.filter((t) => !re!.test(`mcp__applier__${t}`));
            if (open.length) problems.push(`mutating tools outside the kill switch: ${open.join(', ')}`);
          }
        }
        // Agent tool lists match the committed worker-tools.json.
        const workers = readJson<Record<string, string[]>>(ctx, 'config/worker-tools.json') ?? {};
        for (const [agent, list] of Object.entries(workers)) {
          if (!Array.isArray(list)) continue;
          const md = join(ctx.root, '.claude', 'agents', `${agent}.md`);
          if (!ctx.fs.exists(md)) continue;
          const actual = agentTools(ctx.fs.read(md));
          if (!actual || actual.length !== list.length || actual.some((t) => !list.includes(t))) problems.push(`agent ${agent} tools differ from config/worker-tools.json`);
          if (tools.length) {
            const unknown = list.filter((t) => t.startsWith('mcp__applier__') && !(tools as readonly string[]).includes(t.slice('mcp__applier__'.length)));
            if (unknown.length) problems.push(`${agent}: unregistered applier tools ${unknown.join(', ')}`);
          }
        }
        if (problems.length) return fail(problems.slice(0, 4).join('; ') + (problems.length > 4 ? ` (+${problems.length - 4} more)` : ''), 'see src/safety/screen.ts, .claude/settings.json and config/worker-tools.json');
        const scout = ctx.fs.exists(join(ctx.root, 'src', 'scout')) ? 'scout surfaces checked' : 'scout: n/a, not installed';
        return pass(`${surfaces.length} web surfaces screened, ${mutating.length} mutating tools under the kill switch, agent tool lists match; ${scout}`);
      },
    },
    {
      id: 'apply_recipes',
      title: 'apply recipes validate',
      async run(ctx) {
        const check = (rel: string): { ok: number; bad: string[] } => {
          const dir = join(ctx.root, rel);
          const out = { ok: 0, bad: [] as string[] };
          for (const name of ctx.fs.list?.(dir) ?? []) {
            if (!name.endsWith('.json')) continue;
            try {
              const v = validateRecipe(JSON.parse(ctx.fs.read(join(dir, name))));
              if (v.ok && v.recipe.id === name.slice(0, -5)) out.ok++;
              else out.bad.push(name);
            } catch { out.bad.push(name); }
          }
          return out;
        };
        const shipped = check('config/ats-recipes');
        if (shipped.bad.length) return fail(`shipped recipe invalid: ${shipped.bad.join(', ')}`, 'git checkout config/ats-recipes');
        const learned = check('.jobber/ats-recipes');
        if (learned.bad.length) return warn(`${shipped.ok} shipped recipes valid; learned recipe invalid: ${learned.bad.join(', ')}`, 'delete the file in .jobber/ats-recipes; it is relearned');
        return pass(`${shipped.ok} shipped and ${learned.ok} learned recipes validate`);
      },
    },
    {
      id: 'legacy_removed',
      title: 'scripted apply and legacy discovery removed',
      async run(ctx) {
        const hard: string[] = [];
        const exists = (rel: string) => ctx.fs.exists(join(ctx.root, rel));
        for (const f of ['src/mcp/apply.ts', 'src/mcp/applyAutoRouter.ts', 'src/apply/linkedin.ts', 'src/apply/external.ts', 'src/ats', 'src/mcp/discover.ts', 'src/discover', '.claude/agents/sender.md', '.claude/agents/discoverer.md']) {
          if (exists(f)) hard.push(`${f} still present`);
        }
        const read = (rel: string): string => {
          try { return exists(rel) ? ctx.fs.read(join(ctx.root, rel)) : ''; } catch { return ''; }
        };
        const files = ['.mcp.json', '.claude/settings.json', 'config/permission-sets.json', 'config/run-profiles.json', 'config/worker-tools.json'];
        for (const f of ctx.fs.list?.(join(ctx.root, 'config', 'runner')) ?? []) files.push(`config/runner/${f}`);
        for (const f of ctx.fs.list?.(join(ctx.root, '.claude', 'agents')) ?? []) files.push(`.claude/agents/${f}`);
        for (const f of files) {
          const text = read(f);
          if (text.includes('mcp__apply__')) hard.push(`mcp__apply__ in ${f}`);
          if (text.includes('mcp__discover__')) hard.push(`mcp__discover__ in ${f}`);
          if (/"(discoverer|sender)"/.test(text)) hard.push(`discoverer/sender in ${f}`);
        }
        if (hard.length) return fail(hard.slice(0, 4).join('; '), 'the scripted apply (8G-2) and the batch hunt (8G-1) were removed; delete the leftovers');
        return pass('no mcp__apply__, mcp__discover__, discoverer or sender left');
      },
    },
    {
      id: 'login_commands',
      title: 'owner login commands',
      async run(ctx) {
        const pkg = readJson<{ scripts?: Record<string, string> }>(ctx, 'package.json');
        if (!pkg) return skip('package.json not readable');
        const scripts = pkg.scripts ?? {};
        const missing = ['naukri:login', 'linkedin:login'].filter((s) => !(s in scripts));
        // A script that reads LINKEDIN_LOGIN_ACCOUNT is the retired account switch.
        const reads: string[] = [];
        for (const f of ctx.fs.list?.(join(ctx.root, 'scripts')) ?? []) {
          if (!/\.(ts|sh|cjs|mjs|js)$/.test(f)) continue;
          try { if (/LINKEDIN_LOGIN_ACCOUNT/.test(ctx.fs.read(join(ctx.root, 'scripts', f)))) reads.push(`scripts/${f}`); } catch { /* unreadable */ }
        }
        if (reads.length) return fail(`LINKEDIN_LOGIN_ACCOUNT is read in ${reads.join(', ')}`, 'the login commands take no account switch; remove the env read');
        if (missing.length) return fail(missing.map((s) => `npm script ${s} missing`).join('; '), 'add the login scripts back to package.json');
        return pass('naukri:login and linkedin:login exist; no LINKEDIN_LOGIN_ACCOUNT env read');
      },
    },
    {
      id: 'apply_limits',
      title: 'per-host apply caps',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const caps = APPLY_HOST_PLATFORM_IDS.map((id) => `${id}=${resolveHostCap(id, env).cap}`).join(', ');
        const warnings = hostCapWarnings(env);
        if (warnings.length) return warn(`${warnings.join('; ')} (effective: ${caps})`, 'set APPLY_MAX_PER_HOST between 1 and 50');
        return pass(`effective caps: ${caps}`);
      },
    },
    {
      id: 'browser_launch',
      title: 'browsers launch only through the shared launcher',
      async run(ctx) {
        let hits: Record<string, string[]>;
        try { hits = scanLaunches(ctx.root); } catch { return skip('source tree not readable'); }
        const legacy = legacyAllowlist(ctx.root);
        const stale = legacy.filter((f) => f.startsWith('src/apply/') || f.startsWith('src/ats/'));
        if (stale.length) return fail(`scripted-apply files still allowlisted: ${stale.join(', ')}`, 'remove them from LEGACY_LAUNCH_ALLOWLIST');
        const allowed = new Set([LAUNCH_HOME, ...legacy]);
        const bad = Object.keys(hits).filter((f) => !allowed.has(f));
        if (bad.length) return fail(`direct browser launch outside the shared launcher: ${bad.slice(0, 4).join(', ')}`, 'launch through src/webcore/launch.ts');
        return pass(legacy.length === 0 ? 'no direct launch outside src/linkedin/browser.ts' : `no direct launch outside src/linkedin/browser.ts and ${legacy.length} legacy file${legacy.length === 1 ? '' : 's'} (the list empties at the 8G-1 merge)`);
      },
    },
  ];
}
