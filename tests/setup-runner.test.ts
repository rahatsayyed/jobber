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
    const { ctx } = makeCtx([{ confirm: false }, { confirm: false }]);
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
    const first = makeCtx([{ confirm: false }, { confirm: false }], fs);
    expect(await runSetup(mk(true), first.ctx, { checks: [] })).toBe(1);
    expect(fs.exists(STATE_PATH)).toBe(true);
    const second = makeCtx([], fs);
    expect(await runSetup(mk(false), second.ctx, { checks: [] })).toBe(0);
    expect(ran).toEqual(['a', 'b', 'b']);
  });

  it('writes the state file mode 600 with no secret, and redacts error messages', async () => {
    const { ctx, sio, fs } = makeCtx([{ confirm: false }, { confirm: false }]);
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

describe('runSetup fix round 1', () => {
  it('declined retry then accepted skip records skipped, exit 0', async () => {
    const { ctx, sio } = makeCtx([{ confirm: false }, { confirm: true }]);
    const steps = [step('a', ['c1'], async () => 'done')];
    expect(await runSetup(steps, ctx, { checks: [check('c1', () => 'fail')] })).toBe(0);
    expect(ctx.state.steps.a.status).toBe('skipped');
    expect(sio.transcript).toContain('say: 0 done, 1 skipped, 0 failed');
  });

  it('thrown error: declined retry then accepted skip records skipped', async () => {
    const { ctx } = makeCtx([{ confirm: false }, { confirm: true }]);
    const steps = [
      step('a', [], async () => {
        throw new Error('x');
      }),
    ];
    expect(await runSetup(steps, ctx, { checks: [] })).toBe(0);
    expect(ctx.state.steps.a.status).toBe('skipped');
  });

  it('accepted retry then success', async () => {
    const { ctx } = makeCtx([{ confirm: true }]);
    let n = 0;
    const steps = [
      step('a', [], async () => {
        if (n++ === 0) throw new Error('once');
        return 'done';
      }),
    ];
    expect(await runSetup(steps, ctx, { checks: [] })).toBe(0);
    expect(n).toBe(2);
  });

  it('final line counts done, skipped and failed together', async () => {
    const { ctx, sio } = makeCtx([{ confirm: false }, { confirm: false }]);
    const steps = [
      step('a', [], async () => 'done'),
      step('b', [], async () => 'skipped'),
      step('c', ['c1'], async () => 'done'),
    ];
    expect(await runSetup(steps, ctx, { checks: [check('c1', () => 'fail')] })).toBe(1);
    expect(sio.transcript).toContain('say: 1 done, 1 skipped, 1 failed');
  });

  it('a warn check triggers the step to run', async () => {
    const { ctx } = makeCtx([]);
    let ran = 0;
    const steps = [step('a', ['c1'], async () => (ran++, 'done'))];
    await runSetup(steps, ctx, { checks: [check('c1', () => 'warn')] });
    expect(ran).toBe(1);
  });

  it('a throwing check is reported as fail without crashing', async () => {
    const { ctx, sio } = makeCtx([{ confirm: false }, { confirm: false }]);
    const bad: Check = {
      id: 'c1',
      title: 'c1',
      run: async () => {
        throw new Error('nope');
      },
    };
    const steps = [step('a', ['c1'], async () => 'done')];
    expect(await runSetup(steps, ctx, { checks: [bad] })).toBe(1);
    expect(sio.transcript.some((l) => l.includes('FAIL  c1'))).toBe(true);
  });

  it('state write is atomic: tmp then rename', async () => {
    const fs = memFs();
    const log: string[] = [];
    const w = fs.write.bind(fs);
    const r = fs.rename.bind(fs);
    fs.write = (p, d, m) => (log.push(`write ${p}`), w(p, d, m));
    fs.rename = (a, b) => (log.push(`rename ${a} ${b}`), r(a, b));
    const { ctx } = makeCtx([], fs);
    await runSetup([step('a', [], async () => 'done')], ctx, { checks: [] });
    expect(log[0]).toMatch(/^write proj.user-data..setup-state\.json\.tmp-/);
    expect(log[1]).toMatch(/^rename .*\.tmp-\d+ proj.user-data..setup-state\.json$/);
  });

  it('a skipped step with no checkIds is asked again next run', async () => {
    const fs = memFs();
    let ran = 0;
    const mk = () => [step('a', [], async () => (ran++, 'skipped'))];
    await runSetup(mk(), makeCtx([], fs).ctx, { checks: [] });
    await runSetup(mk(), makeCtx([], fs).ctx, { checks: [] });
    expect(ran).toBe(2);
  });

  it('unknown check id warns and runs the step', async () => {
    const { ctx, sio } = makeCtx([]);
    let ran = 0;
    const steps = [step('a', ['ghost'], async () => (ran++, 'done'))];
    expect(await runSetup(steps, ctx, { checks: [] })).toBe(0);
    expect(ran).toBe(1);
    expect(sio.transcript).toContain('say: unknown check id: ghost');
  });

  it('state write failure warns and continues; done timestamp kept', async () => {
    const fs = memFs();
    fs.write = () => {
      throw new Error('disk full');
    };
    const { ctx, sio } = makeCtx([], fs);
    expect(await runSetup([step('a', [], async () => 'done')], ctx, { checks: [] })).toBe(0);
    expect(sio.transcript).toContain('say: warning: could not save setup state');
    const at = ctx.state.steps.a.at;
    ctx.now = () => new Date('2030-01-01T00:00:00Z');
    await runSetup([step('a', ['c1'], async () => 'done')], ctx, {
      checks: [check('c1', () => 'pass')],
    });
    expect(ctx.state.steps.a.at).toBe(at);
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
