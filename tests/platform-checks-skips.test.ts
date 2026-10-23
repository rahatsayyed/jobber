import { describe, expect, it } from 'vitest';
import { exitCode, formatJson, runChecks, type Check, type CheckResult, type DoctorContext } from '../src/platform/doctor.js';
import { apiKeysChecks } from '../src/platform/checksApiKeys.js';
import { allDoctorChecks } from '../src/platform/checkLists.js';
import { SKIP_SPECS, skipSummary, withSkips } from '../src/setup/skips.js';

const ROOT = '/proj';
const STATE = '/proj/user-data/.setup-state.json';

function ctxWith(opts: { env?: Record<string, string>; state?: object | null; files?: Record<string, string> }): DoctorContext {
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  if (opts.state) files[STATE] = JSON.stringify(opts.state);
  return {
    root: ROOT,
    env: opts.env ?? {},
    run: (async () => ({ code: 0, stdout: '', stderr: '' })) as unknown as DoctorContext['run'],
    fs: {
      exists: (p) => p in files,
      read: (p) => files[p] ?? '',
      mode: () => 0o600,
    },
  };
}

const skippedState = (...ids: string[]) => ({
  version: 1,
  steps: Object.fromEntries(ids.map((i) => [i, { status: 'skipped', at: '2026-10-15T00:00:00Z' }])),
  answers: {},
});

const fake = (id: string, r: CheckResult): Check => ({ id, title: `T ${id}`, run: async () => r });

describe('withSkips', () => {
  it('converts fail and warn of a skipped feature into skip with the fix', async () => {
    const wrapped = withSkips([fake('telegram-api', { status: 'fail', detail: 'x' }), fake('daemon', { status: 'warn', detail: 'y' })]);
    const out = await runChecks(wrapped, ctxWith({ state: skippedState('telegram') }));
    for (const o of out) {
      expect(o.result.status).toBe('skip');
      expect(o.result.detail).toMatch(/^skipped in setup \(Telegram, RECOMMENDED\)\. No phone control/);
      expect(o.result.fix).toBe('npm run setup -- --step telegram');
    }
    expect(out.map((o) => o.id)).toEqual(['telegram-api', 'daemon']);
    expect(out[0].title).toBe('T telegram-api');
  });

  it('keeps a pass and keeps a crash a crash', async () => {
    const boom: Check = { id: 'web', title: 'W', run: async () => { throw new Error('x'); } };
    const out = await runChecks(withSkips([fake('ccgram-env', { status: 'pass', detail: 'ok' }), boom]), ctxWith({ state: skippedState('telegram', 'dashboard') }));
    expect(out[0].result.status).toBe('pass');
    expect(out[1].result.status).toBe('fail');
  });

  it('ignores the record when the feature is configured (token present)', async () => {
    const out = await runChecks(
      withSkips([fake('telegram-api', { status: 'fail', detail: 'x' })]),
      ctxWith({ state: skippedState('telegram'), env: { TELEGRAM_BOT_TOKEN: '1234567890:AAExampleTokenValue_abcdef' } }),
    );
    expect(out[0].result.status).toBe('fail');
  });

  it('reads .env through ctx.fs for the configured test', async () => {
    const out = await runChecks(
      withSkips([fake('telegram-api', { status: 'fail', detail: 'x' })]),
      ctxWith({ state: skippedState('telegram'), files: { '/proj/.env': 'TELEGRAM_BOT_TOKEN=1234567890:AAExampleTokenValue_abcdef\n' } }),
    );
    expect(out[0].result.status).toBe('fail');
  });

  it('does nothing without a skip record or without a state file', async () => {
    const c = [fake('gmail-oauth', { status: 'fail', detail: 'x' })];
    expect((await runChecks(withSkips(c), ctxWith({ state: null })))[0].result.status).toBe('fail');
    expect((await runChecks(withSkips(c), ctxWith({ state: skippedState('dashboard') })))[0].result.status).toBe('fail');
  });

  it('exit code stays 0 when the only non-pass results are skips', async () => {
    const out = await runChecks(
      withSkips([fake('gmail-oauth', { status: 'fail', detail: 'x' }), fake('api-keys', { status: 'warn', detail: 'y' })]),
      ctxWith({ state: skippedState('gmail', 'apikeys') }),
    );
    expect(exitCode(out)).toBe(0);
    const json = JSON.parse(formatJson(out)) as Record<string, unknown>[];
    expect(Object.keys(json[0]).sort()).toEqual(['detail', 'id', 'status', 'title']);
  });
});

describe('allowlist is closed', () => {
  it('has none of the safety check ids', () => {
    const banned = [
      'classifier_model', 'classifier_smoke', 'classifier_wired', 'permission-set', 'project-hooks', 'gitignore',
      'env-limits', 'env-inline-comments', 'resume-valid', 'profile-valid', 'scheduler-dry-run', 'scheduler-stop-file',
    ];
    const all = SKIP_SPECS.flatMap((s) => s.checkIds);
    for (const b of banned) expect(all).not.toContain(b);
    for (const id of all) expect(id).not.toMatch(/^(classifier|scheduler)/);
  });
  it('every allowlisted id exists in the real doctor list', () => {
    const ids = allDoctorChecks().map((c) => c.id);
    for (const id of SKIP_SPECS.flatMap((s) => s.checkIds)) expect(ids).toContain(id);
  });
});

describe('api-keys check', () => {
  const run = (env: Record<string, string>) => apiKeysChecks[0].run(ctxWith({ env }));
  it('warns with names only, never fails', async () => {
    const r = await run({});
    expect(r.status).toBe('warn');
    expect(r.detail).toBe('not set: SERPER_API_KEY, HUNTER_API_KEY');
  });
  it('passes when all are set, and leaks no value', async () => {
    const env = {
      SERPER_API_KEY: 'invented-serper-cccc3333',
      HUNTER_API_KEY: 'invented-hunter-dddd4444',
    };
    const r = await run(env);
    expect(r.status).toBe('pass');
    const partial = await run({ SERPER_API_KEY: env.SERPER_API_KEY });
    const text = JSON.stringify([r, partial]);
    for (const v of Object.values(env)) {
      for (let i = 0; i + 8 <= v.length; i++) expect(text).not.toContain(v.slice(i, i + 8));
    }
    expect(partial.detail).not.toContain('SERPER_API_KEY');
    expect(partial.detail).toContain('HUNTER_API_KEY');
  });
});

describe('skipSummary', () => {
  it('is empty with nothing skipped', () => expect(skipSummary([])).toBe(''));
  it('lists ids and the re-enable hint', () => {
    expect(skipSummary(['telegram', 'dashboard'])).toBe(
      'Skipped by choice: telegram, dashboard. Re-enable: npm run setup -- --step <id>',
    );
  });
});
