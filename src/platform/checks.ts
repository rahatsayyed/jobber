// src/platform/checks.ts
import { join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { parseEnv } from './envFile.js';
import { hooksStatus, type HookSettings } from './ccgramHooks.js';
import { detectSet, type LocalSettings, type RawSets } from './permissions.js';
import { hasSession } from './tmux.js';
import { loadPin, verifyModelFiles, type ClassifierPin } from '../safety/classifierModel.js';
import { loadProfiles } from './runner.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

const envPath = (ctx: DoctorContext): string => join(ctx.root, '.env');
const settingsPath = (ctx: DoctorContext): string => join(ctx.root, '.claude', 'settings.local.json');

function readEnv(ctx: DoctorContext): Record<string, string> | null {
  return ctx.fs.exists(envPath(ctx)) ? parseEnv(ctx.fs.read(envPath(ctx))) : null;
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
  loadPin(path: string): ClassifierPin;
  verify(dir: string, pin: ClassifierPin): Promise<{ ok: boolean; problems: string[] }>;
  loadProfiles(policyPath: string): Record<string, { allow: string[] }>;
}

const MIN_CLAUDE = [2, 1, 295];
const ZERO_DIGEST = /^0{64}$/;

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
    loadPin: deps.loadPin ?? loadPin,
    verify: deps.verify ?? ((dir, pin) => verifyModelFiles(dir, pin)),
    loadProfiles: deps.loadProfiles ?? ((p) => loadProfiles(p)),
  };
  return [
    {
      id: 'classifier_model',
      title: 'injection classifier model',
      async run(ctx) {
        const fixPin = 'npx tsx scripts/classifier/fit.ts --pin';
        let pin: ClassifierPin;
        try {
          pin = d.loadPin(join(ctx.root, 'config', 'classifier.pin.json'));
        } catch {
          return fail('config/classifier.pin.json is missing or invalid', 'restore it from git');
        }
        const entries = [pin.model, pin.tokenizer, pin.config, ...(pin.extra ?? [])];
        if (entries.some((e) => ZERO_DIGEST.test(e.sha256))) {
          return fail('model files are not pinned (placeholder digests)', fixPin);
        }
        const v = await d.verify(join(ctx.root, 'models', 'prompt-guard-2-22m'), pin);
        if (!v.ok) return fail(v.problems.join('; '), `place the pinned files in models/prompt-guard-2-22m, or re-pin: ${fixPin}`);
        const cfgPath = join(ctx.root, 'config', 'classifier.json');
        if (!ctx.fs.exists(cfgPath)) {
          return warn('config/classifier.json is missing: threshold not fitted', 'npm run classifier:fit -- --write');
        }
        const cfg = parseJson(ctx.fs.read(cfgPath));
        const held = cfg.ok ? (cfg.value as { held_out?: { fpr?: unknown; tpr?: unknown } }).held_out : undefined;
        if (!held || typeof held.fpr !== 'number' || typeof held.tpr !== 'number') {
          return warn('config/classifier.json has no held-out fpr/tpr', 'npm run classifier:fit -- --write');
        }
        return pass(`files match the pin; held-out fpr ${held.fpr}, tpr ${held.tpr}`);
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
    title: 'status web page token',
    async run(ctx) {
      const token = ctx.env.WEB_TOKEN ?? (readEnv(ctx) ?? {}).WEB_TOKEN ?? ''; // process env over .env, like scripts/web.ts
      if (token === '') return pass('WEB_TOKEN is unset: web page is off');
      return token.length < 24
        ? fail('WEB_TOKEN is shorter than 24 characters', 'generate one with openssl rand -hex 24')
        : pass('WEB_TOKEN is set');
    },
  },
];
