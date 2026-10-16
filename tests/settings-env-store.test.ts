// tests/settings-env-store.test.ts
// applyEnvPlan, backups, retention, rollback and the secret-leak scan (plan 8H, Task 5). memFs only.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installNoRealEnv } from './helpers/noRealEnv.js';
import { memFs, type MemFs } from './helpers/memFs.js';
import { FIXTURE_CATALOG } from './fixtures/settings/catalog.fixture.js';
import { applyEnvPlan, planEnvChange, planRollback, readEnvState, type ApplyDeps, type EnvPlan, type RollbackDeps } from '../src/settings/envEdit.js';
import { listBackups } from '../src/settings/backups.js';
import { SettingsError, etagOf } from '../src/settings/atomic.js';
import type { ChangeOp, PolicyCtx } from '../src/settings/types.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());
afterEach(() => vi.restoreAllMocks());

const FIXTURE = readFileSync(new URL('./fixtures/settings/env.fixture', import.meta.url), 'utf8');
const CTX: PolicyCtx = { editEnabled: true, remoteExposure: false, remoteSafetyAllowed: false, sessionFresh: true };
const ENV = '/p/.env';
const BK = '/p/.jobber/settings-backups';
const set = (key: string, value: string): ChangeOp => ({ key, op: 'set', value });

function setup(keep = 10) {
  const fs = memFs({ [ENV]: FIXTURE });
  let t = Date.UTC(2026, 9, 16, 12, 0, 0);
  const now = () => new Date((t += 1000));
  const apply: ApplyDeps = { fs, path: ENV, backupDir: BK, keep, now };
  const rb: RollbackDeps = { fs, backupDir: BK, catalog: FIXTURE_CATALOG, ctx: CTX };
  const plan = (changes: ChangeOp[]): EnvPlan => planEnvChange(readEnvState(fs, ENV), changes, FIXTURE_CATALOG, CTX);
  return { fs, apply, rb, plan };
}
const envFiles = (fs: MemFs) => fs.files(`${BK}/env`);

describe('applyEnvPlan', () => {
  it('writes the backup first (dir 0700, file 0600), then the file at 0600', () => {
    const { fs, apply, plan } = setup();
    const p = plan([set('FX_MAX_PER_DAY', '7')]);
    const out = applyEnvPlan(p, apply);
    expect(out.backupId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    expect(out.backupId.endsWith(etagOf(FIXTURE).slice(0, 8))).toBe(true);
    expect(envFiles(fs)).toEqual([`${out.backupId}.env`]);
    expect(fs.text(`${BK}/env/${out.backupId}.env`)).toBe(FIXTURE);
    expect(fs.modeOf(`${BK}/env/${out.backupId}.env`)).toBe(0o600);
    expect(fs.modeOf(`${BK}/env`)).toBe(0o700);
    expect(fs.text(ENV)).toBe(p.newText);
    expect(fs.modeOf(ENV)).toBe(0o600);
    expect(out.newEtag).toBe(etagOf(p.newText));
    const w = fs.log.findIndex((l) => l.startsWith(`write:${BK}`));
    const r = fs.log.findIndex((l) => l.startsWith('rename:'));
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThan(r);
  });

  it('refuses a stale etag and changes nothing', () => {
    const { fs, apply, plan } = setup();
    const p = plan([set('FX_MAX_PER_DAY', '7')]);
    fs.put(ENV, `${FIXTURE}EXTRA=1\n`);
    expect(() => applyEnvPlan(p, apply)).toThrowError(expect.objectContaining({ code: 'stale_etag' }));
    expect(fs.text(ENV)).toBe(`${FIXTURE}EXTRA=1\n`);
    expect(envFiles(fs)).toEqual([]);
  });

  it('refuses a plan with errors and a plan with a refusal', () => {
    const { apply, plan } = setup();
    expect(() => applyEnvPlan(plan([set('NOPE', '1')]), apply)).toThrowError(expect.objectContaining({ code: 'invalid_plan' }));
    const p = plan([set('FX_MAX_PER_DAY', '7')]);
    const refused = { ...p, friction: { refuse: 'no', reauth: false, phrase: null } } as EnvPlan;
    Object.defineProperty(refused, 'newText', { value: p.newText });
    expect(() => applyEnvPlan(refused, apply)).toThrowError(expect.objectContaining({ code: 'refused' }));
  });

  it('a failed rename leaves the original and removes the temp file', () => {
    const { fs, apply, plan } = setup();
    const p = plan([set('FX_MAX_PER_DAY', '7')]);
    fs.failOn('rename', '.tmp-');
    expect(() => applyEnvPlan(p, apply)).toThrowError(expect.objectContaining({ code: 'write_failed' }));
    expect(fs.text(ENV)).toBe(FIXTURE);
    expect(fs.paths().filter((x) => x.includes('.tmp-'))).toEqual([]);
  });

  it('a failed backup aborts before any change', () => {
    const { fs, apply, plan } = setup();
    const p = plan([set('FX_MAX_PER_DAY', '7')]);
    fs.failOn('write', /settings-backups/);
    expect(() => applyEnvPlan(p, apply)).toThrowError(expect.objectContaining({ code: 'backup_failed' }));
    expect(fs.text(ENV)).toBe(FIXTURE);
    expect(fs.paths().filter((x) => x.includes('.tmp-'))).toEqual([]);
    expect(fs.log.some((l) => l.startsWith('rename:'))).toBe(false);
  });

  it('an unchanged plan writes nothing and makes no backup', () => {
    const { fs, apply, plan } = setup();
    const out = applyEnvPlan(plan([set('FX_MAX_PER_DAY', '5')]), apply);
    expect(out.backupId).toBe('');
    expect(envFiles(fs)).toEqual([]);
  });

  it('keeps only the newest N backups', () => {
    const { fs, apply, plan } = setup(3);
    for (let i = 6; i <= 11; i++) applyEnvPlan(plan([set('FX_MAX_PER_DAY', String(i))]), apply);
    expect(envFiles(fs)).toHaveLength(3);
    const ids = listBackups({ fs, backupDir: BK }, 'env').map((b) => b.id);
    expect(ids).toEqual([...ids].sort().reverse());
    // the oldest survivor holds the text from before the 4th edit
    const newest = listBackups({ fs, backupDir: BK }, 'env')[0];
    expect(fs.text(`${BK}/env/${newest.id}.env`)).toContain('FX_MAX_PER_DAY=10');
  });

  it('creates a missing file without a backup', () => {
    const fs = memFs();
    fs.mkdirp('/p');
    const p = planEnvChange(readEnvState(fs, ENV), [set('FX_FLAG', 'true')], FIXTURE_CATALOG, CTX);
    const out = applyEnvPlan(p, { fs, path: ENV, backupDir: BK, keep: 10, now: () => new Date(0) });
    expect(out.backupId).toBe('');
    expect(fs.text(ENV)).toContain('FX_FLAG=true');
    expect(fs.modeOf(ENV)).toBe(0o600);
  });
});

describe('listBackups and ids', () => {
  it('lists env backups newest first with parsed time and etag prefix', () => {
    const { fs, apply, plan } = setup();
    const a = applyEnvPlan(plan([set('FX_MAX_PER_DAY', '7')]), apply);
    const b = applyEnvPlan(plan([set('FX_MAX_PER_DAY', '8')]), apply);
    const l = listBackups({ fs, backupDir: BK }, 'env');
    expect(l.map((x) => x.id)).toEqual([b.backupId, a.backupId]);
    expect(l[1]).toMatchObject({ target: 'env', at: '2026-10-16T12:00:01.000Z', etag8: etagOf(FIXTURE).slice(0, 8) });
    expect(l[0].bytes).toBeGreaterThan(0);
  });

  it('lists JSON file backups under files/<id>/ and refuses an unknown file id', () => {
    const fs = memFs();
    const dir = `${BK}/files/portals`;
    fs.put(`${dir}/2026-10-16T12-00-00-123Z-abcdef12.json`, '{}\n');
    fs.put(`${dir}/not-a-backup.txt`, 'x');
    const l = listBackups({ fs, backupDir: BK }, { file: 'portals' });
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id: '2026-10-16T12-00-00-123Z-abcdef12.json', target: 'portals', at: '2026-10-16T12:00:00.123Z', etag8: 'abcdef12' });
    expect(() => listBackups({ fs, backupDir: BK }, { file: '../etc' })).toThrowError(expect.objectContaining({ code: 'unknown_file' }));
  });

  it('refuses ids with traversal or any shape but the generated one; an unknown valid id is not found', () => {
    const { fs, rb } = setup();
    const state = readEnvState(fs, ENV);
    for (const bad of ['../x', '..', '20261016T120000Z-abcdef12/../..', '20261016T120000Z-abcdef12.env', '20261016T120000Z-ABCDEF12', '', '/etc/passwd', '20261016T120000Z-abcdef12\0']) {
      expect(() => planRollback(state, bad, rb), bad).toThrowError(expect.objectContaining({ code: 'bad_backup_id' }));
    }
    expect(() => planRollback(state, '20261016T120000Z-abcdef12', rb)).toThrowError(expect.objectContaining({ code: 'backup_not_found' }));
  });
});

describe('rollback', () => {
  it('round trip: apply, rollback, text equals the original; rollback of a rollback restores the edit', () => {
    const { fs, apply, rb, plan } = setup();
    const edit = plan([set('FX_MAX_PER_DAY', '7'), set('FX_NAME', 'two words'), { key: 'FX_ALLOWED_URLS', op: 'reset' }, set('FX_ENABLE_SEND', 'true')]);
    const a1 = applyEnvPlan(edit, apply);
    const edited = fs.text(ENV)!;
    expect(edited).not.toBe(FIXTURE);

    const back = planRollback(readEnvState(fs, ENV), a1.backupId, rb);
    expect(back.errors).toEqual([]);
    expect(back.newText).toBe(FIXTURE);
    expect(back.diffs.map((d) => d.key).sort()).toEqual(['FX_ENABLE_SEND', 'FX_MAX_PER_DAY', 'FX_NAME']);
    const a2 = applyEnvPlan(back, apply);
    expect(fs.text(ENV)).toBe(FIXTURE);
    expect(fs.text(`${BK}/env/${a2.backupId}.env`)).toBe(edited); // rollback took its own backup first

    const again = planRollback(readEnvState(fs, ENV), a2.backupId, rb);
    applyEnvPlan(again, apply);
    expect(fs.text(ENV)).toBe(edited);
  });

  it('routes through the injected friction with the same inputs as the equivalent edit', () => {
    const { fs, apply, rb, plan } = setup();
    const a = applyEnvPlan(plan([set('FX_MAX_PER_DAY', '7')]), apply);
    const calls: Array<{ keys: string[]; before: unknown; after: unknown }> = [];
    const frictionFn = (input: { changes: Array<{ spec: { key: string }; before: string | null; after: string | null }> }) => {
      calls.push({ keys: input.changes.map((c) => c.spec.key), before: input.changes[0].before, after: input.changes[0].after });
      return { reauth: true, phrase: 'X' };
    };
    const p = planRollback(readEnvState(fs, ENV), a.backupId, { ...rb, frictionFn });
    expect(p.friction).toEqual({ reauth: true, phrase: 'X' });
    expect(calls).toEqual([{ keys: ['FX_MAX_PER_DAY'], before: '7', after: '5' }]);
  });

  it('refuses a rollback that would change a never-tier key', () => {
    const { fs, rb } = setup();
    const withKill = `${FIXTURE}FX_KILL=true\n`;
    fs.put(`${BK}/env/20261016T120000Z-abcdef12.env`, withKill);
    const p = planRollback(readEnvState(fs, ENV), '20261016T120000Z-abcdef12', rb);
    expect(p.errors.some((e) => e.startsWith('tier_never:'))).toBe(true);
    expect(p.newText).toBe(FIXTURE);
  });

  it('warns by name when keys outside the catalog would be restored', () => {
    const { fs, rb } = setup();
    fs.put(`${BK}/env/20261016T120000Z-abcdef12.env`, FIXTURE.replace('UNKNOWN_FIXTURE_KEY=keep-me-as-is', 'UNKNOWN_FIXTURE_KEY=other'));
    const p = planRollback(readEnvState(fs, ENV), '20261016T120000Z-abcdef12', rb);
    expect(p.warnings.join(' ')).toContain('UNKNOWN_FIXTURE_KEY');
    expect(JSON.stringify(p)).not.toContain('keep-me-as-is');
  });
});

describe('secrets never leak', () => {
  const S1 = 'FIXTURE-SECRET-1';
  const S2 = 'FIXTURE-SECRET-2';
  it('set, replace and rollback expose neither secret anywhere but the backup file content', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const { fs, apply, rb, plan } = setup();
    const plans: EnvPlan[] = [];

    // refusals and invalid input around secrets
    plans.push(plan([{ key: 'FX_API_KEY', op: 'reset' }]));
    plans.push(plan([set('FX_BOT_TOKEN', S2 + 'x'.repeat(300))]));
    plans.push(plan([set('FX_API_KEY', `${S1}\n${S2}`)]));
    // replace one secret with the other, clear the second
    const replace = plan([set('FX_API_KEY', S2), { key: 'FX_BOT_TOKEN', op: 'clear' }, set('FX_OAUTH_SECRET', S1)]);
    plans.push(replace);
    expect(replace.errors).toEqual([]);
    expect(replace.diffs.filter((d) => d.secret)).toEqual([
      { key: 'FX_API_KEY', secret: true, before: 'set', after: 'replaced' },
      { key: 'FX_BOT_TOKEN', secret: true, before: 'set', after: 'cleared' },
      { key: 'FX_OAUTH_SECRET', secret: true, before: 'not set', after: 'set' },
    ]);
    const a1 = applyEnvPlan(replace, apply);
    const back = planRollback(readEnvState(fs, ENV), a1.backupId, rb);
    plans.push(back);
    applyEnvPlan(back, apply);
    expect(fs.text(ENV)).toBe(FIXTURE);
    plans.push(planRollback(readEnvState(fs, ENV), a1.backupId, rb));

    for (const p of plans) {
      const dump = JSON.stringify(p);
      expect(dump).not.toContain('FIXTURE-SECRET');
      expect(Object.keys(p)).not.toContain('newText');
      for (const e of [...p.errors, ...p.warnings]) expect(e).not.toContain('FIXTURE-SECRET');
    }
    // backup FILE NAMES carry a stamp and an etag prefix only
    for (const name of fs.paths()) expect(name).not.toContain('FIXTURE-SECRET');
    // documented (D8): the backup CONTENT holds the old secret, like .env itself
    expect(fs.text(`${BK}/env/${a1.backupId}.env`)).toContain(S1);
    expect(fs.text(`${BK}/env/${a1.backupId}.env`)).toContain(S2);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('FIXTURE-SECRET');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('error objects thrown by the store carry no secret', () => {
    const { fs, apply, plan } = setup();
    const p = plan([set('FX_API_KEY', S2)]);
    fs.put(ENV, `${FIXTURE}X=1\n`);
    try {
      applyEnvPlan(p, apply);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError);
      expect(String((e as Error).message) + String((e as Error).stack)).not.toContain('FIXTURE-SECRET-2\n');
      expect((e as Error).message).not.toContain('FIXTURE-SECRET');
    }
  });
});
