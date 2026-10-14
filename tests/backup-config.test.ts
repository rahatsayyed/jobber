import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadBackupConfig } from '../src/backup/config.js';

const KEY = 'age1' + 'q'.repeat(58);
const root = path.resolve('/proj');

describe('loadBackupConfig', () => {
  it('defaults are unconfigured', () => {
    const c = loadBackupConfig({}, root);
    expect(c.configured).toBe(false);
    expect(c.enabled).toBe(false);
    expect(c.retain).toEqual({ daily: 7, weekly: 4, monthly: 6 });
    expect(c.problems).toEqual([]);
  });
  it('configured with dir and public recipient; relative dir resolves to root', () => {
    const c = loadBackupConfig({ BACKUP_DIR: 'out', BACKUP_AGE_RECIPIENT: KEY, BACKUP_ENABLED: 'true' }, root);
    expect(c.configured).toBe(true);
    expect(c.enabled).toBe(true);
    expect(c.dir).toBe(path.join(root, 'out'));
  });
  it('enabled does not affect configured', () => {
    const c = loadBackupConfig({ BACKUP_DIR: 'out', BACKUP_AGE_RECIPIENT: KEY, BACKUP_ENABLED: 'yes' }, root);
    expect(c.enabled).toBe(false);
    expect(c.configured).toBe(true);
  });
  it('a private key is a problem, never stored or echoed', () => {
    const secret = 'AGE-SECRET-KEY-1ABCDEFSECRETVALUE';
    const c = loadBackupConfig({ BACKUP_DIR: 'out', BACKUP_AGE_RECIPIENT: secret }, root);
    expect(c.recipient).toBeNull();
    expect(c.configured).toBe(false);
    expect(c.problems.length).toBe(1);
    expect(JSON.stringify(c)).not.toContain('SECRETVALUE');
  });
  it('malformed recipient is a problem without echoing it', () => {
    const c = loadBackupConfig({ BACKUP_AGE_RECIPIENT: 'notakey123' }, root);
    expect(c.recipient).toBeNull();
    expect(JSON.stringify(c)).not.toContain('notakey123');
    expect(c.problems.length).toBe(1);
  });
  it('includeSecrets only for the exact string', () => {
    expect(loadBackupConfig({ BACKUP_INCLUDE_SECRETS: 'true' }, root).includeSecrets).toBe(true);
    for (const v of ['TRUE', '1', 'yes', ' true']) {
      expect(loadBackupConfig({ BACKUP_INCLUDE_SECRETS: v }, root).includeSecrets).toBe(false);
    }
  });
  it('retention out of range or non-integer is a problem and keeps the default', () => {
    const c = loadBackupConfig(
      { BACKUP_RETAIN_DAILY: '366', BACKUP_RETAIN_WEEKLY: '-1', BACKUP_RETAIN_MONTHLY: '2.5' },
      root,
    );
    expect(c.retain).toEqual({ daily: 7, weekly: 4, monthly: 6 });
    expect(c.problems.length).toBe(3);
    const ok = loadBackupConfig({ BACKUP_RETAIN_DAILY: '0', BACKUP_RETAIN_WEEKLY: '365' }, root);
    expect(ok.retain.daily).toBe(0);
    expect(ok.retain.weekly).toBe(365);
    expect(ok.problems).toEqual([]);
  });
  it('BACKUP_DIR at the root or inside user-data, config, secrets is a problem', () => {
    for (const d of ['.', 'user-data/b', 'config', 'secrets/x', path.join(root, 'user-data')]) {
      const c = loadBackupConfig({ BACKUP_DIR: d, BACKUP_AGE_RECIPIENT: KEY }, root);
      expect(c.dir, d).toBeNull();
      expect(c.configured, d).toBe(false);
      expect(c.problems.length, d).toBe(1);
    }
    expect(loadBackupConfig({ BACKUP_DIR: '.backups' }, root).dir).toBe(path.join(root, '.backups'));
  });
  it('rclone remote rejects leading non-alnum and dotdot', () => {
    for (const v of ['-x:p', '.x:p', 'gdrive:../up']) {
      expect(loadBackupConfig({ BACKUP_RCLONE_REMOTE: v }, root).rcloneRemote, v).toBeNull();
    }
  });
  it('rclone remote shape', () => {
    expect(loadBackupConfig({ BACKUP_RCLONE_REMOTE: 'gdrive:jobber/backups' }, root).rcloneRemote).toBe('gdrive:jobber/backups');
    const bad = loadBackupConfig({ BACKUP_RCLONE_REMOTE: 'no-colon; rm -rf' }, root);
    expect(bad.rcloneRemote).toBeNull();
    expect(bad.problems.length).toBe(1);
  });
});
