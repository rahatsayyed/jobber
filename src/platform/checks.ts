// src/platform/checks.ts
import { join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { parseEnv } from './envFile.js';
import { hooksStatus, type HookSettings } from './ccgramHooks.js';
import { detectSet, type RawSets } from './permissions.js';
import { hasSession } from './tmux.js';

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

const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{10,}$/;
const SKIP_FLAG = /dangerously-skip-permissions|bypassPermissions/;

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
      return mode !== null && (mode & 0o777) !== 0o700
        ? fail(`mode is ${(mode & 0o777).toString(8)}, expected 700`, 'chmod 700 .ccgram')
        : pass('mode 700');
    },
  },
  {
    id: 'no-skip-permissions',
    title: 'no skip-permissions flag anywhere',
    async run(ctx) {
      const env = readEnv(ctx) ?? {};
      const wrapper = join(ctx.root, 'scripts', 'ccgram', 'claude-session.sh');
      const texts = [
        env.CCGRAM_CLAUDE_COMMAND ?? '',
        ctx.env.CCGRAM_CLAUDE_COMMAND ?? '',
        ctx.fs.exists(wrapper) ? ctx.fs.read(wrapper) : '',
      ];
      return texts.some((t) => SKIP_FLAG.test(t))
        ? fail('a skip-permissions flag is configured', 'remove it from CCGRAM_CLAUDE_COMMAND and the wrapper')
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
      const status = hooksStatus(JSON.parse(ctx.fs.read(settingsPath(ctx))) as HookSettings);
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
      const set = detectSet(JSON.parse(ctx.fs.read(settingsPath(ctx))), JSON.parse(ctx.fs.read(setsPath)) as RawSets);
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
      return (await hasSession(ctx.run, 'ccgram-daemon'))
        ? pass('tmux session ccgram-daemon is up')
        : warn('not running', 'bash scripts/ccgram/start.sh');
    },
  },
];
