// tests/setup-telegram-walkthrough.test.ts
// Plan 8F Task 5: the Telegram walkthrough, one case per row of the flow table.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState, type SetupMode } from '../src/setup/state.js';
import { telegramStep } from '../src/setup/steps/telegram.js';

const TOKEN = '1234567890:AAExampleTokenValue_abcdef';
const BAD = '9876543210:ZZBadTokenValueXYZ_12345';

function memFs(): SetupFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d) => void files.set(p, d),
    rename: (a, b) => {
      files.set(b, files.get(a) ?? '');
      files.delete(a);
    },
    chmod: () => undefined,
    remove: (p) => void files.delete(p),
    mkdirp: () => undefined,
    copy: () => undefined,
    list: () => [],
  };
}

function mk(opts: {
  mode?: SetupMode;
  script: ScriptItem[];
  files?: Record<string, string>;
  topics?: (boolean | undefined)[]; // successive getMe topics flags
  sendResults?: boolean[];
}) {
  const fs = memFs();
  for (const [k, v] of Object.entries(opts.files ?? {})) fs.files.set(k, v);
  const sio = scriptedIO(opts.script);
  const io = redactingIO(sio);
  const urls: string[] = [];
  let me = 0;
  let sends = 0;
  const run = (async (cmd: string, args: string[]) => ({
    stdout: '',
    stderr: '',
    code: cmd === 'tmux' && args[0] === 'has-session' ? 1 : 0,
  })) as unknown as SetupContext['run'];
  const fetchFn: SetupContext['fetch'] = async (url) => {
    urls.push(url);
    if (url.endsWith('/getMe')) {
      const ok = url.includes(TOKEN);
      const t = opts.topics?.[Math.min(me++, (opts.topics?.length ?? 1) - 1)];
      const result: Record<string, unknown> = { username: 'bot' };
      if (t !== undefined) result.has_topics_enabled = t;
      return { ok, status: ok ? 200 : 401, json: async () => ({ ok, result }) };
    }
    if (url.endsWith('/sendMessage')) {
      const r = opts.sendResults?.[Math.min(sends++, opts.sendResults.length - 1)] ?? true;
      return { ok: r, status: r ? 200 : 400, json: async () => ({ ok: r }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
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
    now: () => new Date('2026-10-15T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: 'proj/user-data/.setup-state.json',
    envPath: 'proj/.env',
    mode: opts.mode,
  };
  return { ctx, sio, fs, urls };
}

// Full happy path in order: choose now, botfather done, secret, topics done, getUpdates no,
// id, another no, arrived yes.
const HAPPY: ScriptItem[] = [
  { choose: 'now' },
  { confirm: true },
  { secret: TOKEN },
  { confirm: true },
  { confirm: false },
  { ask: '12345678' },
  { confirm: false },
  { confirm: true },
];

describe('telegram walkthrough', () => {
  it('row 1: later skips before any other prompt and writes nothing', async () => {
    const t = mk({ mode: 'terminal', script: [{ choose: 'later' }] });
    expect(await telegramStep.run(t.ctx)).toBe('skipped');
    expect(t.fs.files.has('proj/.env')).toBe(false);
    const out = t.sio.transcript.join('\n');
    expect(out).toContain('RECOMMENDED');
    expect(out).toContain('No phone control: you cannot start a hunt or ask for status from Telegram.');
    expect(out).toContain('No Telegram alerts, and email follow-ups cannot be approved, so none are sent.');
    t.sio.assertDone();
  });

  it('row 1: no skip offer when a token is already in .env', async () => {
    const t = mk({
      script: [{ confirm: true }, { confirm: true }, { confirm: true }, { confirm: true }, { confirm: true }],
      files: { 'proj/.env': `TELEGRAM_BOT_TOKEN=${TOKEN}\nALLOWED_USERS=12345678\n` },
    });
    await telegramStep.run(t.ctx);
    expect(t.sio.transcript.some((l) => l.startsWith('choose:'))).toBe(false);
  });

  it('rows 2 to 8: happy path in terminal mode prints coaching and writes .env', async () => {
    const t = mk({ mode: 'terminal', script: HAPPY });
    expect(await telegramStep.run(t.ctx)).toBe('done');
    const out = t.sio.transcript.join('\n');
    expect(out).toContain('password');
    expect(out).toContain('verified badge');
    expect(out).toContain('Mini App');
    expect(out).toContain('@userinfobot');
    expect(out).toContain('send /health to your bot');
    expect(t.fs.files.get('proj/.env')).toContain(`TELEGRAM_BOT_TOKEN=${TOKEN}`);
    expect(out).not.toContain(TOKEN);
    t.sio.assertDone();
  });

  it('agent mode asks the same prompts without the coaching blocks', async () => {
    const t = mk({ mode: 'agent', script: HAPPY });
    await telegramStep.run(t.ctx);
    const out = t.sio.transcript.join('\n');
    expect(out).not.toContain('verified badge');
    expect(out).not.toContain('@userinfobot');
    expect(out).not.toContain('send /health to your bot');
    t.sio.assertDone();
  });

  it('same answers give identical .env and state.steps in both modes', async () => {
    const a = mk({ mode: 'agent', script: HAPPY });
    const b = mk({ mode: 'terminal', script: HAPPY });
    await telegramStep.run(a.ctx);
    await telegramStep.run(b.ctx);
    expect(a.fs.files.get('proj/.env')).toBe(b.fs.files.get('proj/.env'));
    expect(a.ctx.state.steps).toEqual(b.ctx.state.steps);
    expect(a.ctx.state.answers).toEqual(b.ctx.state.answers);
  });

  it('row 2: BotFather re-explains on no, and skips after 3 no', async () => {
    const t = mk({
      mode: 'terminal',
      script: [{ choose: 'now' }, { confirm: false }, { confirm: false }, { confirm: true }, { secret: TOKEN }, { confirm: true }, { confirm: false }, { ask: '12345678' }, { confirm: false }, { confirm: true }],
    });
    await telegramStep.run(t.ctx);
    expect(t.sio.transcript.join('\n')).toContain('long token with a colon');
    const u = mk({
      script: [{ choose: 'now' }, { confirm: false }, { confirm: false }, { confirm: false }],
    });
    expect(await telegramStep.run(u.ctx)).toBe('skipped');
    expect(u.fs.files.has('proj/.env')).toBe(false);
  });

  it('row 3: a rejected token re-prompts once then fails with the fixed message, no token echo', async () => {
    const t = mk({
      script: [{ choose: 'now' }, { confirm: true }, { secret: BAD }, { secret: BAD }],
    });
    await expect(telegramStep.run(t.ctx)).rejects.toThrow('Telegram rejected that token');
    expect(t.sio.transcript.join('\n')).not.toContain(BAD);
    expect(t.fs.files.has('proj/.env')).toBe(false);
  });

  it('row 4: topics flag false re-asks, then true continues', async () => {
    const t = mk({
      mode: 'terminal',
      topics: [undefined, false, true], // first getMe is the token check
      script: [
        { choose: 'now' },
        { confirm: true },
        { secret: TOKEN },
        { confirm: true },
        { confirm: true },
        { confirm: false },
        { ask: '12345678' },
        { confirm: false },
        { confirm: true },
      ],
    });
    await telegramStep.run(t.ctx);
    expect(t.sio.transcript.join('\n')).toContain('topics are still off');
    expect(t.ctx.state.answers.telegram_topics).toBeUndefined();
    t.sio.assertDone();
  });

  it('row 4: three no answers offer continue-without-topics and record unconfirmed', async () => {
    const t = mk({
      mode: 'terminal',
      script: [
        { choose: 'now' },
        { confirm: true },
        { secret: TOKEN },
        { confirm: false },
        { confirm: false },
        { confirm: false },
        { confirm: false },
        { ask: '12345678' },
        { confirm: false },
        { confirm: true },
      ],
    });
    await telegramStep.run(t.ctx);
    expect(t.sio.transcript.join('\n')).toContain('label may differ');
    expect(t.ctx.state.answers.telegram_topics).toBe('unconfirmed');
  });

  it('row 7: test message failing twice then arriving', async () => {
    const t = mk({
      sendResults: [false, false, true],
      script: [...HAPPY.slice(0, 7), { confirm: true }],
    });
    expect(await telegramStep.run(t.ctx)).toBe('done');
    expect(t.urls.filter((u) => u.endsWith('/sendMessage'))).toHaveLength(3);
    expect(t.sio.transcript.join('\n')).toContain('press Start');
  });

  it('row 7: after 3 failures declining the warning finish throws, accepting keeps settings', async () => {
    const base = [...HAPPY.slice(0, 7)];
    const a = mk({ sendResults: [false], script: [...base, { confirm: false }] });
    await expect(telegramStep.run(a.ctx)).rejects.toThrow('Test message was not received');
    const b = mk({ sendResults: [false], script: [...base, { confirm: true }] });
    expect(await telegramStep.run(b.ctx)).toBe('done');
    expect(b.sio.transcript.join('\n')).toContain('warning');
  });

  it('transcript, state, urls-only token use', async () => {
    const t = mk({ mode: 'terminal', script: HAPPY });
    await telegramStep.run(t.ctx);
    expect(t.sio.transcript.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(t.ctx.state)).not.toContain(TOKEN);
  });
});

describe('modes are verbosity only (lint)', () => {
  it('no step in src/setup/steps branches on ctx.mode', () => {
    const dir = new URL('../src/setup/steps/', import.meta.url);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/\.mode\s*(===|!==|==|!=)/);
      expect(src, f).not.toMatch(/\bmode\s*(===|!==)\s*['"](agent|terminal)['"]/);
    }
  });
});
