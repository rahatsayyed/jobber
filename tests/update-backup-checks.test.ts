import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runChecks, type CheckOutcome, type DoctorContext } from '../src/platform/doctor.js';
import { updateBackupChecks } from '../src/platform/updateBackupChecks.js';

const ROOT = '/proj';
const NOW = new Date('2026-10-14T12:00:00Z');
const RECIPIENT = 'age1' + 'q'.repeat(58);
const MARK = 'SECRETMARKER9137';

interface Opts {
  files?: Record<string, string>;
  modes?: Record<string, number>;
  dirs?: Record<string, string[]>;
  env?: Record<string, string>;
  bin?: Record<string, string>; // cmd -> stdout; absent cmd = code 1
  remotes?: string;
}

function ctx(o: Opts = {}): DoctorContext {
  const files = o.files ?? {};
  return {
    root: ROOT,
    env: (o.env ?? {}) as NodeJS.ProcessEnv,
    run: async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') return { stdout: o.remotes ?? '', code: 0 };
      if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'abc123def456\n', code: 0 };
      if (o.bin && cmd in o.bin) return { stdout: o.bin[cmd], code: 0 };
      return { stdout: '', code: 1 };
    },
    fs: {
      exists: (p) => p in files || p in (o.modes ?? {}) || p in (o.dirs ?? {}),
      read: (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
      mode: (p) => (o.modes && p in o.modes ? o.modes[p] : p in files ? 0o600 : null),
      list: (p) => o.dirs?.[p] ?? [],
    },
    now: () => NOW,
  };
}

async function one(id: string, o: Opts = {}): Promise<CheckOutcome> {
  const checks = updateBackupChecks().filter((c) => c.id === id);
  expect(checks).toHaveLength(1);
  return (await runChecks(checks, ctx(o)))[0];
}

const stateFile = (s: object) => ({ [join(ROOT, '.update/state.json')]: JSON.stringify({ version: 1, last_good_commit: null, next_run_at: null, in_progress: null, last_result: null, history: [], ...s }) });
const backupState = (s: object) => ({ [join(ROOT, '.backups/state.json')]: JSON.stringify({ version: 1, last_backup_at: null, last_backup_name: null, last_error: null, last_drill_at: null, next_run_at: null, ...s }) });
const rec = (outcome: string, extra: object = {}) => ({ at: '2026-10-14T05:10:00Z', outcome, from: 'aaa', to: 'bbb', reason: null, step: null, ...extra });

describe('auto-update-config', () => {
  it('passes when AUTO_UPDATE is unset', async () => {
    const r = await one('auto-update-config');
    expect(r.result.status).toBe('pass');
    expect(r.result.detail).toContain('off');
  });
  it('passes when on, signed and remote exists', async () => {
    const r = await one('auto-update-config', { env: { AUTO_UPDATE: 'true', AUTO_UPDATE_SIGNERS_FILE: 'x' }, remotes: 'origin\n' });
    expect(r.result.status).toBe('pass');
  });
  it('warns when requireSigned is false', async () => {
    const r = await one('auto-update-config', { env: { AUTO_UPDATE: 'true', AUTO_UPDATE_REQUIRE_SIGNED: 'false' }, remotes: 'origin\n' });
    expect(r.result.status).toBe('warn');
  });
  it('warns when the remote is missing', async () => {
    const r = await one('auto-update-config', { env: { AUTO_UPDATE: 'true', AUTO_UPDATE_REQUIRE_SIGNED: 'false' }, remotes: '' });
    expect(r.result.status).toBe('warn');
  });
  it('fails when enabled with problems', async () => {
    const r = await one('auto-update-config', { env: { AUTO_UPDATE: 'true' }, remotes: 'origin\n' });
    expect(r.result.status).toBe('fail');
  });
  it('reads .env through parseEnv', async () => {
    const r = await one('auto-update-config', { files: { [join(ROOT, '.env')]: 'AUTO_UPDATE=true\nAUTO_UPDATE_REQUIRE_SIGNED=false\n' }, remotes: 'origin\n' });
    expect(r.result.status).toBe('warn');
  });
});

describe('auto-update-state', () => {
  it('passes with no state and shows commit and off', async () => {
    const r = await one('auto-update-state');
    expect(r.result.status).toBe('pass');
    expect(r.result.detail).toContain('commit abc123def456');
    expect(r.result.detail).toContain('AUTO_UPDATE off');
  });
  it('passes on updated and shows the result', async () => {
    const r = await one('auto-update-state', { env: { AUTO_UPDATE: 'true' }, files: stateFile({ last_result: rec('updated') }) });
    expect(r.result.status).toBe('pass');
    expect(r.result.detail).toContain('AUTO_UPDATE on');
    expect(r.result.detail).toContain('last: updated 2026-10-14T05:10:00Z aaa..bbb');
  });
  it('warns on rolled_back with the step', async () => {
    const r = await one('auto-update-state', { files: stateFile({ last_result: rec('rolled_back', { step: 'migrate' }) }) });
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('migrate');
  });
  it('fails on rollback_failed', async () => {
    const r = await one('auto-update-state', { files: stateFile({ last_result: rec('rollback_failed') }) });
    expect(r.result.status).toBe('fail');
  });
  it('fails on an old in_progress marker, passes on a recent one', async () => {
    const old = await one('auto-update-state', { files: stateFile({ in_progress: { from: 'a', to: 'b', started_at: '2026-10-14T10:00:00Z' } }) });
    expect(old.result.status).toBe('fail');
    const fresh = await one('auto-update-state', { files: stateFile({ in_progress: { from: 'a', to: 'b', started_at: '2026-10-14T11:30:00Z' } }) });
    expect(fresh.result.status).toBe('pass');
  });
  it('warns on an unreadable state file', async () => {
    const r = await one('auto-update-state', { files: { [join(ROOT, '.update/state.json')]: '{nope' } });
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('unreadable');
  });
});

const SETS = JSON.stringify({
  read_only: { allow: ['mcp__db__get_funnel', 'mcp__db__get_job_stats'] },
  outreach_send: { extends: 'read_only', allow: ['mcp__db__enqueue_outreach', 'mcp__db__mark_excluded'] },
  full: { extends: 'outreach_send', allow: ['mcp__applier__apply_open'] },
});
const setsFile = { [join(ROOT, 'config/permission-sets.json')]: SETS };
const local = (allow: string[]) => ({ [join(ROOT, '.claude/settings.local.json')]: JSON.stringify({ permissions: { allow } }) });

describe('new-tools-not-allowed', () => {
  it('passes when the chosen set is fully allowed', async () => {
    const r = await one('new-tools-not-allowed', { files: { ...setsFile, ...local(['mcp__db__get_funnel', 'mcp__db__get_job_stats', 'mcp__db__enqueue_outreach', 'mcp__db__mark_excluded']) } });
    expect(r.result.status).toBe('pass');
  });
  it('warns listing missing tools of the chosen set', async () => {
    const r = await one('new-tools-not-allowed', { files: { ...setsFile, ...local(['mcp__db__get_funnel', 'mcp__db__enqueue_outreach']) } });
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('mcp__db__mark_excluded');
    expect(r.result.fix).toContain('setup');
  });
  it('fails on invalid settings JSON', async () => {
    const r = await one('new-tools-not-allowed', { files: { ...setsFile, [join(ROOT, '.claude/settings.local.json')]: '{bad' } });
    expect(r.result.status).toBe('fail');
  });
  it('skips when no set can be determined', async () => {
    const none = await one('new-tools-not-allowed', { files: { ...setsFile, ...local([]) } });
    expect(none.result.status).toBe('skip');
    const nofile = await one('new-tools-not-allowed', { files: setsFile });
    expect(nofile.result.status).toBe('skip');
  });
});

const goodBackup = {
  env: { BACKUP_DIR: '/backups', BACKUP_AGE_RECIPIENT: RECIPIENT, BACKUP_ENABLED: 'true' },
  bin: { age: 'v1.1.1' },
  modes: { '/backups': 0o700 },
};

describe('backup-config', () => {
  it('passes when configured, age present, dir 700', async () => {
    expect((await one('backup-config', goodBackup)).result.status).toBe('pass');
  });
  it('warns, not fails, when unconfigured', async () => {
    const r = await one('backup-config');
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('no backup configured');
  });
  it('warns when BACKUP_DIR is inside the project', async () => {
    const r = await one('backup-config', { ...goodBackup, env: { ...goodBackup.env, BACKUP_DIR: '/proj/out' }, modes: { '/proj/out': 0o700 } });
    expect(r.result.status).toBe('warn');
  });
  it('warns on include secrets and missing rclone', async () => {
    const r = await one('backup-config', { ...goodBackup, env: { ...goodBackup.env, BACKUP_INCLUDE_SECRETS: 'true', BACKUP_RCLONE_REMOTE: 'r:p' } });
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('rclone');
    expect(r.result.detail).toContain('credentials');
  });
  it('warns when configured but scheduled backups are off', async () => {
    const r = await one('backup-config', { ...goodBackup, env: { BACKUP_DIR: '/backups', BACKUP_AGE_RECIPIENT: RECIPIENT } });
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('BACKUP_ENABLED=true');
  });
  it('fails when age is missing', async () => {
    const r = await one('backup-config', { ...goodBackup, bin: {} });
    expect(r.result.status).toBe('fail');
  });
  it('fails when BACKUP_DIR is readable by others', async () => {
    const r = await one('backup-config', { ...goodBackup, modes: { '/backups': 0o755 } });
    expect(r.result.status).toBe('fail');
  });
  it('fails on a private key shaped recipient without echoing it', async () => {
    const r = await one('backup-config', { ...goodBackup, env: { ...goodBackup.env, BACKUP_AGE_RECIPIENT: `AGE-SECRET-KEY-${MARK}` } });
    expect(r.result.status).toBe('fail');
    const text = JSON.stringify(r.result);
    expect(text).not.toContain(MARK);
    expect(text).not.toContain('AGE-SECRET-KEY');
  });
  it('warns about an identity file by name only, without content', async () => {
    const key = join(ROOT, 'jobber-backup.key');
    const r = await one('backup-config', {
      ...goodBackup,
      files: { [key]: `AGE-SECRET-KEY-1${MARK}` },
      dirs: { [ROOT]: ['jobber-backup.key', 'package.json'] },
    });
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('jobber-backup.key');
    expect(JSON.stringify(r.result)).not.toContain(MARK);
  });
  it('never prints the recipient', async () => {
    const r = await one('backup-config', { ...goodBackup, bin: {} });
    expect(JSON.stringify(r.result)).not.toContain(RECIPIENT);
  });
});

describe('identity scan and state', () => {
  it('does not read archives or sidecars in BACKUP_DIR, still reports identity files', async () => {
    const reads: string[] = [];
    const arch = '/backups/jobber-backup-20261014T050000Z.tar.gz.age';
    const c = ctx({
      ...goodBackup,
      files: { [arch]: 'x', [arch + '.sha256']: 'y', '/backups/age-keys.txt': `AGE-SECRET-KEY-1${MARK}` },
      dirs: { '/backups': ['jobber-backup-20261014T050000Z.tar.gz.age', 'jobber-backup-20261014T050000Z.tar.gz.age.sha256', 'age-keys.txt'] },
    });
    const orig = c.fs.read;
    c.fs.read = (p) => { reads.push(p); return orig(p); };
    const checks = updateBackupChecks().filter((x) => x.id === 'backup-config');
    const r = (await runChecks(checks, c))[0];
    expect(reads.filter((p) => p.includes('jobber-backup-'))).toEqual([]);
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('BACKUP_DIR/age-keys.txt');
    expect(r.result.detail).not.toContain('jobber-backup-2026');
    expect(JSON.stringify(r.result)).not.toContain(MARK);
  });
  it('warns on corrupt backup state', async () => {
    const f = { [join(ROOT, '.backups/state.json')]: '{nope' };
    expect((await one('backup-freshness', { files: f })).result.detail).toContain('unreadable');
    expect((await one('backup-drill', { files: f })).result.status).toBe('warn');
  });
});

describe('backup-freshness and backup-drill', () => {
  it('passes under 36 hours', async () => {
    const r = await one('backup-freshness', { files: backupState({ last_backup_at: '2026-10-14T00:00:00Z' }) });
    expect(r.result.status).toBe('pass');
  });
  it('warns when none recorded and when older than 36 hours', async () => {
    expect((await one('backup-freshness')).result.status).toBe('warn');
    const r = await one('backup-freshness', { files: backupState({ last_backup_at: '2026-10-12T00:00:00Z' }) });
    expect(r.result.status).toBe('warn');
  });
  it('fails with an error and success older than 7 days, without the error text', async () => {
    const r = await one('backup-freshness', { files: backupState({ last_backup_at: '2026-10-01T00:00:00Z', last_error: `boom ${MARK}` }) });
    expect(r.result.status).toBe('fail');
    expect(JSON.stringify(r.result)).not.toContain(MARK);
  });
  it('warns on a partial result even when the primary succeeded recently, without the label text', async () => {
    const r = await one('backup-freshness', {
      files: backupState({ last_backup_at: '2026-10-14T00:00:00Z', last_error: `partial: rclone:${MARK} failed` }),
    });
    expect(r.result.status).toBe('warn');
    expect(r.result.detail).toContain('partial');
    expect(JSON.stringify(r.result)).not.toContain(MARK);
  });
  it('config fix text points to the runbook, not the README', async () => {
    const r = await one('backup-config');
    expect(r.result.fix).toContain('docs/backup-and-restore.md');
    expect(r.result.fix).not.toContain('README');
  });
  it('drill: pass within 90 days, warn never or older', async () => {
    expect((await one('backup-drill', { files: backupState({ last_drill_at: '2026-09-01T00:00:00Z' }) })).result.status).toBe('pass');
    expect((await one('backup-drill')).result.status).toBe('warn');
    expect((await one('backup-drill', { files: backupState({ last_drill_at: '2026-01-01T00:00:00Z' }) })).result.status).toBe('warn');
  });
});

describe('db-private and update-dirs-private', () => {
  const db = join(ROOT, 'data.sqlite');
  it('db: absent or 600 or 640 pass, wider fails', async () => {
    expect((await one('db-private')).result.status).toBe('pass');
    expect((await one('db-private', { modes: { [db]: 0o600 } })).result.status).toBe('pass');
    expect((await one('db-private', { modes: { [db]: 0o640 } })).result.status).toBe('pass');
    const r = await one('db-private', { modes: { [db]: 0o644 } });
    expect(r.result.status).toBe('fail');
    expect(r.result.fix).toContain('chmod 600 data.sqlite');
    expect((await one('db-private', { modes: { [db]: 0o660 } })).result.status).toBe('fail');
  });
  it('dirs: absent or 700 pass, wider fails', async () => {
    expect((await one('update-dirs-private')).result.status).toBe('pass');
    expect((await one('update-dirs-private', { modes: { [join(ROOT, '.update')]: 0o700, [join(ROOT, '.backups')]: 0o700 } })).result.status).toBe('pass');
    expect((await one('update-dirs-private', { modes: { [join(ROOT, '.backups')]: 0o755 } })).result.status).toBe('fail');
  });
});

describe('crash handling', () => {
  it('runChecks reports a throwing fs as a fail with details withheld', async () => {
    const c = ctx();
    c.fs.exists = () => {
      throw new Error(`boom ${MARK}`);
    };
    const out = await runChecks(updateBackupChecks(), c);
    expect(out.length).toBeGreaterThan(0);
    for (const o of out) expect(JSON.stringify(o.result)).not.toContain(MARK);
    expect(out.some((o) => o.result.status === 'fail')).toBe(true);
  });
});
