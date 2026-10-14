// tests/platform-doctor.test.ts
import { describe, it, expect } from 'vitest';
import { exitCode, formatReport, runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { ccgramChecks } from '../src/platform/checks.js';
import { parseEnv } from '../src/platform/envFile.js';
import { applySet } from '../src/platform/permissions.js';
import { mergeHooks } from '../src/platform/ccgramHooks.js';
import type { RawSets } from '../src/platform/permissions.js';

const sets: RawSets = {
  read_only: { allow: ['mcp__db__get_funnel'] },
  outreach_send: { extends: 'read_only', allow: ['mcp__gmail__send_email'] },
  full: { extends: 'outreach_send', allow: ['mcp__gmail'] },
};

interface Files {
  [path: string]: { text: string; mode?: number };
}

function ctxWith(
  files: Files,
  opts: { tmux?: boolean; session?: boolean; version?: string; env?: NodeJS.ProcessEnv } = {},
): DoctorContext {
  return {
    root: '/p',
    env: opts.env ?? {},
    run: async (cmd, args) => {
      if (cmd === 'tmux' && args[0] === '-V') return { stdout: 'tmux 3.4', code: opts.tmux === false ? 1 : 0 };
      if (cmd === 'tmux' && args[0] === 'has-session') return { stdout: '', code: opts.session ? 0 : 1 };
      if (cmd === 'ccgram') return { stdout: `ccgram ${opts.version ?? '1.2.3'}`, code: 0 };
      return { stdout: '', code: 1 };
    },
    fs: {
      exists: (p) => p in files,
      read: (p) => files[p].text,
      mode: (p) => (p in files ? (files[p].mode ?? 0o600) : null),
      list: (p) =>
        Object.keys(files)
          .filter((k) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'))
          .map((k) => k.slice(p.length + 1)),
    },
  };
}

const GOOD_ENV = 'TELEGRAM_BOT_TOKEN=123456:SECRET-TOKEN-VALUE\nALLOWED_USERS=111,222\nGMAIL_APP_PASSWORD=OTHER-SECRET-VALUE\n';
const goodFiles = (): Files => ({
  '/p/.env': { text: GOOD_ENV, mode: 0o600 },
  '/p/config/ccgram.pin.json': { text: JSON.stringify({ version: '1.2.3', installed: true }) },
  '/p/config/permission-sets.json': { text: JSON.stringify(sets) },
  '/p/.claude/settings.local.json': {
    text: JSON.stringify(mergeHooks(applySet({}, sets, 'read_only'), '/py/python')),
  },
  '/p/.gitignore': { text: '.ccgram/\n.env\n.claude/settings.local.json\n.claude/settings.local.managed.json\n' },
  '/p/scripts/ccgram/claude-session.sh': { text: '#!/usr/bin/env bash\nexec claude "$@"\n' },
});

const byId = async (ctx: DoctorContext) => {
  const results = await runChecks(ccgramChecks, ctx);
  return Object.fromEntries(results.map((r) => [r.id, r.result]));
};

describe('parseEnv', () => {
  it('parses keys, quotes and comments', () => {
    expect(parseEnv('# c\nA=1\nB="two words"\n\nC=\n')).toEqual({ A: '1', B: 'two words', C: '' });
  });
});

describe('ccgram checks', () => {
  it('passes a correct setup', async () => {
    const r = await byId(ctxWith(goodFiles(), { session: true }));
    for (const [id, result] of Object.entries(r)) expect(result.status, id).not.toBe('fail');
    expect(r['ccgram-env'].status).toBe('pass');
    expect(r['permission-set'].detail).toContain('read_only');
  });

  it('fails when tmux is missing', async () => {
    expect((await byId(ctxWith(goodFiles(), { tmux: false })))['tmux'].status).toBe('fail');
  });

  it('fails when the installed ccgram does not match the pin', async () => {
    expect((await byId(ctxWith(goodFiles(), { version: '9.9.9' })))['ccgram-version'].status).toBe('fail');
  });

  it('fails when .env is group or world readable, or the token or allowlist is bad', async () => {
    const loose = goodFiles();
    loose['/p/.env'] = { text: GOOD_ENV, mode: 0o644 };
    expect((await byId(ctxWith(loose)))['ccgram-env'].status).toBe('fail');
    const bad = goodFiles();
    bad['/p/.env'] = { text: 'TELEGRAM_BOT_TOKEN=abc\nALLOWED_USERS=bob\n', mode: 0o600 };
    expect((await byId(ctxWith(bad)))['ccgram-env'].status).toBe('fail');
    const empty = goodFiles();
    empty['/p/.env'] = { text: 'TELEGRAM_BOT_TOKEN=abc\nALLOWED_USERS=\n', mode: 0o600 };
    expect((await byId(ctxWith(empty)))['ccgram-env'].status).toBe('fail');
    const noToken = goodFiles();
    noToken['/p/.env'] = { text: 'ALLOWED_USERS=111\n', mode: 0o600 };
    expect((await byId(ctxWith(noToken)))['ccgram-env'].status).toBe('fail');
  });

  it('reports a second credentials file left in the ccgram state dir', async () => {
    const files = goodFiles();
    files['/p/.ccgram/.env'] = { text: 'TELEGRAM_BOT_TOKEN=x\n', mode: 0o600 };
    expect((await byId(ctxWith(files)))['single-credentials-file'].status).toBe('fail');
    expect((await byId(ctxWith(goodFiles())))['single-credentials-file'].status).toBe('pass');
  });

  it('fails on skip-permissions anywhere and on enabled optional features', async () => {
    const yolo = goodFiles();
    yolo['/p/.env'] = {
      text: GOOD_ENV + 'CCGRAM_CLAUDE_COMMAND=claude --dangerously-skip-permissions\n',
      mode: 0o600,
    };
    expect((await byId(ctxWith(yolo)))['no-skip-permissions'].status).toBe('fail');
    const voice = goodFiles();
    voice['/p/.env'] = { text: GOOD_ENV + 'CCGRAM_WHISPER_PROVIDER=openai\n', mode: 0o600 };
    expect((await byId(ctxWith(voice)))['optional-features-off'].status).toBe('fail');
  });

  it('warns when hooks are missing, the set is custom or full, or the daemon is stopped', async () => {
    const files = goodFiles();
    files['/p/.claude/settings.local.json'] = { text: JSON.stringify(applySet({}, sets, 'full')) };
    const r = await byId(ctxWith(files, { session: false }));
    expect(r['project-hooks'].status).toBe('warn');
    expect(r['permission-set'].status).toBe('warn');
    expect(r['daemon'].status).toBe('warn');
  });

  it('compares the version by the last token exactly, not by substring', async () => {
    const r = await byId(ctxWith(goodFiles(), { version: '11.2.34' }));
    expect(r['ccgram-version'].status).toBe('fail');
    expect(r['ccgram-version'].fix).toContain('1.2.3');
  });

  it('fails when ccgram is not installed and notes a pin that says installed:false', async () => {
    const files = goodFiles();
    files['/p/config/ccgram.pin.json'] = { text: JSON.stringify({ version: '1.2.3', installed: false }) };
    const ctx = ctxWith(files);
    const missing: DoctorContext = {
      ...ctx,
      run: async (cmd, args) => (cmd === 'ccgram' ? { stdout: '', code: 1 } : ctx.run(cmd, args)),
    };
    const r = await byId(missing);
    expect(r['ccgram-version'].status).toBe('fail');
    expect(r['ccgram-version'].fix).toBeTruthy();
    expect(r['ccgram-pin-state'].status).toBe('warn');
  });

  it('states that the pin is the only upgrade defense', async () => {
    const r = await byId(ctxWith(goodFiles()));
    expect(r['upgrade-policy'].detail).toMatch(/never/i);
  });

  it('fails when .ccgram is not mode 700', async () => {
    const files = goodFiles();
    files['/p/.ccgram'] = { text: '', mode: 0o755 };
    expect((await byId(ctxWith(files)))['ccgram-dir-mode'].status).toBe('fail');
    files['/p/.ccgram'] = { text: '', mode: 0o700 };
    expect((await byId(ctxWith(files)))['ccgram-dir-mode'].status).toBe('pass');
  });

  it('requires the managed settings file in .gitignore', async () => {
    const files = goodFiles();
    files['/p/.gitignore'] = { text: '.ccgram/\n.env\n.claude/settings.local.json\n' };
    expect((await byId(ctxWith(files)))['gitignore'].detail).toContain('managed');
  });

  it('fails on a skip-permissions flag in the process environment', async () => {
    const env = { CCGRAM_CLAUDE_COMMAND: 'claude --dangerously-skip-permissions' };
    expect((await byId(ctxWith(goodFiles(), { env })))['no-skip-permissions'].status).toBe('fail');
  });

  it('resolves the daemon session name from the environment and rejects bad names', async () => {
    const seen: string[] = [];
    const ctx = ctxWith(goodFiles(), { env: { CCGRAM_DAEMON_SESSION: 'my-daemon' } });
    const spy: DoctorContext = {
      ...ctx,
      run: async (cmd, args) => {
        if (args[0] === 'has-session') seen.push(args.join(' '));
        return ctx.run(cmd, args);
      },
    };
    const r = await byId(spy);
    expect(seen.join(' ')).toContain('my-daemon');
    expect(r['daemon'].detail).not.toContain('ccgram-daemon');
    const bad = await byId(ctxWith(goodFiles(), { env: { CCGRAM_DAEMON_SESSION: 'a b;rm' } }));
    expect(bad['daemon'].status).toBe('fail');
    expect(JSON.stringify(bad['daemon'])).not.toContain('a b;rm');
  });

  it('daemon session: leading dash fails with the fixed message, empty counts as unset', async () => {
    const dash = await byId(ctxWith(goodFiles(), { env: { CCGRAM_DAEMON_SESSION: '-evil' } }));
    expect(dash['daemon'].status).toBe('fail');
    expect(JSON.stringify(dash['daemon'])).toContain('not a valid tmux session name');
    expect(JSON.stringify(dash['daemon'])).not.toContain('-evil');
    const empty = await byId(ctxWith(goodFiles(), { env: { CCGRAM_DAEMON_SESSION: '' } }));
    expect(empty['daemon'].status).not.toBe('fail');
  });

  it('daemon session: ignores CCGRAM_DAEMON_SESSION from the project .env', async () => {
    const files = goodFiles();
    files['/p/.env'] = { text: GOOD_ENV + 'CCGRAM_DAEMON_SESSION=bad name;x\n' };
    const r = await byId(ctxWith(files));
    expect(r['daemon'].status).not.toBe('fail');
  });

  it('catches skip-permissions in any scripts/ccgram file and in an exported .env line', async () => {
    const files = goodFiles();
    files['/p/scripts/ccgram/run.sh'] = { text: 'claude --dangerously-skip-permissions\n' };
    expect((await byId(ctxWith(files)))['no-skip-permissions'].status).toBe('fail');
    const exp = goodFiles();
    exp['/p/.env'] = {
      text: GOOD_ENV + 'export CCGRAM_CLAUDE_COMMAND=claude --dangerously-skip-permissions\n',
      mode: 0o600,
    };
    expect((await byId(ctxWith(exp)))['no-skip-permissions'].status).toBe('fail');
    expect(parseEnv('export A=1\n')).toEqual({ A: '1' });
  });

  it('reports malformed settings JSON with a fixed message and fails closed on unknown dir mode', async () => {
    const files = goodFiles();
    files['/p/.claude/settings.local.json'] = { text: '{"secret": SECRET-TOKEN-VALUE' };
    const r = await byId(ctxWith(files));
    for (const id of ['project-hooks', 'permission-set']) {
      expect(r[id].detail).toBe('settings.local.json is invalid JSON');
    }
    const ctx = ctxWith(goodFiles());
    const nullMode: DoctorContext = {
      ...ctx,
      fs: { ...ctx.fs, exists: (p) => p === '/p/.ccgram' || ctx.fs.exists(p), mode: (p) => (p === '/p/.ccgram' ? null : ctx.fs.mode(p)) },
    };
    expect((await byId(nullMode))['ccgram-dir-mode'].status).toBe('fail');
  });

  it('crash path prints no error message', async () => {
    const boom = [{ id: 'x', title: 'X', run: async () => { throw new Error('SECRET-TOKEN-VALUE'); } }];
    const out = await runChecks(boom, ctxWith({}));
    expect(JSON.stringify(out)).not.toContain('SECRET-TOKEN-VALUE');
    expect(out[0].result.status).toBe('fail');
  });

  it('never leaks a synthetic token anywhere in the report', async () => {
    const token = '987654:ZZ-synthetic-token-QQ_1234567890';
    const files = goodFiles();
    files['/p/.env'] = { text: `TELEGRAM_BOT_TOKEN=${token}\nALLOWED_USERS=1\n`, mode: 0o644 };
    files['/p/.ccgram/.env'] = { text: `TELEGRAM_BOT_TOKEN=${token}\n` };
    const results = await runChecks(ccgramChecks, ctxWith(files, { env: { TELEGRAM_BOT_TOKEN: token } }));
    expect(formatReport(results)).not.toContain(token);
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it('fails when .gitignore lacks the required rules', async () => {
    const files = goodFiles();
    files['/p/.gitignore'] = { text: 'node_modules\n' };
    expect((await byId(ctxWith(files)))['gitignore'].status).toBe('fail');
  });

  it('never prints the token or any other secret value', async () => {
    const results = await runChecks(ccgramChecks, ctxWith(goodFiles(), { session: true }));
    for (const secret of ['SECRET-TOKEN-VALUE', 'OTHER-SECRET-VALUE']) {
      expect(formatReport(results)).not.toContain(secret);
      expect(JSON.stringify(results)).not.toContain(secret);
    }
  });

  it('turns a thrown error into a failed check, and exit code reflects failures', async () => {
    const ctx = ctxWith({});
    const results = await runChecks(ccgramChecks, ctx);
    expect(results.every((r) => r.result.status)).toBe(true);
    expect(exitCode(results)).toBe(1);
    expect(exitCode(await runChecks(ccgramChecks, ctxWith(goodFiles(), { session: true })))).toBe(0);
  });
});

describe('web check', () => {
  const runWeb = async (extra: string, env: NodeJS.ProcessEnv = {}) => {
    const files = goodFiles();
    files['/p/.env'] = { text: GOOD_ENV + extra, mode: 0o600 };
    return (await byId(ctxWith(files, { env })))['web'];
  };
  it('process env wins over .env in both directions', async () => {
    expect((await runWeb('WEB_TOKEN=short\n', { WEB_TOKEN: 'y'.repeat(30) })).status).toBe('pass');
    expect((await runWeb(`WEB_TOKEN=${'y'.repeat(30)}\n`, { WEB_TOKEN: 'short' })).status).toBe('fail');
  });
  it('passes when unset, fails when short, passes when long, never prints the token', async () => {
    expect((await runWeb('')).status).toBe('pass');
    const short = await runWeb('WEB_TOKEN=shortsecret\n');
    expect(short.status).toBe('fail');
    expect(JSON.stringify(short)).not.toContain('shortsecret');
    const ok = await runWeb(`WEB_TOKEN=${'z'.repeat(30)}\n`);
    expect(ok.status).toBe('pass');
    expect(JSON.stringify(ok)).not.toContain('zzzz');
  });
});
