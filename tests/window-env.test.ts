import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadManagerConfig, startWindow } from '../src/platform/manager.js';
import type { Run } from '../src/platform/tmux.js';
import { parseWindowFields } from '../src/platform/windowConfig.js';
import { buildWindowEnv, validateWindowEnvSpec, windowEnvLines } from '../src/platform/windowEnv.js';
import { renderWindowSettings } from '../src/platform/windowLaunch.js';
import { readWindowSession } from '../src/platform/windowSession.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const req = createRequire(import.meta.url);

const base = {
  HOME: '/home/x', PATH: '/usr/bin', TZ: 'Asia/Kolkata', TERM: 'xterm', LANG: 'en_US.UTF-8', EDITOR: 'vim',
  ANTHROPIC_API_KEY: 'sk-ant-secret', TELEGRAM_BOT_TOKEN: '123456:abc', ALLOWED_USERS: '1', IS_SANDBOX: '1',
  JOBBER_DRY_RUN: 'true', JOBBER_KILL: '0', JOBBER_FOO: 'x', SCHEDULER_RUN_ID: 'r1', CLAUDE_CODE_SKIP_THING: '1',
  SERPER_API_KEY: 'serper-secret', GMAIL_CLIENT_SECRET: 'g-secret', LINKEDIN_HEADLESS: 'true', LINKEDIN_SESSION_TOKEN: 'tok',
  EMAIL_MAX_PER_DAY: '5', OTHER: 'nope',
};

describe('window env allowlist', () => {
  it('keeps only the base, the dry-run flag, listed keys, prefix matches and markers', () => {
    const env = buildWindowEnv('mail', {
      env_keys: ['EMAIL_MAX_PER_DAY'],
      env_prefixes: ['LINKEDIN_'],
      env: { SEND_LIMIT_PER_RUN: '1', JOBBER_RUN_LANE: 'mail_drip' },
    }, base);
    expect(env).toEqual({
      HOME: '/home/x', PATH: '/usr/bin', TZ: 'Asia/Kolkata', TERM: 'xterm', LANG: 'en_US.UTF-8',
      JOBBER_DRY_RUN: 'true', JOBBER_KILL: '0', EMAIL_MAX_PER_DAY: '5', LINKEDIN_HEADLESS: 'true',
      SEND_LIMIT_PER_RUN: '1', JOBBER_RUN_LANE: 'mail_drip',
    });
  });

  it('never leaks secret-looking keys through a prefix, and never the always-dropped keys', () => {
    const env = buildWindowEnv('x', { env_prefixes: ['LINKEDIN_', 'SERPER_', 'GMAIL_'] }, base);
    expect(env.LINKEDIN_SESSION_TOKEN).toBeUndefined();
    expect(env.SERPER_API_KEY).toBeUndefined();
    expect(env.GMAIL_CLIENT_SECRET).toBeUndefined();
    for (const k of ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'ALLOWED_USERS', 'IS_SANDBOX', 'CLAUDE_CODE_SKIP_THING', 'JOBBER_FOO', 'SCHEDULER_RUN_ID', 'EDITOR', 'OTHER']) {
      expect(env[k], k).toBeUndefined();
    }
    // a key listed by name is an explicit owner choice and passes
    expect(buildWindowEnv('x', { env_keys: ['SERPER_API_KEY'] }, base).SERPER_API_KEY).toBe('serper-secret');
  });

  it('.env wins over the process env for listed keys and the dry-run flag', () => {
    const env = buildWindowEnv('x', { env_keys: ['EMAIL_MAX_PER_DAY'] }, base, { EMAIL_MAX_PER_DAY: '9', JOBBER_DRY_RUN: 'false' });
    expect(env.EMAIL_MAX_PER_DAY).toBe('9');
    expect(env.JOBBER_DRY_RUN).toBe('false');
  });

  it('skips values with a newline or NUL and prints sorted KEY=value lines', () => {
    const env = buildWindowEnv('x', { env_keys: ['EMAIL_MAX_PER_DAY', 'LINKEDIN_HEADLESS'] }, { ...base, EMAIL_MAX_PER_DAY: '1\n2' });
    expect(env.EMAIL_MAX_PER_DAY).toBeUndefined();
    expect(windowEnvLines({ B: '2', A: '1' })).toEqual(['A=1', 'B=2']);
  });

  it('refuses JOBBER_ and SCHEDULER_ keys, prefixes and markers (except JOBBER_RUN_LANE)', () => {
    expect(() => validateWindowEnvSpec('w', { env_keys: ['JOBBER_DRY_RUN'] })).toThrow(/may not list/);
    expect(() => validateWindowEnvSpec('w', { env_keys: ['SCHEDULER_RUN_ID'] })).toThrow();
    expect(() => validateWindowEnvSpec('w', { env_keys: ['TELEGRAM_BOT_TOKEN'] })).toThrow();
    expect(() => validateWindowEnvSpec('w', { env_keys: ['ANTHROPIC_API_KEY'] })).toThrow();
    expect(() => validateWindowEnvSpec('w', { env_keys: ['lower'] })).toThrow();
    expect(() => validateWindowEnvSpec('w', { env_prefixes: ['JOBBER_'] })).toThrow(/may not cover/);
    expect(() => validateWindowEnvSpec('w', { env_prefixes: ['JOB_'] })).not.toThrow();
    expect(() => validateWindowEnvSpec('w', { env_prefixes: ['X_'] })).toThrow();
    expect(() => validateWindowEnvSpec('w', { env: { JOBBER_DRY_RUN: 'false' } })).toThrow(/refused/);
    expect(() => validateWindowEnvSpec('w', { env: { JOBBER_KILL: '0' } })).toThrow(/refused/);
    expect(() => validateWindowEnvSpec('w', { env: { SCHEDULER_X: '1' } })).toThrow(/refused/);
    expect(() => validateWindowEnvSpec('w', { env: { SOME_TOKEN: '1' } })).toThrow(/refused/);
    expect(() => validateWindowEnvSpec('w', { env: { SEND_LIMIT_PER_RUN: '1 2' } })).toThrow(/invalid value/);
    expect(() => validateWindowEnvSpec('w', { env: { JOBBER_RUN_LANE: 'Bad Lane' } })).toThrow();
    expect(() => validateWindowEnvSpec('w', { env: { JOBBER_RUN_LANE: 'linkedin_drip', SEND_LIMIT_PER_RUN: '1' } })).not.toThrow();
    // buildWindowEnv validates again, so a hand-built spec cannot smuggle a key past the loader
    expect(() => buildWindowEnv('w', { env_keys: ['JOBBER_DRY_RUN'] }, base)).toThrow();
  });
});

describe('window config schema (config/manager-windows.json)', () => {
  const mk = (windows: unknown, prot = ['manager']) => JSON.stringify({ session: 'Jobber', protected: prot, windows });

  it('the shipped file has exactly the mail and linkedin worker windows and old entries load unchanged', () => {
    const shipped = loadManagerConfig(readFileSync(path.join(ROOT, 'config/manager-windows.json'), 'utf8'));
    expect(Object.keys(shipped.windows)).toEqual(['mail', 'linkedin', 'sources', 'pipeline', 'boards', 'apply']);
    for (const w of ['sources', 'pipeline', 'boards', 'apply']) {
      const c = shipped.windows[w];
      expect(c.kind).toBe('worker');
      expect(c.lane).toBe('wake');
      expect(c.env).toBeUndefined(); // no JOBBER_RUN_LANE: Easy Apply stays a drip-lane action
      expect(readFileSync(path.join(ROOT, c.role_prompt as string), 'utf8')).toMatch(/work item/i);
      expect([...(c.env_keys ?? []), ...(c.env_prefixes ?? [])].some((k) => /KEY|TOKEN|SECRET|PASSWORD/.test(k))).toBe(false);
    }
    const m = shipped.windows.mail;
    expect(m.kind).toBe('worker');
    expect(m.lane).toBe('mail');
    expect(m.role_prompt).toBe('config/windows/mail.md');
    expect(readFileSync(path.join(ROOT, m.role_prompt as string), 'utf8')).toMatch(/mail-operator/);
    // no secret-looking key or Telegram/scheduler key in the env allowlist
    expect(m.env_keys?.some((k) => /KEY|TOKEN|SECRET|PASSWORD/.test(k))).toBe(false);
    expect(m.env).toEqual({ JOBBER_RUN_LANE: 'mail', SEND_LIMIT_PER_RUN: '100000' });
    const old = loadManagerConfig(mk({ a: { argv: ['bash', 'x.sh'], description: 'd' } }));
    expect(old.windows.a).toEqual({ argv: ['bash', 'x.sh'], description: 'd' });
  });

  it('a worker window needs no argv and gets the worker launcher', () => {
    const c = loadManagerConfig(mk({
      mail: {
        kind: 'worker', role_prompt: 'config/windows/mail.md', lane: 'mail_drip', env_keys: ['EMAIL_MAX_PER_DAY'], env_prefixes: ['GMAIL_'],
        env: { JOBBER_RUN_LANE: 'mail_drip', SEND_LIMIT_PER_RUN: '1' },
      },
    }));
    expect(c.windows.mail.argv).toEqual(['bash', 'scripts/claude-window.sh', 'mail']);
    expect(c.windows.mail.kind).toBe('worker');
    expect(c.windows.mail.role_prompt).toBe('config/windows/mail.md');
    expect(c.windows.mail.lane).toBe('mail_drip');
  });

  it('rejects bad worker fields', () => {
    const w = (over: Record<string, unknown>) => mk({ mail: { kind: 'worker', ...over } });
    expect(() => loadManagerConfig(w({ kind: 'daemon' }))).toThrow(/kind/);
    expect(() => loadManagerConfig(w({ role_prompt: 'config/other/mail.md' }))).toThrow(/role_prompt/);
    expect(() => loadManagerConfig(w({ role_prompt: 'config/windows/../x.md' }))).toThrow(/role_prompt/);
    expect(() => loadManagerConfig(w({ lane: 'Bad Lane' }))).toThrow(/lane/);
    expect(() => loadManagerConfig(w({ env_keys: 'X' }))).toThrow(/env_keys/);
    expect(() => loadManagerConfig(w({ env_keys: ['JOBBER_KILL'] }))).toThrow();
    expect(() => loadManagerConfig(w({ env: { JOBBER_DRY_RUN: 'false' } }))).toThrow();
    expect(() => loadManagerConfig(w({ argv: ['bash', 'scripts/claude-session.sh'] }))).toThrow(/worker/);
    expect(() => loadManagerConfig(mk({ a: { argv: ['bash', 'x'], lane: 'mail_drip' } }))).toThrow(/kind is not worker/);
    expect(() => parseWindowFields('a', { kind: 'worker', env: [] })).toThrow(/env must be an object/);
  });

  it('startWindow uses claude-window.sh with --session-id for a worker window and records the session', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ww-root-'));
    try {
      const cfg = loadManagerConfig(mk({ mail: { kind: 'worker' } }));
      const calls: string[][] = [];
      const run: Run = async (_c, args) => {
        calls.push(args);
        return { stdout: '', code: 0 };
      };
      expect(await startWindow(run, cfg, {}, 'mail', root)).toBe('started');
      const nw = calls.find((c) => c[0] === 'new-window') as string[];
      const command = nw[nw.length - 1];
      const rec = readWindowSession(root, 'mail');
      expect(rec).not.toBeNull();
      expect(command).toBe(`'bash' 'scripts/claude-window.sh' 'mail' '--session-id' '${rec?.session_id}'`);
      expect(command).not.toMatch(/claude-session/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('per-window settings', () => {
  const s = renderWindowSettings('mail') as { permissions?: unknown; hooks: Record<string, { matcher?: string; hooks: { command: string; onFailure?: string }[] }[]> };
  const cmds = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));

  it('carries only hooks: kill switch and tamper guard, block-outside-project, settings-guard, prompt guard', () => {
    expect(s.permissions).toBeUndefined();
    expect(cmds.some((c) => c.includes('window-guard.cjs'))).toBe(true);
    expect(cmds.some((c) => c.includes('block-outside-project.cjs'))).toBe(true);
    expect(cmds.some((c) => c.includes('settings-guard.cjs'))).toBe(true);
    expect(cmds.some((c) => c.includes('tool-allowlist'))).toBe(false);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('prompt-secret-guard.cjs');
    for (const e of s.hooks.PreToolUse) for (const h of e.hooks) expect(h.onFailure).toBe('block');
  });

  it('the hook files the settings point at exist', () => {
    for (const f of ['window-guard.cjs', 'block-outside-project.cjs', 'settings-guard.cjs', 'prompt-secret-guard.cjs', 'kill-switch.cjs', 'tamper-guard.cjs']) {
      expect(() => readFileSync(path.join(ROOT, '.claude', 'hooks', f))).not.toThrow();
    }
  });
});

describe('window-guard hook', () => {
  const guard = req('../.claude/hooks/window-guard.cjs') as { decide: (e: unknown, o: { root: string; env: Record<string, string> }) => { allow: boolean; reason: string } };

  it('allows normal tools, denies everything under the kill switch, denies tamper targets', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wg-root-'));
    try {
      const o = { root, env: {} as Record<string, string> };
      expect(guard.decide({ tool_name: 'mcp__db__list_jobs', tool_input: {} }, o).allow).toBe(true);
      expect(guard.decide({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'README.md') } }, o).allow).toBe(true);
      expect(guard.decide({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'secrets', 'x.json') } }, o).allow).toBe(false);
      expect(guard.decide({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, o).allow).toBe(false);
      expect(guard.decide({ tool_name: 'mcp__gmail__send_email', tool_input: {} }, { root, env: { JOBBER_DRY_RUN: 'true' } }).allow).toBe(false);
      expect(guard.decide({ tool_name: 'mcp__db__list_jobs', tool_input: {} }, { root, env: { JOBBER_KILL: '1' } }).allow).toBe(false);
      mkdirSync(path.join(root, '.jobber'), { recursive: true });
      writeFileSync(path.join(root, '.jobber', 'STOP'), 'stop');
      expect(guard.decide({ tool_name: 'mcp__db__list_jobs', tool_input: {} }, o).allow).toBe(false);
      expect(guard.decide(null, o).allow).toBe(false);
      expect(guard.decide({ tool_input: {} }, o).allow).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('screens mcp__gmail__send_email arguments like the headless mail profile (attachments, secret-shaped paths)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wg-mail-'));
    try {
      const o = { root, env: {} as Record<string, string> };
      const send = (input: unknown) => guard.decide({ tool_name: 'mcp__gmail__send_email', tool_input: input }, o);
      expect(send({ to: ['a@b.example'], subject: 's', body: 'hello' }).allow).toBe(true);
      expect(send({ to: ['a@b.example'], subject: 's', body: 'see secrets/gmail-credentials.json' }).allow).toBe(false);
      expect(send({ to: ['a@b.example'], subject: 's', body: 'b', attachments: [path.join(root, 'secrets', 'x.pdf')] }).allow).toBe(false);
      expect(send({ to: ['a@b.example'], subject: 's', body: 'b', attachments: ['/etc/passwd'] }).allow).toBe(false);
      expect(send({ to: ['a@b.example'], subject: 's', body: 'b', attachments: 'x' }).allow).toBe(false);
      // a rendered resume PDF is the only allowed attachment
      mkdirSync(path.join(root, 'renderer', 'automation', 'job-1'), { recursive: true });
      const pdf = path.join(realpathSync(root), 'renderer', 'automation', 'job-1', 'resume.pdf');
      writeFileSync(pdf, 'x');
      expect(guard.decide({ tool_name: 'mcp__gmail__send_email', tool_input: { to: ['a@b.example'], subject: 's', body: 'b', attachments: [pdf] } }, { root: realpathSync(root), env: {} }).allow).toBe(true);
      // other gmail tools are not screened by this rule
      expect(guard.decide({ tool_name: 'mcp__gmail__search_emails', tool_input: { query: 'secrets/' } }, o).allow).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('as a command it denies on garbage input (fails closed)', () => {
    const r = spawnSync('node', [path.join(ROOT, '.claude/hooks/window-guard.cjs'), 'mail', '-'], { input: 'not json', encoding: 'utf8' });
    expect(r.stdout).toMatch(/"deny"/);
  });
});

describe('scripts/claude-window.sh refusals', () => {
  const script = path.join(ROOT, 'scripts', 'claude-window.sh');
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } });

  it('refuses permission-skipping and settings arguments before it starts anything', () => {
    for (const a of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode=bypassPermissions', '--settings', '--setting-sources=user']) {
      const r = run(['mail', a]);
      expect(r.status, a).toBe(1);
      expect(r.stderr).toMatch(/refusing/);
      expect(r.stderr).not.toContain(a);
    }
  });

  it('refuses IS_SANDBOX, CLAUDE_CODE skip variables, a bad window name and no window', () => {
    expect(run(['mail'], { IS_SANDBOX: '1' }).status).toBe(1);
    expect(run(['mail'], { CLAUDE_CODE_SKIP_PERMISSIONS: '1' }).status).toBe(1);
    expect(run(['bad name']).status).toBe(1);
    expect(run(['-x']).status).toBe(1);
    expect(run([]).status).toBe(1);
  });

  it('passes the documented flags and nothing that skips permissions (static check of the script)', () => {
    const t = readFileSync(script, 'utf8');
    expect(t).toMatch(/exec env -i .*"\$CLAUDE_BIN" "\$@" --settings "\$SETTINGS" --setting-sources project,local/);
    expect(t).toMatch(/unset TELEGRAM_BOT_TOKEN/);
    expect(t).toMatch(/scripts\/window-env\.ts/);
    expect(t).not.toMatch(/--permission-mode|dontAsk|--max-turns|--strict-mcp-config|--allowedTools|tool-allowlist/);
  });
});
