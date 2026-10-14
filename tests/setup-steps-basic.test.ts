// tests/setup-steps-basic.test.ts
import { describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';
import { claudeStep } from '../src/setup/steps/claude.js';
import { prereqsStep } from '../src/setup/steps/prereqs.js';
import { telegramStep } from '../src/setup/steps/telegram.js';

const TOKEN = '1234567890:AAExampleTokenValue_abcdef';
const BAD_TOKEN = '9876543210:ZZBadTokenValueXYZ_12345';

function memFs(): SetupFs & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    exists: (p) => files.has(p),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d, m) => {
      files.set(p, d);
      modes.set(p, m);
    },
    rename: (a, b) => {
      files.set(b, files.get(a) ?? '');
      modes.set(b, modes.get(a) ?? 0o644);
      files.delete(a);
      modes.delete(a);
    },
    chmod: (p, m) => void modes.set(p, m),
    remove: (p) => void files.delete(p),
    mkdirp: () => undefined,
    copy: () => undefined,
    list: () => [],
  };
}

type RunFn = SetupContext['run'];
interface Call {
  url: string;
  body?: string;
}

function setup(opts: {
  script: ScriptItem[];
  run?: (cmd: string, args: string[]) => { stdout: string; code: number };
  goodTokens?: string[];
  files?: Record<string, string>;
  updates?: unknown;
}) {
  const fs = memFs();
  for (const [k, v] of Object.entries(opts.files ?? {})) fs.files.set(k, v);
  const sio = scriptedIO(opts.script);
  const io = redactingIO(sio);
  const calls: Call[] = [];
  const runCalls: string[][] = [];
  const run = (async (cmd: string, args: string[]) => {
    runCalls.push([cmd, ...args]);
    if (opts.run) return { ...opts.run(cmd, args), stderr: '' };
    // default: no ccgram-daemon session, everything else succeeds
    const noSession = cmd === 'tmux' && args[0] === 'has-session';
    return { stdout: '', stderr: '', code: noSession ? 1 : 0 };
  }) as unknown as RunFn;
  const good = opts.goodTokens ?? [TOKEN];
  const fetchFn: SetupContext['fetch'] = async (url, init) => {
    calls.push({ url, body: init?.body });
    if (url.endsWith('/getMe')) {
      const ok = good.some((t) => url.includes(t));
      return { ok, status: ok ? 200 : 401, json: async () => ({ ok, result: { username: 'bot' } }) };
    }
    if (url.endsWith('/getUpdates')) {
      return { ok: true, status: 200, json: async () => opts.updates ?? { ok: true, result: [] } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const doctor: DoctorContext = {
    root: 'proj',
    env: {},
    run,
    fs: { exists: (p) => fs.exists(p), read: (p) => fs.read(p), mode: () => null },
  };
  const ctx: SetupContext = {
    io,
    root: 'proj',
    env: {},
    fs,
    run,
    spawnInteractive: async () => 0,
    fetch: fetchFn,
    now: () => new Date('2026-10-14T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: 'proj/user-data/.setup-state.json',
    envPath: 'proj/.env',
  };
  return { ctx, sio, fs, calls, runCalls };
}

const EXAMPLE = '# Telegram\nTELEGRAM_BOT_TOKEN=\n# ids\nALLOWED_USERS=\nOTHER=1\n';

describe('telegramStep', () => {
  it('writes token and ids to a new .env from .env.example, mode 600, token never exposed', async () => {
    const t = setup({
      script: [
        { secret: TOKEN },
        { confirm: false }, // read from getUpdates?
        { ask: '12345678' },
        { confirm: false }, // another person?
        { confirm: true }, // message arrived
      ],
      files: { 'proj/.env.example': EXAMPLE },
    });
    expect(await telegramStep.run(t.ctx)).toBe('done');
    const env = t.fs.files.get('proj/.env') ?? '';
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${TOKEN}`);
    expect(env).toContain('ALLOWED_USERS=12345678');
    expect(env).toContain('# Telegram');
    expect(env).toContain('OTHER=1');
    expect(t.fs.modes.get('proj/.env')).toBe(0o600);
    expect(t.sio.transcript.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(t.ctx.state)).not.toContain(TOKEN);
    const send = t.calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(JSON.parse(send?.body ?? '{}')).toEqual({
      chat_id: '12345678',
      text: 'Jobber setup: test message',
    });
    expect(t.runCalls.every((c) => !c.join(' ').includes(TOKEN))).toBe(true);
    expect(t.sio.transcript.some((l) => l.includes('scripts/ccgram/start.sh'))).toBe(true);
    t.sio.assertDone();
  });

  it('re-prompts on a bad token shape', async () => {
    const t = setup({
      script: [
        { secret: 'nope' },
        { secret: TOKEN },
        { confirm: false },
        { ask: '12345678' },
        { confirm: false },
        { confirm: true },
      ],
    });
    await telegramStep.run(t.ctx);
    expect(t.sio.transcript.some((l) => l.startsWith('invalid:'))).toBe(true);
    expect(t.fs.files.get('proj/.env')).toContain(TOKEN);
  });

  it('getMe failure leaves .env untouched and prints only the fixed message', async () => {
    const t = setup({
      script: [{ secret: BAD_TOKEN }],
      files: { 'proj/.env': 'TELEGRAM_BOT_TOKEN=\n' },
    });
    await expect(telegramStep.run(t.ctx)).rejects.toThrow('Telegram rejected that token');
    expect(t.fs.files.get('proj/.env')).toBe('TELEGRAM_BOT_TOKEN=\n');
    expect(t.sio.transcript.join('\n')).not.toContain(BAD_TOKEN);
    expect(t.calls.some((c) => c.url.endsWith('/sendMessage'))).toBe(false);
  });

  it('keeps an existing working token and ids without rewriting .env', async () => {
    const env = `TELEGRAM_BOT_TOKEN=${TOKEN}\nALLOWED_USERS=12345678\n`;
    const t = setup({
      script: [{ confirm: true }, { confirm: true }, { confirm: true }],
      files: { 'proj/.env': env },
    });
    expect(await telegramStep.run(t.ctx)).toBe('done');
    expect(t.fs.files.get('proj/.env')).toBe(env);
    expect([...t.fs.files.keys()].some((k) => k.includes('.bak-'))).toBe(false);
    expect(t.sio.transcript.join('\n')).not.toContain(TOKEN);
    t.sio.assertDone();
  });

  it('does not call getUpdates and does not offer it when the daemon session exists', async () => {
    const t = setup({
      script: [{ secret: TOKEN }, { ask: '12345678' }, { confirm: false }, { confirm: true }],
      run: (cmd, args) => ({ stdout: '', code: cmd === 'tmux' && args[0] === 'has-session' ? 0 : 1 }),
    });
    await telegramStep.run(t.ctx);
    expect(t.calls.some((c) => c.url.endsWith('/getUpdates'))).toBe(false);
    t.sio.assertDone();
  });

  it('reads the ID from getUpdates when the daemon is down and the user agrees', async () => {
    const t = setup({
      script: [
        { secret: TOKEN },
        { confirm: true },
        { pause: true },
        { confirm: false },
        { confirm: true },
      ],
      run: () => ({ stdout: '', code: 1 }),
      updates: { ok: true, result: [{ message: { from: { id: 55555555 } } }] },
    });
    await telegramStep.run(t.ctx);
    expect(t.fs.files.get('proj/.env')).toContain('ALLOWED_USERS=55555555');
    expect(t.calls.some((c) => c.url.endsWith('/getUpdates'))).toBe(true);
  });

  it('requires a second confirm and warns before adding another ID', async () => {
    const t = setup({
      script: [
        { secret: TOKEN },
        { confirm: false },
        { ask: '12345678' },
        { confirm: true },
        { confirm: true },
        { ask: '87654321' },
        { confirm: false },
        { confirm: true },
      ],
    });
    await telegramStep.run(t.ctx);
    expect(t.sio.transcript.some((l) => l.includes('every allowed ID can drive Claude'))).toBe(true);
    expect(t.fs.files.get('proj/.env')).toContain('ALLOWED_USERS=12345678,87654321');
  });

  it('fails with a how-to when the test message did not arrive', async () => {
    const t = setup({
      script: [{ secret: TOKEN }, { confirm: false }, { ask: '12345678' }, { confirm: false }, { confirm: false }],
    });
    await expect(telegramStep.run(t.ctx)).rejects.toThrow('Test message was not received');
    expect(t.sio.transcript.some((l) => l.includes('press Start'))).toBe(true);
  });
});

describe('claudeStep', () => {
  it('done immediately when claude auth status exits 0', async () => {
    const t = setup({ script: [], run: () => ({ stdout: 'claude 2.0', code: 0 }) });
    expect(await claudeStep.run(t.ctx)).toBe('done');
    expect(t.runCalls.some((c) => c.join(' ') === 'claude auth status')).toBe(true);
    expect(t.runCalls.some((c) => c.includes('-p'))).toBe(false);
  });

  it('prints the install pointer when the CLI is missing, then gives up after three rounds', async () => {
    const t = setup({
      script: [{ pause: true }, { pause: true }, { pause: true }],
      run: () => ({ stdout: '', code: 1 }),
    });
    await expect(claudeStep.run(t.ctx)).rejects.toThrow('not logged in');
    expect(t.sio.transcript).toContain('say: Install Claude Code, then run: claude');
  });

  it('asks the user to log in, then passes after the recheck', async () => {
    let status = 1;
    const t = setup({
      script: [{ pause: true }],
      run: (_c, args) => {
        if (args[0] === 'auth') {
          const code = status;
          status = 0;
          return { stdout: '', code };
        }
        return { stdout: 'v', code: 0 };
      },
    });
    expect(await claudeStep.run(t.ctx)).toBe('done');
    expect(t.sio.transcript.some((l) => l.includes('Run "claude" in another terminal'))).toBe(true);
  });
});

describe('prereqsStep', () => {
  it('prints failing fixes verbatim, pauses between rounds (max three), never installs', async () => {
    const t = setup({
      script: [{ pause: true }, { pause: true }],
      run: (cmd) => ({ stdout: 'x', code: cmd === 'tmux' ? 1 : 0 }),
    });
    await prereqsStep.run(t.ctx);
    expect(t.sio.transcript.some((l) => l.includes('fix:'))).toBe(true);
    expect(t.sio.transcript.some((l) => l.startsWith('pause: Run the commands above'))).toBe(true);
    expect(t.sio.transcript.filter((l) => l.startsWith('pause:')).length).toBe(2);
    // never runs installers
    expect(t.runCalls.some((c) => c[0] === 'brew' || c[0] === 'npm' || c[0] === 'uv')).toBe(false);
  });
});
