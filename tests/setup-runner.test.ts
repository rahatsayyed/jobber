// tests/setup-runner.test.ts
import { describe, expect, it } from 'vitest';
import type { Check, DoctorContext, Status } from '../src/platform/doctor.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import { runSetup, type SetupContext, type SetupFs, type SetupStep } from '../src/setup/runner.js';
import { assertNoSecretKeys, loadState, saveState } from '../src/setup/state.js';

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

const T0 = () => new Date('2026-10-14T00:00:00Z');
const STATE_PATH = 'proj/user-data/.setup-state.json';

function makeCtx(script: ScriptItem[], fs = memFs()) {
  const sio = scriptedIO(script);
  const io = redactingIO(sio);
  const ctx: SetupContext = {
    io,
    root: 'proj',
    env: {},
    fs,
    run: (async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as SetupContext['run'],
    spawnInteractive: async () => 0,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: T0,
    doctor: {} as DoctorContext,
    state: loadState(STATE_PATH, fs),
    statePath: STATE_PATH,
    envPath: 'proj/.env',
  };
  return { ctx, sio, fs };
}

function check(id: string, get: () => Status): Check {
  return { id, title: id, run: async () => ({ status: get(), detail: `${id} ${get()}` }) };
}

function step(id: string, checkIds: string[], run: () => Promise<'done' | 'skipped'>): SetupStep {
  return { id, title: `Title ${id}`, checkIds, run };
}

describe('runSetup', () => {
  it('skips a step whose checks pass and ignores skip statuses', async () => {
    const { ctx, sio } = makeCtx([]);
    let ran = 0;
    const steps = [step('a', ['c1', 'c2'], async () => (ran++, 'done'))];
    const checks = [check('c1', () => 'pass'), check('c2', () => 'skip')];
    expect(await runSetup(steps, ctx, { checks })).toBe(0);
    expect(ran).toBe(0);
    expect(sio.transcript).toContain('say: already done');
    expect(sio.transcript).toContain('say: 1 done, 0 skipped, 0 failed');
    expect(ctx.state.steps.a.status).toBe('done');
  });

  it('runs a step when checks fail, then re-checks', async () => {
    const { ctx, sio } = makeCtx([]);
    let ok = false;
    const steps = [step('a', ['c1'], async () => ((ok = true), 'done'))];
    const checks = [check('c1', () => (ok ? 'pass' : 'fail'))];
    expect(await runSetup(steps, ctx, { checks })).toBe(0);
    expect(ok).toBe(true);
    expect(sio.transcript.some((l) => l.includes('PASS  c1'))).toBe(true);
  });

  it('retries on a failing post-check and fails when declined', async () => {
    const { ctx } = makeCtx([{ confirm: false }]);
    const steps = [step('a', ['c1'], async () => 'done')];
    const checks = [check('c1', () => 'fail')];
    expect(await runSetup(steps, ctx, { checks })).toBe(1);
    expect(ctx.state.steps.a).toBeUndefined();
  });

  it('resumes after a crash at the first step without done', async () => {
    const fs = memFs();
    const ran: string[] = [];
    const mk = (boom: boolean): SetupStep[] => [
      step('a', [], async () => (ran.push('a'), 'done')),
      step('b', [], async () => {
        ran.push('b');
        if (boom) throw new Error('boom');
        return 'done';
      }),
    ];
    const first = makeCtx([{ confirm: false }], fs);
    expect(await runSetup(mk(true), first.ctx, { checks: [] })).toBe(1);
    expect(fs.exists(STATE_PATH)).toBe(true);
    const second = makeCtx([], fs);
    expect(await runSetup(mk(false), second.ctx, { checks: [] })).toBe(0);
    expect(ran).toEqual(['a', 'b', 'b']);
  });

  it('writes the state file mode 600 with no secret, and redacts error messages', async () => {
    const { ctx, sio, fs } = makeCtx([{ confirm: false }]);
    const steps = [
      step('tg', [], async () => {
        ctx.io.registerSecret('s3cr3t-value-xyz');
        ctx.state.answers.telegram_bot = 'ok';
        throw new Error('bad token s3cr3t-value-xyz');
      }),
    ];
    await runSetup(steps, ctx, { checks: [] });
    expect(sio.transcript.join('\n')).not.toContain('s3cr3t-value-xyz');
    expect(sio.transcript.join('\n')).toContain('step failed: bad token [hidden]');
    await runSetup([step('ok', [], async () => 'done')], ctx, { checks: [] });
    expect(fs.modes.get(STATE_PATH)).toBe(0o600);
    expect(fs.read(STATE_PATH)).not.toContain('s3cr3t-value-xyz');
    expect(fs.read(STATE_PATH)).toContain('telegram_bot');
  });

  it('unknown --step exits 2 listing ids', async () => {
    const { ctx, sio } = makeCtx([]);
    const steps = [step('a', [], async () => 'done'), step('b', [], async () => 'done')];
    expect(await runSetup(steps, ctx, { only: 'zzz', checks: [] })).toBe(2);
    expect(sio.transcript.join('\n')).toContain('a, b');
  });

  it('--redo reruns a passing step; --step runs just one', async () => {
    const { ctx } = makeCtx([]);
    const ran: string[] = [];
    const steps = [
      step('a', ['c1'], async () => (ran.push('a'), 'done')),
      step('b', [], async () => (ran.push('b'), 'done')),
    ];
    await runSetup(steps, ctx, { only: 'a', redo: true, checks: [check('c1', () => 'pass')] });
    expect(ran).toEqual(['a']);
  });
});

describe('state', () => {
  it('assertNoSecretKeys rejects secret-looking keys', () => {
    expect(() => assertNoSecretKeys({ telegram_token: 'x' })).toThrow();
    expect(() => assertNoSecretKeys({ WEB_OIDC_CLIENT_SECRET: 'x' })).toThrow();
    expect(() => assertNoSecretKeys({ api_key: 'x' })).toThrow();
    expect(() => assertNoSecretKeys({ telegram_bot: 'ok' })).not.toThrow();
  });
  it('saveState refuses secret keys; corrupt file loads empty', () => {
    const fs = memFs();
    expect(() =>
      saveState('s', { version: 1, steps: {}, answers: { password: 'x' } }, fs, T0),
    ).toThrow();
    fs.write('c', '{not json', 0o600);
    expect(loadState('c', fs)).toEqual({ version: 1, steps: {}, answers: {} });
    expect(loadState('missing', fs).steps).toEqual({});
  });
});
