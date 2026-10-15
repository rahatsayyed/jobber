// tests/platform-checks-bootstrap.test.ts
import { describe, expect, it } from 'vitest';
import { bootstrapChecks } from '../src/platform/checksBootstrap.js';
import type { DoctorContext } from '../src/platform/doctor.js';

function ctx(missing: string[]): DoctorContext {
  return {
    root: '/fake',
    env: { BOOTSTRAP_MODEL_PROFILE: 'nope' },
    run: async (cmd) => (missing.includes(cmd) ? { code: 127, stdout: '' } : { code: 0, stdout: cmd === 'node' ? 'v99.0.0' : `${cmd} 99.0.0` }),
    fs: {
      exists: (p) => !missing.includes(p.split('/').pop()!),
      read: (p) => (p.endsWith('ccgram.pin.json') ? '{"version":"99.0.0"}' : '{"engines":{"node":">=20"}}'),
      mode: () => null,
      list: () => [],
    },
  };
}
const check = (platform: 'darwin' | 'linux' | 'unsupported' = 'darwin') => bootstrapChecks({ platform })[0]!;

describe('bootstrap_complete', () => {
  it('unsupported platform warns', async () => {
    expect((await check('unsupported').run(ctx([]))).status).toBe('warn');
  });
  it('missing required fails with the bootstrap.sh fix', async () => {
    const r = await check().run(ctx(['tmux']));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('tmux');
    expect(r.fix).toBe('bash scripts/bootstrap.sh');
  });
  it('only optional missing warns naming them', async () => {
    const r = await check().run(ctx([]));
    // the nope profile cannot verify, so classifier-model is absent; required are present
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('classifier-model');
    expect(r.fix).toBe('npm run bootstrap');
  });
});
