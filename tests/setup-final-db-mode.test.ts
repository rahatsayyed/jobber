// tests/setup-final-db-mode.test.ts
// I4 of the final 7B review: -wal/-shm sidecars are checked and the final step offers chmod 600.
import { describe, expect, it } from 'vitest';
import { setupToolingChecks } from '../src/platform/checksSetup.js';
import type { DoctorContext } from '../src/platform/doctor.js';
import { scriptedIO, type ScriptItem } from '../src/setup/io.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { finalStep } from '../src/setup/steps/final.js';

const R = '/proj';
const DB = `${R}/data.sqlite`;

function dctx(modes: Map<string, number>): DoctorContext {
  return {
    root: R,
    env: {},
    run: (async () => ({ stdout: '', code: 0 })) as never,
    fs: {
      exists: (p) => modes.has(p),
      read: () => {
        throw new Error('ENOENT');
      },
      mode: (p) => modes.get(p) ?? null,
      list: () => [],
    },
  };
}

describe('sqlite-file sidecars', () => {
  const check = setupToolingChecks.find((c) => c.id === 'sqlite-file')!;
  it('fails on a loose -wal with a chmod fix', async () => {
    const r = await check.run(dctx(new Map([[DB, 0o600], [`${DB}-wal`, 0o644]])));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('wal');
    expect(r.fix).toBe('chmod 600 data.sqlite-wal');
  });
  it('fails on a loose -shm and passes when all are 600', async () => {
    expect((await check.run(dctx(new Map([[DB, 0o600], [`${DB}-shm`, 0o666]])))).status).toBe('fail');
    expect((await check.run(dctx(new Map([[DB, 0o600], [`${DB}-wal`, 0o600], [`${DB}-shm`, 0o600]])))).status).toBe('pass');
  });
});

function finalCtx(script: ScriptItem[], modes: Map<string, number>) {
  const sio = scriptedIO(script);
  const chmods: [string, number][] = [];
  const fs = {
    chmod: (p: string, m: number) => {
      chmods.push([p, m]);
      modes.set(p, m);
    },
  } as unknown as SetupFs;
  const doctor = dctx(modes);
  const ctx = { io: sio, root: R, env: {}, fs, doctor, run: doctor.run } as unknown as SetupContext;
  return { ctx, sio, chmods };
}

describe('finalStep database mode', () => {
  it('offers chmod 600 for the db and sidecars and applies it on yes', async () => {
    const modes = new Map([[DB, 0o644], [`${DB}-wal`, 0o644]]);
    const { ctx, chmods, sio } = finalCtx([{ confirm: true }], modes);
    expect(await finalStep.run(ctx)).toBe('done');
    expect(chmods).toEqual([[DB, 0o600], [`${DB}-wal`, 0o600]]);
    expect(sio.transcript.join('\n')).toContain('Make data.sqlite owner-only (chmod 600)?');
    sio.assertDone();
  });
  it('changes nothing on no, and does not ask when already 600 or absent', async () => {
    const no = finalCtx([{ confirm: false }], new Map([[DB, 0o644]]));
    await finalStep.run(no.ctx);
    expect(no.chmods).toEqual([]);
    const ok = finalCtx([], new Map([[DB, 0o600]]));
    await finalStep.run(ok.ctx);
    const none = finalCtx([], new Map());
    await finalStep.run(none.ctx);
    ok.sio.assertDone();
  });
});
