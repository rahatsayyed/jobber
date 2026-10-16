// tests/setup-final-and-cli.test.ts
import { describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import { childEnv, ensureEnvFile, needTty, parseArgs } from '../src/setup/cli.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import { runSetup, type SetupContext, type SetupFs, type SetupStep } from '../src/setup/runner.js';
import { loadState } from '../src/setup/state.js';
import { dashboardStep, redirectUriProblem } from '../src/setup/steps/dashboard.js';
import { finalStep } from '../src/setup/steps/final.js';
import { ALL_STEPS } from '../src/setup/steps/index.js';

function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const modes = new Map<string, number>();
  const fs: SetupFs & { files: Map<string, string>; modes: Map<string, number> } = {
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
  return fs;
}

const CANARY = 'GOCSPX-canary-secret-value-123';
const ENV_TEXT = 'WEB_TOKEN=\nWEB_PORT=8787\n# keep me\nUNRELATED=1\n';

function makeCtx(script: ScriptItem[], seed: Record<string, string> = {}) {
  const fs = memFs({ 'proj/.env': ENV_TEXT, ...seed });
  const sio = scriptedIO(script);
  const io = redactingIO(sio);
  const spawns: { cmd: string; args: string[]; opts?: unknown }[] = [];
  const ctx: SetupContext = {
    io,
    root: 'proj',
    env: {},
    fs,
    run: (async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as SetupContext['run'],
    spawnInteractive: async (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return 0;
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: () => new Date('2026-10-14T00:00:00Z'),
    doctor: { root: 'proj', env: {}, run: (async () => ({ stdout: '', code: 0 })) as never, fs: { exists: () => false, read: () => '', mode: () => null } } as DoctorContext,
    state: loadState('proj/user-data/.setup-state.json', fs),
    statePath: 'proj/user-data/.setup-state.json',
    envPath: 'proj/.env',
  };
  return { ctx, sio, fs, spawns };
}

const WITH_DASH = { 'proj/scripts/dashboard.ts': '// stub' };

describe('dashboardStep', () => {
  it('is skipped when scripts/dashboard.ts is absent, after writing local settings', async () => {
    const { ctx, sio, fs } = makeCtx([]);
    expect(await dashboardStep.run(ctx)).toBe('pending');
    expect(sio.transcript.join('\n')).toContain('skipped until installed (plan 7C)');
    const env = fs.files.get('proj/.env') ?? '';
    expect(env).toContain('WEB_TMUX_SESSION=ccgram');
    expect(env).toContain('WEB_PORT=8787');
    expect(env).not.toMatch(/^WEB_TOKEN=.+/m);
    expect(env).toContain('# keep me');
  });

  const TOKEN_RE = /#token=|[A-Za-z0-9_-]{43}/;

  it('token path: one confirm, no ask, spawns the token CLI, no token anywhere', async () => {
    const { ctx, sio, fs, spawns } = makeCtx([{ choose: 'now' }, { confirm: true }], WITH_DASH);
    expect(await dashboardStep.run(ctx)).toBe('done');
    expect(fs.files.get('proj/.env')).toMatch(/^WEB_AUTH_MODE=token$/m);
    expect(spawns).toEqual([{ cmd: 'npx', args: ['tsx', 'scripts/dashboard.ts', 'token'], opts: undefined }]);
    expect(sio.transcript.join('\n')).not.toMatch(TOKEN_RE);
    expect(JSON.stringify(ctx.state)).not.toMatch(TOKEN_RE);
    sio.assertDone();
  });

  it('existing OIDC owner: nothing asked, mode oidc, nothing spawned', async () => {
    const env = 'WEB_PORT=8787\nWEB_OIDC_CLIENT_ID=cid\nWEB_OIDC_CLIENT_SECRET=sec\n';
    const { ctx, sio, fs, spawns } = makeCtx([], { ...WITH_DASH, 'proj/.env': env });
    expect(await dashboardStep.run(ctx)).toBe('done');
    expect(sio.transcript.join('\n')).toContain('Your OIDC sign-in is kept');
    expect(fs.files.get('proj/.env')).toMatch(/^WEB_AUTH_MODE=oidc$/m);
    expect(spawns).toHaveLength(0);
    sio.assertDone();
  });

  it('declining token and Google spawns nothing', async () => {
    const { ctx, spawns } = makeCtx([{ choose: 'now' }, { confirm: false }, { confirm: false }], WITH_DASH);
    expect(await dashboardStep.run(ctx)).toBe('pending');
    expect(spawns).toHaveLength(0);
  });

  it('google path: asks only for the email', async () => {
    const { ctx, sio, fs, spawns } = makeCtx(
      [{ choose: 'now' }, { confirm: false }, { confirm: true }, { ask: 'Owner@Example.com' }],
      WITH_DASH,
    );
    expect(await dashboardStep.run(ctx)).toBe('done');
    const env = fs.files.get('proj/.env') ?? '';
    expect(env).toMatch(/^WEB_AUTH_MODE=google_desktop$/m);
    expect(env).toContain('DASHBOARD_ALLOWED_EMAIL=owner@example.com');
    expect(spawns).toEqual([
      { cmd: 'npx', args: ['tsx', 'scripts/dashboard.ts', 'allow', 'owner@example.com'], opts: undefined },
    ]);
    expect(sio.transcript.join('\n')).not.toMatch(/client id|client secret/i);
    sio.assertDone();
  });

  it('generic token CLI failure: neutral message, skipped so the step resumes', async () => {
    const { ctx, sio } = makeCtx([{ choose: 'now' }, { confirm: true }], WITH_DASH);
    ctx.spawnInteractive = async () => 1;
    expect(await dashboardStep.run(ctx)).toBe('pending');
    const out = sio.transcript.join('\n');
    expect(out).toContain('did not finish (exit 1)');
    expect(out).not.toContain('token already set');
  });

  it('rerun with a token already set (exit 3): reports rotate and is done', async () => {
    const { ctx, sio } = makeCtx([{ choose: 'now' }, { confirm: true }], WITH_DASH);
    ctx.spawnInteractive = async () => 3;
    expect(await dashboardStep.run(ctx)).toBe('done');
    expect(sio.transcript.join('\n')).toContain('token already set, use rotate');
  });

  it('redirect URI rule', () => {
    expect(redirectUriProblem('https://x.example/auth/callback')).toBeNull();
    expect(redirectUriProblem('http://localhost:3000/auth/callback')).toBeNull();
    expect(redirectUriProblem('http://127.0.0.1/auth/callback')).not.toBeNull();
    expect(redirectUriProblem('http://127.0.0.1:1/auth/callback?x=1')).not.toBeNull();
  });
});

describe('finalStep', () => {
  it('prints a report and the three next commands, returns done, no secret', async () => {
    const { ctx, sio } = makeCtx([]);
    expect(await finalStep.run(ctx)).toBe('done');
    const out = sio.transcript.join('\n');
    expect(out).toContain('bash scripts/ccgram/start.sh');
    expect(out).toContain('/health');
    expect(out).toContain('/runhunt');
    expect(out).not.toContain(CANARY);
  });
});

describe('ALL_STEPS and runner wiring', () => {
  it('has the documented order', () => {
    expect(ALL_STEPS.map((s) => s.id)).toEqual([
      'prereqs', 'claude', 'telegram', 'gmail', 'apikeys', 'sessions', 'resume', 'profile', 'limits', 'access', 'classifier', 'dashboard', 'final',
    ]);
  });

  it('runs stubs in order and --step runs only one', async () => {
    const order: string[] = [];
    const stub = (id: string): SetupStep => ({
      id,
      title: id,
      checkIds: [],
      run: async () => {
        order.push(id);
        return 'done';
      },
    });
    const steps = ['a', 'b', 'c'].map(stub);
    const a = makeCtx([]);
    expect(await runSetup(steps, a.ctx, { checks: [] })).toBe(0);
    expect(order).toEqual(['a', 'b', 'c']);
    order.length = 0;
    const b = makeCtx([]);
    expect(await runSetup(steps, b.ctx, { only: 'b', checks: [] })).toBe(0);
    expect(order).toEqual(['b']);
  });
});

describe('runner with real steps', () => {
  it('dashboard step runs on a fresh state', async () => {
    const { ctx, sio } = makeCtx([]);
    const code = await runSetup([dashboardStep], ctx, { checks: [] });
    expect(code).toBe(0);
    expect(sio.transcript.join('\n')).toContain('skipped until installed (plan 7C)');
    expect(ctx.state.steps.dashboard?.status).toBeUndefined();
  });
  it('a pending result is never recorded as a skip and clears an earlier recorded skip', async () => {
    const { ctx } = makeCtx([]);
    ctx.state.steps.dashboard = { status: 'skipped', at: '2026-10-15T00:00:00Z' };
    const half = { id: 'dashboard', title: 'half done', checkIds: [], run: async () => 'pending' as const };
    expect(await runSetup([half], ctx, { checks: [] })).toBe(0);
    expect(ctx.state.steps.dashboard).toBeUndefined();
    const fresh = makeCtx([]);
    expect(await runSetup([half], fresh.ctx, { checks: [] })).toBe(0);
    expect(fresh.ctx.state.steps.dashboard).toBeUndefined();
    const deliberate = { ...half, run: async () => 'skipped' as const };
    expect(await runSetup([deliberate], fresh.ctx, { checks: [] })).toBe(0);
    expect(fresh.ctx.state.steps.dashboard?.status).toBe('skipped');
  });
  it('an always step runs every time and is not recorded', async () => {
    let n = 0;
    const st: SetupStep = { id: 'f', title: 'f', checkIds: [], always: true, run: async () => (n++, 'done') };
    const { ctx, sio } = makeCtx([]);
    ctx.state.steps.f = { status: 'done', at: 'x' };
    await runSetup([st], ctx, { checks: [] });
    await runSetup([st], ctx, { checks: [] });
    expect(n).toBe(2);
    expect(sio.transcript.join('\n')).toContain('0 done, 0 skipped, 0 failed');
    expect(ctx.state.steps.f?.at).toBe('x');
  });
  it('an always step that throws follows the retry path', async () => {
    let n = 0;
    const st: SetupStep = {
      id: 'f', title: 'f', checkIds: [], always: true,
      run: async () => {
        if (n++ === 0) throw new Error('boom');
        return 'done';
      },
    };
    const { ctx } = makeCtx([{ confirm: true }]);
    expect(await runSetup([st], ctx, { checks: [] })).toBe(0);
    expect(n).toBe(2);
  });
});

describe('cli helpers', () => {
  it('parseArgs', () => {
    expect(parseArgs([])).toEqual({ redo: false, list: false, help: false });
    expect(parseArgs(['--step', 'limits', '--redo'])).toMatchObject({ step: 'limits', redo: true });
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--step']).error).toBeDefined();
    expect(parseArgs(['--bogus']).error).toBeDefined();
  });
  it('needTty', () => {
    expect(needTty(true)).toBe(false);
    expect(needTty(false)).toBe(true);
    expect(needTty(undefined)).toBe(true);
    expect(needTty(true, false)).toBe(true);
    expect(needTty(true, true)).toBe(false);
  });
  it('childEnv keeps the allowlist and drops secrets', () => {
    const e = childEnv(
      {
        PATH: '/bin',
        HTTPS_PROXY: 'p',
        XAUTHORITY: '/x',
        XDG_CONFIG_HOME: '/c',
        XDG_DATA_HOME: '/d',
        XDG_CACHE_HOME: '/k',
        XDG_SESSION_TYPE: 'x11',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/b',
        PLAYWRIGHT_BROWSERS_PATH: '/pw',
        TELEGRAM_BOT_TOKEN: 'x',
        GMAIL_CLIENT_SECRET: 'y',
      },
      { EXTRA: '1' },
    );
    expect(e).toEqual({
      PATH: '/bin',
      HTTPS_PROXY: 'p',
      XAUTHORITY: '/x',
      XDG_CONFIG_HOME: '/c',
      XDG_DATA_HOME: '/d',
      XDG_CACHE_HOME: '/k',
      XDG_SESSION_TYPE: 'x11',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/b',
      PLAYWRIGHT_BROWSERS_PATH: '/pw',
      EXTRA: '1',
    });
  });
  it('ensureEnvFile creates .env mode 600 and never creates directories', () => {
    const fs = memFs({ 'p/.env.example': 'A=1\n' });
    let mk = 0;
    fs.mkdirp = () => void mk++;
    expect(ensureEnvFile(fs, 'p/.env', 'p/.env.example', () => new Date())).toBe(true);
    expect(fs.modes.get('p/.env')).toBe(0o600);
    expect(mk).toBe(0);
    expect(ensureEnvFile(fs, 'p/.env', 'p/.env.example', () => new Date())).toBe(false);
  });
});
