// tests/setup-steps-skip.test.ts
// Plan 8F task 6: skip offers and done-confirms for the gmail and dashboard steps.
import { describe, expect, it } from 'vitest';
import { setupChecks } from '../src/platform/checksSetup.js';
import type { DoctorContext } from '../src/platform/doctor.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState, type SetupMode } from '../src/setup/state.js';
import { dashboardStep } from '../src/setup/steps/dashboard.js';
import { gmailStep } from '../src/setup/steps/gmail.js';

const KEYS = 'proj/secrets/gcp-oauth.keys.json';
const CREDS = 'proj/secrets/gmail-credentials.json';
const GOOD_CREDS = JSON.stringify({ refresh_token: 'r' });

function mk(o: { script: ScriptItem[]; files?: Record<string, string>; mode?: SetupMode; spawnCode?: number }) {
  const store = new Map<string, string>(Object.entries(o.files ?? {}));
  const reads: string[] = [];
  const fs: SetupFs = {
    exists: (p) => store.has(p),
    read: (p) => {
      reads.push(p);
      if (p === KEYS || p === CREDS) throw new Error('step must not read secret files');
      const v = store.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d) => void store.set(p, d),
    rename: () => undefined,
    chmod: () => undefined,
    remove: () => undefined,
    mkdirp: () => undefined,
    copy: () => undefined,
    list: () => [],
  };
  const sio = scriptedIO(o.script);
  const spawns: { cmd: string; args: string[] }[] = [];
  const doctor: DoctorContext = {
    root: 'proj',
    env: {},
    run: (async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as DoctorContext['run'],
    fs: { exists: (p) => store.has(p), read: (p) => store.get(p) ?? '', mode: () => 0o600 },
    now: () => new Date('2026-10-15T00:00:00Z'),
  };
  const ctx: SetupContext = {
    io: redactingIO(sio),
    root: 'proj',
    env: {},
    fs,
    run: doctor.run,
    spawnInteractive: async (cmd, args) => {
      spawns.push({ cmd, args });
      return o.spawnCode ?? 0;
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: () => new Date('2026-10-15T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: 'proj/user-data/.setup-state.json',
    envPath: 'proj/.env',
    mode: o.mode,
  };
  return { ctx, sio, store, spawns, reads };
}

const CONFIRMS: ScriptItem[] = [{ confirm: true }, { confirm: true }, { confirm: true }];

describe('gmail skip and confirms', () => {
  it('later returns skipped and asks nothing else', async () => {
    const t = mk({ script: [{ choose: 'later' }] });
    expect(await gmailStep.run(t.ctx)).toBe('skipped');
    expect(t.sio.transcript.join('\n')).toContain('NEEDED FOR EMAIL OUTREACH');
    expect(t.spawns).toEqual([]);
    t.sio.assertDone();
  });

  it('a no re-explains with the file name rule, then done', async () => {
    const t = mk({
      mode: 'terminal',
      script: [
        { choose: 'now' },
        { confirm: true },
        { confirm: true },
        { confirm: false },
        { confirm: true },
        { confirm: false },
      ],
    });
    expect(await gmailStep.run(t.ctx)).toBe('pending');
    const out = t.sio.transcript.join('\n');
    expect(out).toContain('must be named exactly secrets/gcp-oauth.keys.json');
    expect(out).toContain('Console path');
    t.sio.assertDone();
  });

  it('three nos on a group give a clean skipped', async () => {
    const t = mk({ script: [{ choose: 'now' }, { confirm: false }, { confirm: false }, { confirm: false }] });
    expect(await gmailStep.run(t.ctx)).toBe('skipped');
    expect(t.spawns).toEqual([]);
    t.sio.assertDone();
  });

  it('missing gmail-oauth check returns skipped with a reason', async () => {
    const i = setupChecks.findIndex((c) => c.id === 'gmail-oauth');
    const [removed] = setupChecks.splice(i, 1);
    try {
      const t = mk({ script: [{ choose: 'now' }, ...CONFIRMS, { confirm: true }] });
      expect(await gmailStep.run(t.ctx)).toBe('pending');
      expect(t.sio.transcript.join('\n')).toContain('could not be verified');
    } finally {
      setupChecks.splice(i, 0, removed);
    }
  });

  it('verify pass says authorised and returns done', async () => {
    const t = mk({
      script: [{ choose: 'now' }, ...CONFIRMS, { confirm: true }],
      files: { [KEYS]: '{}', [CREDS]: GOOD_CREDS },
    });
    expect(await gmailStep.run(t.ctx)).toBe('done');
    expect(t.sio.transcript.join('\n')).toContain('Gmail is authorised on this machine');
    expect(t.reads).not.toContain(KEYS);
    expect(t.reads).not.toContain(CREDS);
  });

  it('verify warn re-explains and returns skipped', async () => {
    const t = mk({
      script: [{ choose: 'now' }, ...CONFIRMS, { confirm: true }],
      files: { [KEYS]: '{}', [CREDS]: '{}' },
    });
    expect(await gmailStep.run(t.ctx)).toBe('pending');
    expect(t.sio.transcript.join('\n')).toContain('Gmail is not authorised yet; run this step again');
  });
});

describe('dashboard skip', () => {
  const WITH = { 'proj/scripts/dashboard.ts': '// stub', 'proj/.env': 'UNRELATED=1\n' };

  it('later leaves .env untouched and returns skipped', async () => {
    const t = mk({ script: [{ choose: 'later' }], files: WITH });
    expect(await dashboardStep.run(t.ctx)).toBe('skipped');
    expect(t.store.get('proj/.env')).toBe('UNRELATED=1\n');
    expect(t.spawns).toEqual([]);
    expect(t.sio.transcript.join('\n')).toContain('/limits, /working, /health and npm run status still work.');
    t.sio.assertDone();
  });

  it('existing OIDC owner is not offered a skip', async () => {
    const env = 'WEB_OIDC_CLIENT_ID=cid\nWEB_OIDC_CLIENT_SECRET=sec\n';
    const t = mk({ script: [], files: { ...WITH, 'proj/.env': env } });
    expect(await dashboardStep.run(t.ctx)).toBe('done');
    t.sio.assertDone();
  });

  it('terminal explains the token and no secret reaches the transcript', async () => {
    const t = mk({ mode: 'terminal', script: [{ choose: 'now' }, { confirm: true }], files: WITH });
    expect(await dashboardStep.run(t.ctx)).toBe('done');
    const out = t.sio.transcript.join('\n');
    expect(out).toContain('hash of the token');
    expect(out).not.toMatch(/#token=|[A-Za-z0-9_-]{43}/);
  });
});

describe('mode parity', () => {
  it('gmail: identical .env text, state and spawns in both modes', async () => {
    const script: ScriptItem[] = [{ choose: 'now' }, ...CONFIRMS, { confirm: true }];
    const files = { [KEYS]: '{}', [CREDS]: GOOD_CREDS, 'proj/.env': 'A=1\n' };
    const a = mk({ mode: 'agent', script, files });
    const b = mk({ mode: 'terminal', script, files });
    expect(await gmailStep.run(a.ctx)).toBe(await gmailStep.run(b.ctx));
    expect(a.store.get('proj/.env')).toBe(b.store.get('proj/.env'));
    expect(a.ctx.state).toEqual(b.ctx.state);
    expect(a.spawns).toEqual(b.spawns);
  });

  it('dashboard: identical .env text and state in both modes', async () => {
    const script: ScriptItem[] = [{ choose: 'now' }, { confirm: true }];
    const files = { 'proj/scripts/dashboard.ts': '// stub', 'proj/.env': 'A=1\n' };
    const a = mk({ mode: 'agent', script, files });
    const b = mk({ mode: 'terminal', script, files });
    await dashboardStep.run(a.ctx);
    await dashboardStep.run(b.ctx);
    expect(a.store.get('proj/.env')).toBe(b.store.get('proj/.env'));
    expect(a.ctx.state).toEqual(b.ctx.state);
    expect(a.spawns).toEqual(b.spawns);
  });
});
