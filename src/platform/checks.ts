// src/platform/checks.ts
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { parseEnv } from './envFile.js';
import { hooksStatus, type HookSettings } from './ccgramHooks.js';
import { detectSet, type LocalSettings, type RawSets } from './permissions.js';
import { hasSession } from './tmux.js';
import { loadClassifier } from '../safety/classifierModel.js';
import { loadRegistry, resolveProfile, type ClassifierProfile, type ClassifierRegistry } from '../safety/classifierRegistry.js';
import { verifyProfile, type VerifyReport } from '../safety/modelFetch.js';
import { SMOKE_BENIGN, SMOKE_INJECTION } from '../safety/smoke.js';
import { screenUntrusted, SCREENED_SURFACES, callsScreen, type ScreenVerdict } from '../safety/screen.js';
import { loadProfiles } from './runner.js';
import { authDbPathFromEnv, isLoopbackBind, validateRunnerConfig } from '../web/env.js';
import { normaliseEmail } from '../dash/account.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

const envPath = (ctx: DoctorContext): string => join(ctx.root, '.env');
const settingsPath = (ctx: DoctorContext): string => join(ctx.root, '.claude', 'settings.local.json');

function readEnv(ctx: DoctorContext): Record<string, string> | null {
  return ctx.fs.exists(envPath(ctx)) ? parseEnv(ctx.fs.read(envPath(ctx))) : null;
}

function mergedEnv(ctx: DoctorContext): Record<string, string | undefined> {
  return { ...(readEnv(ctx) ?? {}), ...ctx.env }; // process env over .env, like the runner
}

type Pin = { ok: true; version: string; installed?: boolean } | { ok: false; problem: string };

function readPin(ctx: DoctorContext): Pin {
  const pinPath = join(ctx.root, 'config', 'ccgram.pin.json');
  if (!ctx.fs.exists(pinPath)) return { ok: false, problem: 'config/ccgram.pin.json is missing' };
  let pin: { version?: unknown; installed?: unknown };
  try {
    pin = JSON.parse(ctx.fs.read(pinPath));
  } catch {
    return { ok: false, problem: 'config/ccgram.pin.json is not valid JSON' };
  }
  if (typeof pin.version !== 'string' || !pin.version) return { ok: false, problem: 'pin file has no version' };
  return { ok: true, version: pin.version, installed: typeof pin.installed === 'boolean' ? pin.installed : undefined };
}

function lastToken(text: string): string {
  const parts = (text.split('\n')[0] ?? '').trim().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{10,}$/;
const SKIP_FLAG = /dangerously-skip-permissions|bypassPermissions/;

export interface RestrictedDeps {
  loadRegistry(path: string): ClassifierRegistry;
  verifyProfile(p: ClassifierProfile, root: string): Promise<VerifyReport>;
  smoke(p: ClassifierProfile, root: string): Promise<{ benign: number; injection: number }>;
  /** Runs screenUntrusted on the smoke strings with a live classifier; injected in tests. */
  screenSmoke(p: ClassifierProfile, root: string): Promise<{ injection: ScreenVerdict; benign: ScreenVerdict }>;
  smokeTimeoutMs: number;
  loadProfiles(policyPath: string): Record<string, { allow: string[] }>;
}

const MIN_CLAUDE = [2, 1, 295];

async function defaultSmoke(profile: ClassifierProfile, root: string): Promise<{ benign: number; injection: number }> {
  const { classifier } = await loadClassifier({ profile, root, allowUnfitted: true });
  const benign = (await classifier.classify(SMOKE_BENIGN)).score;
  const injection = (await classifier.classify(SMOKE_INJECTION)).score;
  return { benign, injection };
}

async function defaultScreenSmoke(profile: ClassifierProfile, root: string): Promise<{ injection: ScreenVerdict; benign: ScreenVerdict }> {
  const { classifier } = await loadClassifier({ profile, root, allowUnfitted: false });
  const injection = await screenUntrusted(SMOKE_INJECTION, 'read', { dryRun: false, classifier });
  const benign = await screenUntrusted(SMOKE_BENIGN, 'read', { dryRun: false, classifier });
  return { injection, benign };
}

type Ready = { ok: true; profile: ClassifierProfile; report: VerifyReport } | { ok: false; result: CheckResult };

const firstLine = (e: unknown): string => String((e as Error)?.message ?? 'unknown error').split('\n')[0].slice(0, 200);

function olderThan(found: number[], min: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (found[i] !== min[i]) return found[i] < min[i];
  }
  return false;
}

function serverNames(ctx: DoctorContext, rel: string[]): Set<string> {
  const p = join(ctx.root, ...rel);
  const names = new Set<string>();
  if (!ctx.fs.exists(p)) return names;
  const parsed = parseJson(ctx.fs.read(p));
  const servers = parsed.ok ? (parsed.value as { mcpServers?: Record<string, unknown> }).mcpServers : undefined;
  for (const k of Object.keys(servers ?? {})) names.add(k);
  return names;
}

export function restrictedChecks(deps: Partial<RestrictedDeps> = {}): Check[] {
  const d: RestrictedDeps = {
    loadRegistry: deps.loadRegistry ?? ((p) => loadRegistry(p)),
    verifyProfile: deps.verifyProfile ?? verifyProfile,
    smoke: deps.smoke ?? defaultSmoke,
    screenSmoke: deps.screenSmoke ?? defaultScreenSmoke,
    smokeTimeoutMs: deps.smokeTimeoutMs ?? 30_000,
    loadProfiles: deps.loadProfiles ?? ((p) => loadProfiles(p)),
  };
  // .env values win over the process environment; only CLASSIFIER_MODEL and DOCTOR_SKIP_SMOKE are read from it.
  const mergedEnv = (ctx: DoctorContext): Record<string, string | undefined> => ({ ...ctx.env, ...(readEnv(ctx) ?? {}) });

  // Steps 1 to 5 of the classifier checks, shared with the smoke check.
  async function ready(ctx: DoctorContext): Promise<Ready> {
    const env = mergedEnv(ctx);
    const id = (env.CLASSIFIER_MODEL ?? '').trim();
    if (!id) return { ok: false, result: fail('CLASSIFIER_MODEL is not set', 'set CLASSIFIER_MODEL in .env (see docs/classifier-models.md section 4)') };
    let profile: ClassifierProfile;
    try {
      profile = resolveProfile(d.loadRegistry(join(ctx.root, 'config', 'classifier-models.json')), env as NodeJS.ProcessEnv);
    } catch (e) {
      return { ok: false, result: fail(firstLine(e), 'check CLASSIFIER_MODEL against config/classifier-models.json') };
    }
    let report: VerifyReport;
    try {
      report = await d.verifyProfile(profile, ctx.root);
    } catch (e) {
      return { ok: false, result: fail(firstLine(e), `npm run models -- fetch ${id} (re-downloads corrupted files)`) };
    }
    const absent = Object.keys(report.observed_sha256).length === 0;
    if (absent && !profile.fetchable) {
      return {
        ok: false,
        result: fail(
          `profile ${id} is gated and its files are not in models/${id}`,
          profile.manual_steps?.[0] ?? 'see manual_steps in config/classifier-models.json',
        ),
      };
    }
    if (absent) return { ok: false, result: fail('model files are not downloaded', `npm run models -- fetch ${id}`) };
    if (!report.ok) {
      return { ok: false, result: fail(report.problems.join('; '), `npm run models -- fetch ${id} (re-downloads corrupted files)`) };
    }
    return { ok: true, profile, report };
  }

  return [
    {
      id: 'classifier_model',
      title: 'injection classifier model',
      async run(ctx) {
        const r = await ready(ctx);
        if (!r.ok) return r.result;
        const { profile, report } = r;
        const id = profile.id;
        if (report.unpinned.length > 0) {
          return warn(
            `${report.unpinned.length} files are verified by git blob id only`,
            `npm run models -- pin ${id}, then commit config/classifier-models.json`,
          );
        }
        const modelFile = profile.files.find((f) => f.role === 'model');
        const digest = modelFile ? report.observed_sha256[modelFile.local] : undefined;
        const fit = profile.fit;
        if (typeof fit.threshold !== 'number' || fit.model_sha256 !== digest) {
          return warn(
            `threshold not fitted for ${id}: sends are refused until it is`,
            `npm run classifier:fit -- --profile ${id} --write`,
          );
        }
        const held = fit.held_out;
        if (!held || typeof held.fpr !== 'number' || typeof held.tpr !== 'number') {
          return warn(`held-out fpr/tpr missing for ${id}`, `npm run classifier:fit -- --profile ${id} --write`);
        }
        return pass(`${id} (${profile.licence.id}): files match the pin; held-out fpr ${held.fpr}, tpr ${held.tpr}`);
      },
    },
    {
      id: 'classifier_smoke',
      title: 'injection classifier smoke inference',
      async run(ctx) {
        if (mergedEnv(ctx).DOCTOR_SKIP_SMOKE === '1') return warn('smoke test skipped (DOCTOR_SKIP_SMOKE=1)');
        const r = await ready(ctx);
        if (!r.ok) return warn('skipped: model not ready');
        const id = r.profile.id;
        if (r.report.unpinned.length > 0) {
          return warn('skipped: files not sha256-pinned', `npm run models -- pin ${id}, then commit config/classifier-models.json`);
        }
        const fix = `npm run models -- verify ${id}; if files verify, the profile labels or inputs are wrong`;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error('__timeout__')), d.smokeTimeoutMs);
          });
          const s = await Promise.race([d.smoke(r.profile, ctx.root), timeout]);
          const b = s.benign.toFixed(3);
          const i = s.injection.toFixed(3);
          return s.benign < 0.5 && s.injection >= 0.5
            ? pass(`${id}: benign ${b}, injection ${i}`)
            : fail(`smoke test: benign ${b}, injection ${i}`, fix);
        } catch (e) {
          const m = firstLine(e);
          return fail(m === '__timeout__' ? 'smoke test timed out after 30 s' : `smoke test failed: ${m}`, fix);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    },
    {
      id: 'classifier_wired',
      title: 'classifier wired into every untrusted-text surface',
      async run(ctx) {
        const env = mergedEnv(ctx);
        const live = env.SCHEDULER_DRY_RUN === 'false';
        // 2. every surface file must call the screen
        const bad: string[] = [];
        for (const s of SCREENED_SURFACES) {
          const p = join(ctx.root, s.file);
          if (!ctx.fs.exists(p)) {
            bad.push(`${s.id} (${s.file} missing)`);
            continue;
          }
          if (!callsScreen(ctx.fs.read(p))) bad.push(`${s.id} (${s.file})`);
        }
        if (bad.length) return fail(`surfaces not screened: ${bad.join(', ')}`, 'route the text through screenUntrusted (src/safety/screen.ts)');
        // 1. profile ready and fitted
        const degrade = (r: CheckResult): CheckResult => (r.status === 'fail' && !live ? { ...r, status: 'warn' } : r);
        const r = await ready(ctx);
        if (!r.ok) return degrade(r.result);
        const { profile, report } = r;
        const id = profile.id;
        const modelFile = profile.files.find((f) => f.role === 'model');
        const digest = modelFile ? report.observed_sha256[modelFile.local] : undefined;
        if (typeof profile.fit.threshold !== 'number' || profile.fit.model_sha256 !== digest) {
          const res = fail(`threshold not fitted for ${id}: screened sends are refused until it is`, `npm run classifier:fit -- --profile ${id} --write`);
          return degrade(res);
        }
        if (env.DOCTOR_SKIP_SMOKE === '1') return warn('wiring smoke skipped (DOCTOR_SKIP_SMOKE=1)');
        if (report.unpinned.length > 0) {
          return warn('skipped: files not sha256-pinned', `npm run models -- pin ${id}, then commit config/classifier-models.json`);
        }
        const fix = `npm run models -- verify ${id}; if files verify, check the profile threshold`;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error('__timeout__')), d.smokeTimeoutMs);
          });
          const s = await Promise.race([d.screenSmoke(profile, ctx.root), timeout]);
          if (!s.injection.blocked || s.injection.code !== 'injection_suspected') {
            return fail(`screen did not block the smoke injection (code ${s.injection.code})`, fix);
          }
          if (s.benign.blocked) return fail(`screen blocked the benign smoke text (code ${s.benign.code})`, fix);
          return pass(`${id}: screenUntrusted blocks the smoke injection and passes benign text`);
        } catch (e) {
          const m = firstLine(e);
          return fail(m === '__timeout__' ? 'wiring smoke timed out after 30 s' : `wiring smoke failed: ${m}`, fix);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    },
    {
      id: 'run_profiles',
      title: 'run profiles',
      async run(ctx) {
        let profiles: Record<string, { allow: string[] }>;
        try {
          profiles = d.loadProfiles(join(ctx.root, 'config', 'run-profiles.json'));
        } catch (e) {
          const msg = String((e as Error)?.message ?? 'unknown error').split('\n')[0];
          return fail(msg, 'fix config/run-profiles.json');
        }
        const wake = profiles.outreach_wake;
        if (!wake) return fail('profile outreach_wake is missing', 'restore config/run-profiles.json from git');
        const known = new Set([...serverNames(ctx, ['.mcp.json']), ...serverNames(ctx, ['config', 'runner', 'mcp.platform.json'])]);
        const unknown = [...new Set(wake.allow.map((t) => t.split('__')[1] ?? ''))].filter((s) => !known.has(s));
        return unknown.length
          ? warn(`outreach_wake allows tools of unconfigured server(s): ${unknown.join(', ')}`, 'add the server to config/runner/mcp.platform.json or drop the tool')
          : pass(`${Object.keys(profiles).length} profile(s) valid`);
      },
    },
    {
      id: 'restricted_hook',
      title: 'restricted-run tool allowlist hook',
      async run(ctx) {
        const hook = join(ctx.root, '.claude', 'hooks', 'tool-allowlist.cjs');
        if (!ctx.fs.exists(hook)) return fail('.claude/hooks/tool-allowlist.cjs is missing', 'restore it from git');
        const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } });
        const r = await ctx.run('node', [hook, 'outreach_wake'], { cwd: ctx.root, input: event, env: { HOOK_NO_LOG: '1' } });
        if (!/"deny"/.test(r.stdout)) {
          return fail('the hook did not deny a Bash event under outreach_wake', 'check .claude/hooks/tool-allowlist.cjs and config/run-profiles.json');
        }
        const v = await ctx.run('claude', ['--version']);
        const m = /(\d+)\.(\d+)\.(\d+)/.exec(v.stdout);
        const hint = 'upgrade Claude Code to 2.1.295 or later (hook onFailure: block)';
        if (v.code !== 0 || !m) return warn('Claude Code version could not be read', hint);
        if (olderThan([Number(m[1]), Number(m[2]), Number(m[3])], MIN_CLAUDE)) {
          return warn(`Claude Code ${m[0]} is older than 2.1.295`, hint);
        }
        return pass(`hook denies Bash; Claude Code ${m[0]}`);
      },
    },
  ];
}

export const ccgramChecks: Check[] = [
  {
    id: 'tmux',
    title: 'tmux installed',
    async run(ctx) {
      const r = await ctx.run('tmux', ['-V']);
      return r.code === 0 ? pass(r.stdout.trim()) : fail('tmux not found', 'brew install tmux');
    },
  },
  {
    id: 'ccgram-version',
    title: 'ccgram matches the pinned version',
    async run(ctx) {
      const pin = readPin(ctx);
      if (!pin.ok) return fail(pin.problem, 'restore config/ccgram.pin.json from git');
      const hint = `uv tool install --python 3.14 "ccgram==${pin.version}"`;
      const r = await ctx.run('ccgram', ['--version']);
      if (r.code !== 0) return fail('ccgram is not installed', hint);
      const installed = lastToken(r.stdout);
      return installed === pin.version
        ? pass(`pinned ${pin.version}`)
        : fail(`installed ${installed || 'unknown'} differs from pin ${pin.version}`, hint);
    },
  },
  {
    id: 'ccgram-pin-state',
    title: 'ccgram pin file install state',
    async run(ctx) {
      const pin = readPin(ctx);
      if (!pin.ok) return fail(pin.problem);
      return pin.installed === false
        ? warn('pin file says installed:false', 'after installing the pinned version, set installed:true in config/ccgram.pin.json')
        : pass('pin file does not mark ccgram as uninstalled');
    },
  },
  {
    id: 'upgrade-policy',
    title: 'ccgram upgrade policy',
    async run() {
      return pass(
        'the version pin is the only defense: never use the ccgram upgrade command or any Telegram upgrade handler; upgrade by editing the pin after review',
      );
    },
  },
  {
    id: 'ccgram-env',
    title: 'bridge credentials in the project .env',
    async run(ctx) {
      const env = readEnv(ctx);
      if (!env) return fail('.env is missing', 'copy .env.example to .env and fill it in');
      const mode = ctx.fs.mode(envPath(ctx));
      if (mode !== null && (mode & 0o077) !== 0) return fail('.env is readable by others', 'chmod 600 .env');
      if (!env.TELEGRAM_BOT_TOKEN) return fail('TELEGRAM_BOT_TOKEN is not set in .env');
      if (!TOKEN_SHAPE.test(env.TELEGRAM_BOT_TOKEN)) {
        return fail('TELEGRAM_BOT_TOKEN is not shaped like a bot token', 'paste the token from BotFather');
      }
      const ids = (env.ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return fail('ALLOWED_USERS is empty', 'set your numeric Telegram user ID');
      if (!ids.every((id) => /^\d+$/.test(id))) return fail('ALLOWED_USERS must be numeric IDs only');
      return pass(`token present, ${ids.length} allowed user(s)`);
    },
  },
  {
    id: 'single-credentials-file',
    title: 'credentials live only in the project .env',
    async run(ctx) {
      return ctx.fs.exists(join(ctx.root, '.ccgram', '.env'))
        ? fail('.ccgram/.env exists', 'move its keys into the project .env and delete it')
        : pass('no second .env');
    },
  },
  {
    id: 'ccgram-dir-mode',
    title: '.ccgram state dir is private',
    async run(ctx) {
      const dir = join(ctx.root, '.ccgram');
      if (!ctx.fs.exists(dir)) return pass('not created yet');
      const mode = ctx.fs.mode(dir);
      if (mode === null) return fail('mode could not be read', 'chmod 700 .ccgram');
      return (mode & 0o777) !== 0o700
        ? fail(`mode is ${(mode & 0o777).toString(8)}, expected 700`, 'chmod 700 .ccgram')
        : pass('mode 700');
    },
  },
  {
    id: 'no-skip-permissions',
    title: 'no skip-permissions flag anywhere',
    async run(ctx) {
      const env = readEnv(ctx) ?? {};
      const dir = join(ctx.root, 'scripts', 'ccgram');
      const names = ctx.fs.list ? ctx.fs.list(dir) : ['claude-session.sh'];
      const texts = [env.CCGRAM_CLAUDE_COMMAND ?? '', ctx.env.CCGRAM_CLAUDE_COMMAND ?? ''];
      for (const name of names) {
        const p = join(dir, name);
        if (ctx.fs.exists(p)) texts.push(ctx.fs.read(p));
      }
      return texts.some((t) => SKIP_FLAG.test(t))
        ? fail('a skip-permissions flag is configured', 'remove it from CCGRAM_CLAUDE_COMMAND and scripts/ccgram')
        : pass('none found');
    },
  },
  {
    id: 'optional-features-off',
    title: 'voice, LLM, TTS and Mini App are off',
    async run(ctx) {
      const env = readEnv(ctx) ?? {};
      const on = ['CCGRAM_WHISPER_PROVIDER', 'CCGRAM_LLM_PROVIDER', 'CCGRAM_TTS_PROVIDER', 'CCGRAM_MINIAPP_BASE_URL'].filter(
        (k) => (env[k] ?? '').trim() !== '',
      );
      return on.length ? fail(`enabled: ${on.join(', ')}`, 'unset these in .env') : pass('all unset');
    },
  },
  {
    id: 'project-hooks',
    title: 'ccgram hooks installed in the project',
    async run(ctx) {
      if (!ctx.fs.exists(settingsPath(ctx))) return warn('.claude/settings.local.json does not exist', 'run setup to install hooks');
      const parsed = parseJson(ctx.fs.read(settingsPath(ctx)));
      if (!parsed.ok) return fail('settings.local.json is invalid JSON', 'repair or remove .claude/settings.local.json');
      const status = hooksStatus(parsed.value as HookSettings);
      const missing = Object.entries(status).filter(([, ok]) => !ok).map(([e]) => e);
      return missing.length ? warn(`missing events: ${missing.join(', ')}`, 'run setup to install hooks') : pass('all nine events');
    },
  },
  {
    id: 'permission-set',
    title: 'permission set',
    async run(ctx) {
      const setsPath = join(ctx.root, 'config', 'permission-sets.json');
      if (!ctx.fs.exists(setsPath)) return fail('config/permission-sets.json is missing');
      if (!ctx.fs.exists(settingsPath(ctx))) return warn('no .claude/settings.local.json yet', 'run setup to choose a permission set');
      const settings = parseJson(ctx.fs.read(settingsPath(ctx)));
      if (!settings.ok) return fail('settings.local.json is invalid JSON', 'repair or remove .claude/settings.local.json');
      const sets = parseJson(ctx.fs.read(setsPath));
      if (!sets.ok) return fail('config/permission-sets.json is invalid JSON', 'restore it from git');
      const set = detectSet(settings.value as LocalSettings, sets.value as RawSets);
      if (set === 'custom') return warn('allow list matches no named set (custom)');
      if (set === 'full') return warn('full: every tool, including Gmail and LinkedIn send, is allowed');
      return pass(set);
    },
  },
  {
    id: 'gitignore',
    title: '.gitignore protects local files',
    async run(ctx) {
      const path = join(ctx.root, '.gitignore');
      const text = ctx.fs.exists(path) ? ctx.fs.read(path) : '';
      const need = ['.ccgram/', '.claude/settings.local.json', '.claude/settings.local.managed.json', '.env'];
      const lines = text.split('\n').map((l) => l.trim());
      const missing = need.filter((rule) => !lines.includes(rule));
      return missing.length ? fail(`missing rules: ${missing.join(', ')}`, 'add them to .gitignore') : pass('rules present');
    },
  },
  {
    id: 'daemon',
    title: 'ccgram is running',
    async run(ctx) {
      // Scripts read this from the process environment only and treat empty as unset.
      const raw = ctx.env.CCGRAM_DAEMON_SESSION;
      const name = raw === undefined || raw === '' ? 'ccgram-daemon' : raw;
      if (!/^[A-Za-z0-9_-]+$/.test(name) || name.startsWith('-')) {
        return fail('CCGRAM_DAEMON_SESSION is not a valid tmux session name', 'use letters, digits, _ and - only');
      }
      return (await hasSession(ctx.run, name))
        ? pass(`tmux session ${name} is up`)
        : warn('not running', 'bash scripts/ccgram/start.sh');
    },
  },
  {
    id: 'web',
    title: 'dashboard web server config',
    async run(ctx) {
      const r = validateRunnerConfig(mergedEnv(ctx), { accountStored: true });
      if (r.ok) return pass('port, bind and host values are valid');
      const problems = r.errors.filter((e) => e.scope === 'web').map((e) => e.message);
      return problems.length ? fail(problems.join('; '), 'fix the WEB_* values in .env') : pass('port, bind and host values are valid');
    },
  },
  {
    id: 'dashboard-login',
    title: 'dashboard login',
    async run(ctx) {
      const env = mergedEnv(ctx);
      const authRel = authDbPathFromEnv(env);
      const authPath = isAbsolute(authRel) ? authRel : join(ctx.root, authRel);
      const dirPath = dirname(authPath);
      const authExists = ctx.fs.exists(authPath);
      const configured =
        authExists ||
        ['WEB_OIDC_CLIENT_ID', 'WEB_OIDC_CLIENT_SECRET', 'WEB_OIDC_REDIRECT_URI', 'DASHBOARD_ALLOWED_EMAIL'].some(
          (k) => (env[k] ?? '').trim() !== '',
        );
      if (!configured) return pass('dashboard login is not configured (off)');

      const fails: string[] = [];
      const targets: (readonly [string, string])[] = [['auth file', authPath]];
      if (resolve(dirPath) !== resolve(ctx.root)) targets.unshift(['directory', dirPath]); // bare name: the repo root is not ours to police
      for (const [label, path] of targets) {
        const mode = ctx.fs.exists(path) ? ctx.fs.mode(path) : null;
        if (mode !== null && (mode & 0o077) !== 0) fails.push(`dashboard ${label} is accessible to group or others`);
      }
      const cfg = validateRunnerConfig(env, { accountStored: true });
      if (!cfg.ok) for (const e of cfg.errors) if (e.scope === 'oidc') fails.push(e.message);
      if (fails.length) {
        return fail(fails.join('; '), 'chmod 700 the .dashboard directory, chmod 600 auth.sqlite, and fix the WEB_OIDC_* values in .env');
      }

      const warns: string[] = [];
      let fix: string | undefined;
      const acct = authExists && ctx.authAccount ? ctx.authAccount(authPath) : null;
      if (!acct) {
        warns.push('no allowed account is stored');
        fix = 'run npm run dashboard -- allow <email>';
      } else {
        if (!acct.pinned) {
          warns.push('account is not pinned yet');
          fix = 'the first sign-in pins the account; do it now';
        }
        const wanted = normaliseEmail(env.DASHBOARD_ALLOWED_EMAIL ?? '');
        if (wanted !== null && wanted !== acct.email) {
          warns.push('stored account differs from DASHBOARD_ALLOWED_EMAIL');
          fix = fix ?? 'run npm run dashboard -- allow <email> to change the account, or fix DASHBOARD_ALLOWED_EMAIL';
        }
      }
      const bind = (env.WEB_BIND ?? '').trim() || '127.0.0.1';
      if (!isLoopbackBind(bind)) warns.push('WEB_BIND is not a loopback address');
      if ((env.WEB_TRUST_PROXY ?? '').trim().toLowerCase() === 'true' && (env.WEB_ALLOWED_HOSTS ?? '').trim() === '') {
        warns.push('WEB_TRUST_PROXY=true without WEB_ALLOWED_HOSTS');
      }
      if ((env.WEB_CHAT_ENABLED ?? '').trim().toLowerCase() === 'true') {
        let set: string = 'unknown';
        const setsP = join(ctx.root, 'config', 'permission-sets.json');
        if (ctx.fs.exists(settingsPath(ctx)) && ctx.fs.exists(setsP)) {
          const st = parseJson(ctx.fs.read(settingsPath(ctx)));
          const ss = parseJson(ctx.fs.read(setsP));
          if (st.ok && ss.ok) set = detectSet(st.value as LocalSettings, ss.value as RawSets);
        }
        if (set !== 'read_only') warns.push('WEB_CHAT_ENABLED=true while the permission set is not read_only');
      }
      return warns.length ? warn(warns.join('; '), fix) : pass('account pinned, files private, config valid');
    },
  },
];
