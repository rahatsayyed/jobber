// src/platform/checks.ts
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { parseEnv } from './envFile.js';
import { detectSet, type LocalSettings, type RawSets } from './permissions.js';
import { assertName, JOBBER_TMUX_SESSION, listWindows } from './tmux.js';
import { loadClassifier } from '../safety/classifierModel.js';
import { loadRegistry, resolveProfile, type ClassifierProfile, type ClassifierRegistry } from '../safety/classifierRegistry.js';
import { verifyProfile, type VerifyReport } from '../safety/modelFetch.js';
import { SMOKE_BENIGN, SMOKE_INJECTION } from '../safety/smoke.js';
import { isDryRun } from '../safety/dryRun.js';
import { screenUntrusted, SCREENED_SURFACES, callsScreen, type ScreenVerdict } from '../safety/screen.js';
import { loadProfiles } from './runner.js';
import { authDbPathFromEnv, DEFAULT_GOOGLE_KEYS_PATH, isLoopbackBind, resolveAuthMode, validateRunnerConfig } from '../web/env.js';
import { loadDesktopKeys } from '../dash/desktopClient.js';
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
        const live = !isDryRun(env);
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

export const stackChecks: Check[] = [
  {
    id: 'tmux',
    title: 'tmux installed',
    async run(ctx) {
      const r = await ctx.run('tmux', ['-V']);
      return r.code === 0 ? pass(r.stdout.trim()) : fail('tmux not found', 'brew install tmux');
    },
  },
  {
    id: 'no-skip-permissions',
    title: 'no skip-permissions flag anywhere',
    async run(ctx) {
      const p = join(ctx.root, 'scripts', 'claude-session.sh');
      const texts: string[] = [];
      if (ctx.fs.exists(p)) texts.push(ctx.fs.read(p));
      return texts.some((t) => SKIP_FLAG.test(t))
        ? fail('a skip-permissions flag is configured', 'remove it from scripts/claude-session.sh')
        : pass('none found');
    },
  },
  {
    id: 'telegram-bridge',
    title: 'Telegram bridge (window bridge in the stack session)',
    async run(ctx) {
      const env = readEnv(ctx);
      if (!env) return fail('.env is missing', 'copy .env.example to .env and fill it in');
      const mode = ctx.fs.mode(envPath(ctx));
      if (mode !== null && (mode & 0o077) !== 0) return fail('.env is readable by others', 'chmod 600 .env');
      if (!env.TELEGRAM_BOT_TOKEN) return fail('TELEGRAM_BOT_TOKEN is not set in .env', 'npm run setup -- --step telegram');
      if (!TOKEN_SHAPE.test(env.TELEGRAM_BOT_TOKEN)) {
        return fail('TELEGRAM_BOT_TOKEN is not shaped like a bot token', 'paste the token from BotFather');
      }
      const ids = (env.ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return fail('ALLOWED_USERS is empty', 'set your numeric Telegram user ID');
      if (!ids.every((id) => /^[0-9]+$/.test(id))) return fail('ALLOWED_USERS must be numeric IDs only');
      const merged = mergedEnv(ctx);
      const session = (merged.STACK_TMUX_SESSION ?? '').trim() || JOBBER_TMUX_SESSION;
      try {
        assertName(session);
      } catch {
        return fail('STACK_TMUX_SESSION is not a valid tmux session name', 'use letters, digits, _ and - only');
      }
      const chat = (merged.TELEGRAM_CHAT_ID ?? '').trim();
      if (chat !== '' && !/^-?[0-9]{1,20}$/.test(chat)) {
        return warn('TELEGRAM_CHAT_ID is not a numeric chat id, topics cannot be used', 'set the forum group id (-100...), or clear it to use the private chat topics');
      }
      const up = (await listWindows(ctx.run, session)).some((w) => w.name === 'bridge');
      if (!up) return warn('bridge window is not running', 'npm run up');
      return chat === ''
        ? pass(`bridge running in ${session}, ${ids.length} allowed user(s), topics in the private chat (topics need Threaded Mode enabled for the bot in BotFather)`)
        : pass(`bridge running in ${session}, ${ids.length} allowed user(s), topics in the group ${chat} (the bot needs admin with can_manage_topics there)`);
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
      const need = ['.claude/settings.local.json', '.claude/settings.local.managed.json', '.env'];
      const lines = text.split('\n').map((l) => l.trim());
      const missing = need.filter((rule) => !lines.includes(rule));
      return missing.length ? fail(`missing rules: ${missing.join(', ')}`, 'add them to .gitignore') : pass('rules present');
    },
  },
  {
    id: 'web',
    title: 'dashboard web server config',
    async run(ctx) {
      const r = validateRunnerConfig(mergedEnv(ctx), { accountStored: true });
      const m = resolveAuthMode(mergedEnv(ctx));
      const okText = `port, bind and host values are valid (auth mode ${'mode' in m ? m.mode : 'unknown'})`;
      if (r.ok) return pass(okText);
      const problems = r.errors.filter((e) => e.scope === 'web').map((e) => e.message);
      return problems.length ? fail(problems.join('; '), 'fix the WEB_* values in .env') : pass(okText);
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
      const resolved = resolveAuthMode(env);
      if ('error' in resolved) return fail(resolved.error, 'set WEB_AUTH_MODE to token, google_desktop or oidc in .env');
      const mode = resolved.mode;
      const configured =
        authExists ||
        (env.WEB_AUTH_MODE ?? '').trim() !== '' ||
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
      const scope = mode === 'oidc' ? 'oidc' : mode === 'token' ? 'token' : 'google';
      if (!cfg.ok) for (const e of cfg.errors) if (e.scope === scope) fails.push(e.message);
      let failFix = 'chmod 700 the .dashboard directory, chmod 600 auth.sqlite, and fix the WEB_* values in .env';
      if (mode === 'google_desktop') {
        const keysRel = (env.WEB_GOOGLE_KEYS_PATH ?? '').trim() || (env.GMAIL_OAUTH_PATH ?? '').trim() || DEFAULT_GOOGLE_KEYS_PATH;
        const keysPath = isAbsolute(keysRel) ? keysRel : join(ctx.root, keysRel);
        const keys = ctx.fs.exists(keysPath)
          ? loadDesktopKeys(keysPath, (p) => ctx.fs.read(p))
          : ({ ok: false, reason: 'unreadable' } as const);
        if (!keys.ok) {
          fails.push(`Google keys file unusable (reason: ${keys.reason})`);
          failFix = 'download the Desktop client again (see docs/gmail-mcp-setup.md)';
        }
      }
      if (fails.length) return fail(`${mode} mode: ${fails.join('; ')}`, failFix);

      const warns: string[] = [];
      let fix: string | undefined;
      let tokenInfo = '';
      if (resolved.implicit) {
        warns.push('OIDC selected implicitly, set WEB_AUTH_MODE=oidc');
        fix = 'set WEB_AUTH_MODE=oidc in .env';
      }
      if (mode === 'token') {
        const t = authExists && ctx.authToken ? ctx.authToken(authPath) : null;
        if (!t || !t.set) {
          warns.push('no access token is set');
          fix = fix ?? 'npm run dashboard -- token';
        } else if (t.createdAt) {
          tokenInfo = ` (created ${t.createdAt.slice(0, 10)})`;
        }
      }
      const acct = mode !== 'token' && authExists && ctx.authAccount ? ctx.authAccount(authPath) : null;
      if (mode === 'token') {
        // token mode has no allowed account
      } else if (!acct) {
        warns.push('no allowed account is stored');
        fix = fix ?? 'run npm run dashboard -- allow <email>';
      } else {
        if (!acct.pinned) {
          warns.push(
            mode === 'google_desktop'
              ? 'Google sign-in is unverified until the first sign-in pins the account (owner check L2)'
              : 'account is not pinned yet',
          );
          fix = fix ?? 'the first sign-in pins the account; do it now';
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
      if (warns.length) return warn(`${mode} mode: ${warns.join('; ')}`, fix);
      return pass(mode === 'token' ? `token mode, token set${tokenInfo}` : `${mode} mode, account pinned, files private, config valid`);
    },
  },
];
