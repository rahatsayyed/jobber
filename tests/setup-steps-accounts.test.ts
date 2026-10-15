// tests/setup-steps-accounts.test.ts
import { describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';
import { gmailStep } from '../src/setup/steps/gmail.js';
import { sessionsStep } from '../src/setup/steps/sessions.js';

const SECRET_RE = /secrets\/.*-state\.json$|gmail-credentials\.json$|gcp-oauth\.keys\.json$/;
const GOOD_STATE = JSON.stringify({ cookies: [{ name: 'li_at', value: 'x', expires: -1 }] });
const NAUKRI_STATE = JSON.stringify({ cookies: [{ name: 'nauk_at', value: 'x', expires: -1 }] });

const PRE: ScriptItem[] = [{ choose: 'now' }, { confirm: true }, { confirm: true }, { confirm: true }];

interface Spawn {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

function setup(script: ScriptItem[], files: Record<string, string> = {}, envFile?: string) {
  const store = new Map<string, string>(Object.entries(files));
  if (envFile !== undefined) store.set('proj/.env', envFile);
  const modes = new Map<string, number>();
  const dirs = new Map<string, number>();
  const reads: string[] = [];
  const fs: SetupFs = {
    exists: (p) => store.has(p),
    read: (p) => {
      reads.push(p);
      if (SECRET_RE.test(p)) throw new Error('step must not read secret files');
      const v = store.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d, m) => void (store.set(p, d), modes.set(p, m)),
    rename: () => undefined,
    chmod: (p, m) => void modes.set(p, m),
    remove: () => undefined,
    mkdirp: (p, m) => void dirs.set(p, m),
    copy: () => undefined,
    list: () => [],
  };
  const sio = scriptedIO(script);
  const spawns: Spawn[] = [];
  const spawnCodes: number[] = [];
  const doctor: DoctorContext = {
    root: 'proj',
    env: {},
    run: (async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as DoctorContext['run'],
    fs: {
      exists: (p) => store.has(p),
      read: (p) => store.get(p) ?? '',
      mode: () => 0o600,
    },
    now: () => new Date('2026-10-14T00:00:00Z'),
  };
  const ctx: SetupContext = {
    io: redactingIO(sio),
    root: 'proj',
    env: {},
    fs,
    run: doctor.run,
    spawnInteractive: async (cmd, args, opts) => {
      spawns.push({ cmd, args, env: opts?.env });
      return spawnCodes.shift() ?? 0;
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: () => new Date('2026-10-14T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: 'proj/user-data/.setup-state.json',
    envPath: 'proj/.env',
  };
  return { ctx, sio, store, modes, dirs, spawns, reads, spawnCodes };
}

describe('gmailStep', () => {
  it('spawns the auth helper with exact argv and only the two GMAIL env keys', async () => {
    const t = setup(
      [...PRE, { confirm: true }],
      { 'proj/secrets/gcp-oauth.keys.json': '{}', 'proj/secrets/gmail-credentials.json': '{"refresh_token":"r"}' },
      'TELEGRAM_BOT_TOKEN=1234567890:AAExampleTokenValue_abcdef\n',
    );
    expect(await gmailStep.run(t.ctx)).toBe('done');
    expect(t.spawns).toEqual([
      {
        cmd: 'npx',
        args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp', 'auth'],
        env: {
          GMAIL_OAUTH_PATH: 'proj/secrets/gcp-oauth.keys.json',
          GMAIL_CREDENTIALS_PATH: 'proj/secrets/gmail-credentials.json',
        },
      },
    ]);
    expect(Object.keys(t.spawns[0].env ?? {}).sort()).toEqual([
      'GMAIL_CREDENTIALS_PATH',
      'GMAIL_OAUTH_PATH',
    ]);
    expect(t.dirs.get('proj/secrets')).toBe(0o700);
    expect(t.modes.get('proj/secrets/gcp-oauth.keys.json')).toBe(0o600);
    expect(t.modes.get('proj/secrets/gmail-credentials.json')).toBe(0o600);
    expect(t.reads.some((p) => SECRET_RE.test(p))).toBe(false);
    expect(t.sio.transcript.join('\n')).toContain('Gmail send scope');
    t.sio.assertDone();
  });

  it('honours GMAIL_* paths from .env', async () => {
    const t = setup(
      [...PRE, { confirm: true }],
      {},
      'GMAIL_OAUTH_PATH=/abs/keys.json   # c\nGMAIL_CREDENTIALS_PATH=./other/creds.json\n',
    );
    await gmailStep.run(t.ctx);
    expect(t.spawns[0].env).toEqual({
      GMAIL_OAUTH_PATH: '/abs/keys.json',
      GMAIL_CREDENTIALS_PATH: 'proj/other/creds.json',
    });
  });

  it('does not spawn when the user declines the consent screen', async () => {
    const t = setup([...PRE, { confirm: false }]);
    expect(await gmailStep.run(t.ctx)).toBe('skipped');
    expect(t.spawns).toEqual([]);
  });
});

describe('sessionsStep', () => {
  it('captures all three accounts with exact argv, chmods 600, restates the safety rule', async () => {
    const t = setup([{ confirm: true }, { confirm: true }, { confirm: true }]);
    expect(await sessionsStep.run(t.ctx)).toBe('done');
    expect(t.spawns.map((s) => [s.cmd, ...s.args])).toEqual([
      ['npx', 'tsx', 'scripts/save-linkedin-session.ts', 'burner'],
      ['npx', 'tsx', 'scripts/save-linkedin-session.ts', 'main'],
      ['npx', 'tsx', 'scripts/save-naukri-session.ts'],
    ]);
    expect(t.dirs.get('proj/secrets')).toBe(0o700);
    const said = t.sio.transcript.join('\n');
    expect(said).toMatch(/BURNER.*applying/);
    expect(said).toMatch(/MAIN.*connection requests/);
    expect(said).toContain('never swapped');
    expect(t.reads.some((p) => SECRET_RE.test(p))).toBe(false);
    t.sio.assertDone();
  });

  it('chmods 600 an output file the script created', async () => {
    const t = setup([{ confirm: false }, { confirm: false }, { confirm: true }]);
    t.ctx.spawnInteractive = async (cmd, args) => {
      t.spawns.push({ cmd, args });
      t.store.set('proj/secrets/naukri-state.json', NAUKRI_STATE);
      return 0;
    };
    await sessionsStep.run(t.ctx);
    expect(t.modes.get('proj/secrets/naukri-state.json')).toBe(0o600);
  });

  it('skips a present valid session without capturing and records declines', async () => {
    const t = setup(
      [
        { confirm: false }, // burner already captured: redo? no
        { confirm: false }, // main: capture? no -> skipped
        { confirm: false }, // naukri: capture? no -> skipped
      ],
      { 'proj/secrets/linkedin-burner-state.json': GOOD_STATE },
    );
    expect(await sessionsStep.run(t.ctx)).toBe('done');
    expect(t.spawns).toEqual([]);
    expect(t.ctx.state.answers).toEqual({
      session_linkedin_main: 'skipped',
      session_naukri: 'skipped',
    });
    expect(t.reads.some((p) => SECRET_RE.test(p))).toBe(false);
    t.sio.assertDone();
  });

  it('declining one account still returns done and captures the rest', async () => {
    const t = setup([{ confirm: false }, { confirm: false }, { confirm: true }]);
    expect(await sessionsStep.run(t.ctx)).toBe('done');
    expect(t.ctx.state.answers.session_linkedin_burner).toBe('skipped');
    expect(t.ctx.state.answers.session_linkedin_main).toBe('skipped');
    expect(t.spawns).toHaveLength(1);
    expect(t.spawns[0].args).toEqual(['tsx', 'scripts/save-naukri-session.ts']);
  });
});
