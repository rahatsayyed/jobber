import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup, nodeCreateFs, type CreateDeps, type CreateFs } from '../src/backup/create.js';
import type { BackupConfig } from '../src/backup/config.js';
import type { BackupDestination } from '../src/backup/destination.js';
import { emptyBackupState, readBackupState, recordBackupResult, writeBackupState } from '../src/backup/state.js';
import { nodeStateFs } from '../src/update/state.js';

const RECIPIENT = 'age1' + 'q'.repeat(58);
const NOW = new Date('2026-10-15T03:15:00Z');
const NAME = 'jobber-backup-20261015T031500Z.tar.gz.age';
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-create-'));
  fs.mkdirSync(path.join(root, 'user-data'));
  fs.writeFileSync(path.join(root, 'user-data', 'resume.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(root, 'user-data', 'resume.json.bak'), 'old');
  fs.writeFileSync(path.join(root, 'user-data', 'cv.pdf'), 'pdf');
  fs.symlinkSync('/etc/hosts', path.join(root, 'user-data', 'link'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'portals.json'), '{}');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret-value');
  fs.mkdirSync(path.join(root, 'secrets'));
  fs.writeFileSync(path.join(root, 'secrets', 'state.json'), 'secret');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function cfg(over: Partial<BackupConfig> = {}): BackupConfig {
  return {
    dir: path.join(root, 'out'), recipient: RECIPIENT, includeSecrets: false, rcloneRemote: null,
    retain: { daily: 7, weekly: 4, monthly: 6 }, enabled: true, problems: [], configured: true, ...over,
  };
}

function dest(label: string, over: Partial<BackupDestination> = {}): BackupDestination & { puts: string[]; names: string[]; removed: string[] } {
  const puts: string[] = [];
  const removed: string[] = [];
  const state = { names: [] as string[] };
  const d = {
    label, puts, removed,
    get names(): string[] { return state.names; },
    set names(v: string[]) { state.names = v; },
    put: vi.fn(async (_p: string, name: string) => { puts.push(name); }),
    list: vi.fn(async () => state.names),
    get: vi.fn(async () => undefined),
    remove: vi.fn(async (n: string) => { removed.push(n); }),
    ...over,
  };
  return d as BackupDestination & { puts: string[]; names: string[]; removed: string[] };
}

function deps(over: Partial<CreateDeps> = {}, fsOver: Partial<CreateFs> = {}) {
  const seen: { staging: string[]; files: string[] }[] = [];
  const fsPort: CreateFs = { ...nodeCreateFs, rmrf: vi.fn(nodeCreateFs.rmrf), ...fsOver };
  const exec = vi.fn(async () => ({ stdout: 'age 1.2', stderr: '', code: 0 }));
  const d: CreateDeps = {
    root, now: () => NOW, exec, fs: fsPort,
    snapshotDb: async (p) => { fs.writeFileSync(p, 'SQLITE'); },
    checkSnapshot: () => ({ ok: true, integrity: 'ok', tables: { jobs: 3 } }),
    pack: vi.fn(async ({ stagingDir, outPath }) => {
      const files: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        for (const n of fs.readdirSync(dir)) {
          const full = path.join(dir, n);
          if (fs.statSync(full).isDirectory()) walk(full, `${prefix}${n}/`);
          else files.push(`${prefix}${n}`);
        }
      };
      walk(stagingDir, '');
      seen.push({ staging: [stagingDir], files });
      fs.writeFileSync(outPath, 'CIPHERTEXT');
    }),
    destinations: [dest('local')],
    commit: async () => 'abc123',
    ...over,
  };
  return { d, seen, fsPort, exec };
}

describe('createBackup', () => {
  it('refuses when unconfigured or with problems', async () => {
    const { d } = deps();
    expect((await createBackup(d, cfg({ configured: false, dir: null }), { planOnly: false })).code).toBe('not_configured');
    expect((await createBackup(d, cfg({ problems: ['x'] }), { planOnly: false })).code).toBe('not_configured');
    expect(d.pack).not.toHaveBeenCalled();
  });

  it('refuses without age and never packs or stages', async () => {
    const { d, fsPort, exec } = deps();
    exec.mockResolvedValue({ stdout: '', stderr: 'nope', code: 127 });
    const r = await createBackup(d, cfg(), { planOnly: false });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('age is not installed (brew install age)');
    expect(d.pack).not.toHaveBeenCalled();
    expect(fsPort.rmrf).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.backups'))).toBe(false);
  });

  it('aborts on a failed integrity check and uploads nothing', async () => {
    const dst = dest('local');
    const { d, fsPort } = deps({ destinations: [dst], checkSnapshot: () => ({ ok: false, integrity: 'bad', tables: {} }) });
    const r = await createBackup(d, cfg(), { planOnly: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('integrity');
    expect(dst.put).not.toHaveBeenCalled();
    expect(d.pack).not.toHaveBeenCalled();
    expect(fsPort.rmrf).toHaveBeenCalled();
  });

  it('happy path: packs the expected staging contents, uploads, cleans up', async () => {
    const dst = dest('local');
    const { d, seen, fsPort } = deps({ destinations: [dst] });
    const r = await createBackup(d, cfg(), { planOnly: false });
    expect(r).toMatchObject({ ok: true, name: NAME, uploaded: ['local'], failed: [], error: null });
    expect(d.pack).toHaveBeenCalledTimes(1);
    const files = seen[0].files.sort();
    expect(files).toEqual(['config/portals.json', 'data.sqlite', 'manifest.json', 'user-data/resume.json']);
    expect(dst.puts).toEqual([NAME, `${NAME}.sha256`]);
    const rm = vi.mocked(fsPort.rmrf).mock.calls.map((c) => c[0]);
    expect(rm).toContain(seen[0].staging[0]);
    expect(fs.existsSync(seen[0].staging[0])).toBe(false);
    expect(fs.readdirSync(path.join(root, '.backups'))).toEqual([]);
  });

  it('skips symlinks and excluded names with reasons, and includes secrets on opt-in', async () => {
    const { d, seen } = deps();
    const plan = await createBackup(d, cfg({ includeSecrets: true }), { planOnly: true });
    const why = Object.fromEntries(plan.plan!.excluded.map((e) => [e.path, e.why]));
    expect(why['user-data/link']).toMatch(/symlink/);
    expect(why['user-data/resume.json.bak']).toBeDefined();
    expect(why['user-data/cv.pdf']).toBeDefined();
    const r = await createBackup(d, cfg({ includeSecrets: true }), { planOnly: false });
    expect(r.ok).toBe(true);
    expect(seen[0].files).toContain('.env');
    expect(seen[0].files).toContain('secrets/state.json');
  });

  it('manifest carries hashes of staged files and table counts, no recipient', async () => {
    let manifestText = '';
    const { d } = deps({
      pack: vi.fn(async ({ stagingDir, outPath }) => {
        manifestText = fs.readFileSync(path.join(stagingDir, 'manifest.json'), 'utf8');
        fs.writeFileSync(outPath, 'C');
      }),
    });
    await createBackup(d, cfg(), { planOnly: false });
    const m = JSON.parse(manifestText);
    expect(m.commit).toBe('abc123');
    expect(m.db.tables).toEqual({ jobs: 3 });
    expect(m.files.find((f: { path: string }) => f.path === 'data.sqlite').sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestText).not.toContain(RECIPIENT);
    expect(manifestText).not.toContain('secret-value');
  });

  it('removes the staging dir when packing fails and writes no plaintext fallback', async () => {
    const dst = dest('local');
    const { d, fsPort } = deps({ destinations: [dst], pack: vi.fn(async () => { throw new Error('age exploded with /secret/path'); }) });
    const r = await createBackup(d, cfg(), { planOnly: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('encrypt');
    expect(r.error).not.toContain('/secret/path');
    expect(dst.put).not.toHaveBeenCalled();
    expect(vi.mocked(fsPort.rmrf).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fs.readdirSync(path.join(root, '.backups'))).toEqual([]);
  });

  it('primary failure fails the run; secondary failure keeps ok with failed filled', async () => {
    const bad = (l: string) => dest(l, { put: vi.fn(async () => { throw new Error('boom'); }) });
    const a = await createBackup(deps({ destinations: [bad('local'), dest('rclone')] }).d, cfg(), { planOnly: false });
    expect(a).toMatchObject({ ok: false, code: 'upload' });
    const b = await createBackup(deps({ destinations: [dest('local'), bad('rclone')] }).d, cfg(), { planOnly: false });
    expect(b.ok).toBe(true);
    expect(b.failed).toEqual([{ label: 'rclone', error: 'upload failed' }]);
    expect(b.code).toBe('secondary_failed');
  });

  it('retention removes only planned names (and their sidecars), failure does not fail the run', async () => {
    const old = 'jobber-backup-20250101T000000Z.tar.gz.age';
    const dst = dest('local');
    dst.names = [old, NAME];
    const r = await createBackup(deps({ destinations: [dst] }).d, cfg({ retain: { daily: 1, weekly: 0, monthly: 0 } }), { planOnly: false });
    expect(r.ok).toBe(true);
    expect(dst.removed).toEqual([old, `${old}.sha256`]);
    expect(r.removed).toEqual([old]);
    const dst2 = dest('local', { list: vi.fn(async () => { throw new Error('x'); }) });
    const r2 = await createBackup(deps({ destinations: [dst2] }).d, cfg(), { planOnly: false });
    expect(r2.ok).toBe(true);
  });

  it('sweeps only .staging-* directories older than 24 hours', async () => {
    const b = path.join(root, '.backups');
    fs.mkdirSync(b, { recursive: true });
    const oldDir = path.join(b, '.staging-old');
    const newDir = path.join(b, '.staging-new');
    const other = path.join(b, 'keep-me');
    for (const p of [oldDir, newDir, other]) fs.mkdirSync(p);
    const past = new Date(NOW.getTime() - 25 * 3600 * 1000);
    fs.utimesSync(oldDir, past, past);
    fs.utimesSync(other, past, past);
    fs.utimesSync(newDir, new Date(NOW.getTime() - 3600 * 1000), new Date(NOW.getTime() - 3600 * 1000));
    await createBackup(deps().d, cfg(), { planOnly: false });
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('planOnly writes and executes nothing', async () => {
    const { d, fsPort, exec } = deps();
    const r = await createBackup(d, cfg(), { planOnly: true });
    expect(r.ok).toBe(true);
    expect(r.plan!.files).toContain('data.sqlite');
    expect(exec).not.toHaveBeenCalled();
    expect(d.pack).not.toHaveBeenCalled();
    expect(fsPort.rmrf).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.backups'))).toBe(false);
  });
});

describe('backup state', () => {
  it('writes atomically with mode 600 in a 700 dir and holds no secrets', () => {
    const s = recordBackupResult(emptyBackupState(), { ok: true, name: NAME, error: null, failed: [] }, NOW);
    writeBackupState(nodeStateFs, root, s);
    const p = path.join(root, '.backups', 'state.json');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(p)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(p))).toEqual(['state.json']);
    expect(fs.readFileSync(p, 'utf8')).not.toContain(RECIPIENT);
    expect(readBackupState(nodeStateFs, root)).toMatchObject({ last_backup_at: NOW.toISOString(), last_backup_name: NAME, last_error: null });
  });

  it('a failure keeps the last success and records the error; partial success sets last_error', () => {
    const ok = recordBackupResult(emptyBackupState(), { ok: true, name: NAME, error: null, failed: [] }, NOW);
    const bad = recordBackupResult(ok, { ok: false, name: null, error: 'upload failed', failed: [] }, new Date());
    expect(bad.last_backup_at).toBe(ok.last_backup_at);
    expect(bad.last_error).toBe('upload failed');
    const part = recordBackupResult(ok, { ok: true, name: NAME, error: null, failed: [{ label: 'rclone', error: 'x' }] }, NOW);
    expect(part.last_error).toMatch(/rclone/);
  });

  it('a corrupt file reads as empty', () => {
    fs.mkdirSync(path.join(root, '.backups'));
    fs.writeFileSync(path.join(root, '.backups', 'state.json'), '{nope');
    expect(readBackupState(nodeStateFs, root)).toEqual(emptyBackupState());
  });
});
