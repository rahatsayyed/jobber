import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDirDestination, RcloneDestination } from '../src/backup/destination.js';
import type { Exec } from '../src/lib/exec.js';

const NAME = 'jobber-backup-20261014T031500Z.tar.gz.age';
const NAME2 = 'jobber-backup-20261015T031500Z.tar.gz.age';
let tmp: string;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-dest-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('LocalDirDestination', () => {
  it('round trips put, list, get with safe modes', async () => {
    const src = path.join(tmp, 'src.bin');
    fs.writeFileSync(src, 'payload');
    const dir = path.join(tmp, 'bk');
    const d = new LocalDirDestination(dir);
    await d.put(src, NAME);
    expect(await d.list()).toEqual([NAME]);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, NAME)).mode & 0o777).toBe(0o600);
    const out = path.join(tmp, 'out.bin');
    await d.get(NAME, out);
    expect(fs.readFileSync(out, 'utf8')).toBe('payload');
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    await expect(d.get(NAME, out)).rejects.toThrow(/exists/);
  });

  it('refuses to overwrite and keeps the original', async () => {
    const src = path.join(tmp, 'src.bin');
    fs.writeFileSync(src, 'one');
    const d = new LocalDirDestination(path.join(tmp, 'bk'));
    await d.put(src, NAME);
    fs.writeFileSync(src, 'two');
    await expect(d.put(src, NAME)).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(tmp, 'bk', NAME), 'utf8')).toBe('one');
  });

  it('rejects bad names on every operation', async () => {
    const d = new LocalDirDestination(path.join(tmp, 'bk'));
    await expect(d.remove('../../x')).rejects.toThrow(/invalid backup name/);
    await expect(d.remove('data.sqlite')).rejects.toThrow(/invalid backup name/);
    await expect(d.get('../x', path.join(tmp, 'o'))).rejects.toThrow(/invalid backup name/);
    await expect(d.put(path.join(tmp, 'a'), 'x.tar')).rejects.toThrow(/invalid backup name/);
  });

  it('removes an archive and its sidecar, ignoring a missing one', async () => {
    const src = path.join(tmp, 'src.bin');
    fs.writeFileSync(src, 'x');
    const d = new LocalDirDestination(path.join(tmp, 'bk'));
    await d.put(src, NAME);
    await d.put(src, `${NAME}.sha256`);
    await d.remove(NAME);
    await d.remove(`${NAME}.sha256`);
    await d.remove(NAME2);
    expect(await d.list()).toEqual([]);
  });

  it('does not read, write or remove through a symlink', async () => {
    const dir = path.join(tmp, 'bk');
    fs.mkdirSync(dir, { mode: 0o700 });
    const outside = path.join(tmp, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(dir, NAME));
    const d = new LocalDirDestination(dir);
    expect(await d.list()).toEqual([]);
    await expect(d.get(NAME, path.join(tmp, 'out'))).rejects.toThrow();
    await expect(d.put(outside, NAME)).rejects.toThrow(/already exists/);
    await expect(d.remove(NAME)).rejects.toThrow(/non-regular/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
    expect(fs.existsSync(path.join(tmp, 'out'))).toBe(false);
  });

  it('rejects a symlinked source file and a symlinked directory', async () => {
    const real = path.join(tmp, 'real.bin');
    fs.writeFileSync(real, 'x');
    const link = path.join(tmp, 'link.bin');
    fs.symlinkSync(real, link);
    const d = new LocalDirDestination(path.join(tmp, 'bk'));
    await expect(d.put(link, NAME)).rejects.toThrow(/symlink/);
    const realDir = path.join(tmp, 'realdir');
    fs.mkdirSync(realDir);
    const linkDir = path.join(tmp, 'linkdir');
    fs.symlinkSync(realDir, linkDir);
    await expect(new LocalDirDestination(linkDir).put(real, NAME)).rejects.toThrow(/symlink/);
  });
});

function fakeExec(handler: (args: string[]) => { stdout?: string; stderr?: string; code?: number }) {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = handler(args);
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
  };
  return { exec, calls };
}

describe('RcloneDestination', () => {
  it('rejects a bad remote', () => {
    const { exec } = fakeExec(() => ({}));
    expect(() => new RcloneDestination('-bad:path', exec)).toThrow(/invalid rclone remote/);
    expect(() => new RcloneDestination('nocolon', exec)).toThrow(/invalid rclone remote/);
    expect(() => new RcloneDestination('r:a/../b', exec)).toThrow(/invalid rclone remote/);
  });

  it('put checks lsf then runs copyto with argument arrays', async () => {
    const { exec, calls } = fakeExec((a) => (a[0] === 'lsf' ? { stdout: `${NAME2}\n` } : {}));
    const d = new RcloneDestination('gdrive:jobber', exec);
    const local = path.join(tmp, '-weird file.bin');
    fs.writeFileSync(local, 'x');
    await d.put(local, NAME);
    expect(calls[0]).toEqual({ cmd: 'rclone', args: ['lsf', '--', 'gdrive:jobber'] });
    expect(calls[1]).toEqual({ cmd: 'rclone', args: ['copyto', '--', local, `gdrive:jobber/${NAME}`] });
  });

  it('put refuses when the name is already present', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: `${NAME}\n` }));
    const d = new RcloneDestination('gdrive:jobber', exec);
    const local = path.join(tmp, 'a.bin');
    fs.writeFileSync(local, 'x');
    await expect(d.put(local, NAME)).rejects.toThrow(/already exists/);
    expect(calls.every((c) => c.args[0] === 'lsf')).toBe(true);
  });

  it('list filters names and returns archives only', async () => {
    const { exec } = fakeExec(() => ({ stdout: `${NAME}\n${NAME}.sha256\nnotes.txt\nsub/\n${NAME2}\n` }));
    const d = new RcloneDestination('r:', exec);
    expect(await d.list()).toEqual([NAME, NAME2]);
  });

  it('get and remove use copyto and deletefile', async () => {
    const { exec, calls } = fakeExec((a) => (a[0] === 'lsf' ? { stdout: `${NAME}.sha256\n` } : {}));
    const d = new RcloneDestination('r:dir', exec);
    await d.remove(`${NAME}.sha256`);
    expect(calls[1].args).toEqual(['deletefile', '--', `r:dir/${NAME}.sha256`]);
    const out = path.join(tmp, 'dl.bin');
    await d.get(NAME, out);
    expect(calls[2].args).toEqual(['copyto', '--', `r:dir/${NAME}`, out]);
    fs.writeFileSync(out, 'x');
    await expect(d.get(NAME, out)).rejects.toThrow(/exists/);
  });

  it('remove of an absent name is a no-op', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '' }));
    await new RcloneDestination('r:dir', exec).remove(NAME);
    expect(calls).toHaveLength(1);
  });

  it('rejects invalid names before running rclone', async () => {
    const { exec, calls } = fakeExec(() => ({}));
    const d = new RcloneDestination('r:dir', exec);
    await expect(d.remove('../x')).rejects.toThrow(/invalid backup name/);
    await expect(d.put(path.join(tmp, 'a'), '-rf')).rejects.toThrow(/invalid backup name/);
    expect(calls).toHaveLength(0);
  });

  it('explains a missing rclone binary and surfaces other failures', async () => {
    const missing = fakeExec(() => ({ code: 127, stderr: 'ENOENT' }));
    await expect(new RcloneDestination('r:d', missing.exec).list()).rejects.toThrow(/install rclone/);
    const bad = fakeExec(() => ({ code: 5, stderr: 'temporary\u0007 error\nline' }));
    const err = await new RcloneDestination('r:d', bad.exec).list().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/exit 5.*temporary error line/);
    expect((err as Error).message).not.toMatch(/[\u0000-\u001f]/);
  });

  it('treats exit 3 on lsf as an empty listing so a fresh folder works', async () => {
    const local = path.join(tmp, 'a.bin');
    fs.writeFileSync(local, 'x');
    const { exec, calls } = fakeExec((a) => (a[0] === 'lsf' ? { code: 3, stderr: 'directory not found' } : {}));
    const d = new RcloneDestination('r:fresh', exec);
    expect(await d.list()).toEqual([]);
    await d.put(local, NAME);
    expect(calls[calls.length - 1].args[0]).toBe('copyto');
    await d.remove(NAME);
  });

  it('rejects a missing put source before running rclone', async () => {
    const { exec, calls } = fakeExec(() => ({}));
    const d = new RcloneDestination('r:d', exec);
    await expect(d.put(path.join(tmp, 'nope'), NAME)).rejects.toThrow(/does not exist/);
    expect(calls).toHaveLength(0);
  });
});

describe('LocalDirDestination atomic put', () => {
  it('leaves no temp when the final name exists', async () => {
    const src = path.join(tmp, 's.bin');
    fs.writeFileSync(src, 'x');
    const dir = path.join(tmp, 'bk');
    const d = new LocalDirDestination(dir);
    await d.put(src, NAME);
    await expect(d.put(src, NAME)).rejects.toThrow(/already exists/);
    expect(fs.readdirSync(dir)).toEqual([NAME]);
  });

  it('leaves no final name and no temp when the copy fails', async () => {
    const dir = path.join(tmp, 'bk');
    const d = new LocalDirDestination(dir);
    const srcDir = path.join(tmp, 'asdir');
    fs.mkdirSync(srcDir);
    await expect(d.put(srcDir, NAME)).rejects.toThrow();
    expect(fs.existsSync(dir)).toBe(false);
    fs.mkdirSync(dir, { mode: 0o700 });
    const src = path.join(tmp, 'unreadable.bin');
    fs.writeFileSync(src, 'x');
    fs.chmodSync(src, 0o000);
    if (process.getuid?.() !== 0) {
      await expect(d.put(src, NAME)).rejects.toThrow();
      expect(fs.readdirSync(dir)).toEqual([]);
    }
  });

  it('list ignores temp files and put with a bad name creates no dir', async () => {
    const dir = path.join(tmp, 'bk');
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, '.tmp-abc'), 'x');
    expect(await new LocalDirDestination(dir).list()).toEqual([]);
    const other = path.join(tmp, 'never');
    const src = path.join(tmp, 's.bin');
    fs.writeFileSync(src, 'x');
    await expect(new LocalDirDestination(other).put(src, 'bad')).rejects.toThrow(/invalid backup name/);
    await expect(new LocalDirDestination(other).put(path.join(tmp, 'missing'), NAME)).rejects.toThrow();
    expect(fs.existsSync(other)).toBe(false);
  });
});
