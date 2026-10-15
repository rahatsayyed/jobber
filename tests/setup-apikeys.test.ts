// tests/setup-apikeys.test.ts
// Plan 8F Task 7: the optional API keys step (Adzuna, Serper, Hunter).
import { describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState, type SetupMode } from '../src/setup/state.js';
import { apikeysStep } from '../src/setup/steps/apikeys.js';
import { ALL_STEPS } from '../src/setup/steps/index.js';

const ADZ_ID = 'adzid-synthetic-1111';
const ADZ_KEY = 'adzkey-synthetic-2222aaaa';
const SERP = 'serper-synthetic-3333bbbb';
const HUNT = 'hunter-synthetic-4444cccc';

function mk(o: {
  script: ScriptItem[];
  env?: string;
  mode?: SetupMode;
  status?: (url: string) => number | 'throw';
}) {
  const files = new Map<string, string>();
  if (o.env !== undefined) files.set('proj/.env', o.env);
  const fs: SetupFs = {
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
  const sio = scriptedIO(o.script);
  const calls: string[] = [];
  const doctor = {
    root: 'proj',
    env: {},
    run: (async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as DoctorContext['run'],
    fs: { exists: () => false, read: () => '', mode: () => null },
  } as DoctorContext;
  const ctx: SetupContext = {
    io: redactingIO(sio),
    root: 'proj',
    env: {},
    fs,
    run: doctor.run,
    spawnInteractive: async () => 0,
    fetch: async (url) => {
      calls.push(url);
      const s = o.status ? o.status(url) : 200;
      if (s === 'throw') throw new Error(`network down for ${url}`);
      return { ok: s >= 200 && s < 300, status: s, json: async () => ({}) };
    },
    now: () => new Date('2026-10-15T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: 'proj/user-data/.setup-state.json',
    envPath: 'proj/.env',
    mode: o.mode,
  };
  return { ctx, sio, files, calls };
}

const env = (t: ReturnType<typeof mk>): string => t.files.get('proj/.env') ?? '';
const SECRETS = [ADZ_ID, ADZ_KEY, SERP, HUNT];

describe('apikeysStep', () => {
  it('is wired right after gmail', () => {
    const ids = ALL_STEPS.map((s) => s.id);
    expect(ids.indexOf('apikeys')).toBe(ids.indexOf('gmail') + 1);
  });

  it('skipping every provider returns skipped and writes nothing', async () => {
    const t = mk({ script: [{ choose: 'later' }, { choose: 'later' }, { choose: 'later' }] });
    expect(await apikeysStep.run(t.ctx)).toBe('skipped');
    expect(t.files.has('proj/.env')).toBe(false);
    expect(t.calls).toEqual([]);
    expect(t.sio.transcript.join('\n')).toContain('OPTIONAL');
    t.sio.assertDone();
  });

  it('sets Adzuna and Serper, skips Hunter; HUNTER_ENABLED untouched', async () => {
    const t = mk({
      env: 'HUNTER_ENABLED=false\n',
      script: [
        { choose: 'now' }, { secret: ADZ_ID }, { secret: ADZ_KEY },
        { choose: 'now' }, { secret: SERP },
        { choose: 'later' },
      ],
    });
    expect(await apikeysStep.run(t.ctx)).toBe('done');
    const e = env(t);
    expect(e).toContain(`ADZUNA_APP_ID=${ADZ_ID}`);
    expect(e).toContain(`SERPER_API_KEY=${SERP}`);
    expect(e).toContain('HUNTER_ENABLED=false');
    expect(t.calls).toHaveLength(2);
    t.sio.assertDone();
  });

  it('Hunter: key kept, HUNTER_ENABLED stays unchanged unless explicit yes', async () => {
    const no = mk({
      env: 'HUNTER_ENABLED=false\n',
      script: [{ choose: 'later' }, { choose: 'later' }, { choose: 'now' }, { secret: HUNT }, { confirm: false }],
    });
    expect(await apikeysStep.run(no.ctx)).toBe('done');
    expect(env(no)).toContain(`HUNTER_API_KEY=${HUNT}`);
    expect(env(no)).toContain('HUNTER_ENABLED=false');
    const yes = mk({
      env: 'HUNTER_ENABLED=false\n',
      script: [{ choose: 'later' }, { choose: 'later' }, { choose: 'now' }, { secret: HUNT }, { confirm: true }],
    });
    await apikeysStep.run(yes.ctx);
    expect(env(yes)).toContain('HUNTER_ENABLED=true');
  });

  it('reuses existing values after one confirm and does not rewrite', async () => {
    const e0 = `ADZUNA_APP_ID=${ADZ_ID}\nADZUNA_APP_KEY=${ADZ_KEY}\nSERPER_API_KEY=${SERP}\nHUNTER_API_KEY=${HUNT}\n`;
    const t = mk({ env: e0, script: [{ confirm: true }, { confirm: true }, { confirm: true }] });
    expect(await apikeysStep.run(t.ctx)).toBe('done');
    expect(env(t)).toBe(e0);
    expect(t.calls).toEqual([]);
    expect(t.sio.transcript.join('\n')).not.toContain(SERP);
    t.sio.assertDone();
  });

  it('rejected twice then kept anyway', async () => {
    const t = mk({
      status: () => 401,
      script: [
        { choose: 'later' },
        { choose: 'now' }, { secret: SERP }, { secret: SERP }, { confirm: true },
        { choose: 'later' },
      ],
    });
    expect(await apikeysStep.run(t.ctx)).toBe('done');
    expect(env(t)).toContain(`SERPER_API_KEY=${SERP}`);
    const out = t.sio.transcript.join('\n');
    for (const s of SECRETS) expect(out.includes(s), s).toBe(false);
    expect(out).not.toContain('https://');
    t.sio.assertDone();
  });

  it('rejected twice and not kept leaves it unset', async () => {
    const t = mk({
      status: () => 403,
      script: [
        { choose: 'later' },
        { choose: 'now' }, { secret: SERP }, { secret: SERP }, { confirm: false },
        { choose: 'later' },
      ],
    });
    expect(await apikeysStep.run(t.ctx)).toBe('skipped');
    expect(t.files.has('proj/.env')).toBe(false);
    const out = t.sio.transcript.join('\n');
    for (const s of SECRETS) expect(out.includes(s), s).toBe(false);
    expect(out).not.toContain('https://');
    expect(out).toContain('Serper left unset.');
  });

  it('replacing an existing key that is rejected and not kept says unchanged', async () => {
    const t = mk({
      env: `SERPER_API_KEY=${SERP}\n`,
      status: () => 401,
      script: [
        { choose: 'later' },
        { confirm: false }, { secret: 'new-synthetic-key-5555' }, { secret: 'new-synthetic-key-5555' }, { confirm: false },
        { choose: 'later' },
      ],
    });
    await apikeysStep.run(t.ctx);
    expect(env(t)).toBe(`SERPER_API_KEY=${SERP}\n`);
    const out = t.sio.transcript.join('\n');
    expect(out).toContain('left unchanged');
    expect(out).not.toContain('left unset');
  });

  it('partly set Adzuna names the missing variable and is treated as not configured', async () => {
    const t = mk({
      env: `ADZUNA_APP_ID=${ADZ_ID}\n`,
      script: [{ choose: 'later' }, { choose: 'later' }, { choose: 'later' }],
    });
    expect(await apikeysStep.run(t.ctx)).toBe('skipped');
    const out = t.sio.transcript.join('\n');
    expect(out).toContain('not set: ADZUNA_APP_KEY');
    expect(out).not.toContain(ADZ_ID);
    t.sio.assertDone();
  });

  it('registers the existing half of a partly set pair as a secret', async () => {
    const t = mk({
      env: `ADZUNA_APP_ID=${ADZ_ID}\n`,
      script: [{ choose: 'later' }, { choose: 'later' }, { choose: 'later' }],
    });
    const seen: string[] = [];
    const base = t.ctx.io;
    t.ctx.io = { ...base, registerSecret: (v: string) => { seen.push(v); base.registerSecret(v); } };
    await apikeysStep.run(t.ctx);
    expect(seen).toContain(ADZ_ID);
  });

  it('network failure keeps the key with a warning and never logs the URL or key', async () => {
    const t = mk({
      status: () => 'throw',
      script: [{ choose: 'later' }, { choose: 'now' }, { secret: SERP }, { choose: 'later' }],
    });
    expect(await apikeysStep.run(t.ctx)).toBe('done');
    expect(env(t)).toContain(`SERPER_API_KEY=${SERP}`);
    const out = t.sio.transcript.join('\n');
    expect(out).toContain('could not verify, the doctor will say');
    for (const s of SECRETS) expect(out.includes(s), s).toBe(false);
    expect(out).not.toContain('https://');
  });

  it('agent and terminal mode ask the same prompts and write the same .env', async () => {
    const script = (): ScriptItem[] => [
      { choose: 'now' }, { secret: ADZ_ID }, { secret: ADZ_KEY },
      { choose: 'later' }, { choose: 'later' },
    ];
    const a = mk({ mode: 'agent', script: script() });
    const b = mk({ mode: 'terminal', script: script() });
    expect(await apikeysStep.run(a.ctx)).toBe(await apikeysStep.run(b.ctx));
    expect(env(a)).toBe(env(b));
    expect(b.sio.transcript.length).toBeGreaterThan(a.sio.transcript.length);
  });
});
