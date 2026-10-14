import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Exec } from '../lib/exec.js';
import { isValidRcloneRemote } from './config.js';
import { BACKUP_NAME_RE } from './retention.js';

export interface BackupDestination {
  readonly label: string;
  put(localPath: string, name: string): Promise<void>;
  list(): Promise<string[]>;
  get(name: string, localPath: string): Promise<void>;
  remove(name: string): Promise<void>;
}

const SIDECAR = '.sha256';
const NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

function isArchiveName(name: string): boolean {
  return BACKUP_NAME_RE.test(name);
}

function isAllowedName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (isArchiveName(name)) return true;
  return name.endsWith(SIDECAR) && isArchiveName(name.slice(0, -SIDECAR.length));
}

function assertName(name: string): void {
  if (!isAllowedName(name)) throw new Error(`invalid backup name: ${JSON.stringify(String(name).slice(0, 80))}`);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function assertRegularSource(src: string): void {
  if (typeof src !== 'string' || /\0/.test(src)) throw new Error('invalid local path');
  const st = lstatOrNull(src);
  if (!st) throw new Error('source file does not exist');
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('source must be a regular file, not a symlink');
}

function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim().slice(0, 300);
}

async function copyNew(src: string, dest: string, sync = false): Promise<void> {
  assertRegularSource(src);
  const fd = fs.openSync(dest, 'wx', 0o600);
  try {
    const out = fs.createWriteStream(dest, { fd, autoClose: false });
    try {
      await pipeline(fs.createReadStream(src), out);
      if (sync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    try { fs.unlinkSync(dest); } catch { /* partial file already gone */ }
    throw e;
  }
}

export class LocalDirDestination implements BackupDestination {
  readonly label: string;
  constructor(private readonly dir: string) {
    this.label = `local:${dir}`;
  }

  private ensureDir(create: boolean): boolean {
    const st = lstatOrNull(this.dir);
    if (!st) {
      if (!create) return false;
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      return true;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('backup directory must be a real directory, not a symlink');
    return true;
  }

  private target(name: string): string {
    assertName(name);
    return path.join(this.dir, name);
  }

  async put(localPath: string, name: string): Promise<void> {
    const target = this.target(name);
    assertRegularSource(localPath);
    this.ensureDir(true);
    if (lstatOrNull(target)) throw new Error(`backup already exists: ${name}`);
    const tmp = path.join(this.dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    try {
      await copyNew(localPath, tmp, true);
      try {
        fs.linkSync(tmp, target);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new Error(`backup already exists: ${name}`);
        if (!NO_LINK_CODES.has(code ?? '')) throw e;
        // no hard links here (exFAT, FAT, some SMB): exclusive copy, no atomic-link guarantee
        if (lstatOrNull(target)) throw new Error(`backup already exists: ${name}`);
        try {
          fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL);
        } catch (ce) {
          if ((ce as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`backup already exists: ${name}`);
          try { fs.unlinkSync(target); } catch { /* nothing partial to remove */ }
          throw ce;
        }
        try { fs.chmodSync(target, 0o600); } catch { /* filesystem without modes */ }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    }
  }

  async list(): Promise<string[]> {
    if (!this.ensureDir(false)) return [];
    const out: string[] = [];
    for (const ent of fs.readdirSync(this.dir)) {
      if (!isArchiveName(ent)) continue;
      const st = lstatOrNull(path.join(this.dir, ent));
      if (st && st.isFile() && !st.isSymbolicLink()) out.push(ent);
    }
    return out.sort();
  }

  async get(name: string, localPath: string): Promise<void> {
    const source = this.target(name);
    this.ensureDir(false);
    const st = lstatOrNull(source);
    if (!st) throw new Error(`backup not found: ${name}`);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`refusing to read non-regular file: ${name}`);
    if (lstatOrNull(localPath)) throw new Error('local destination file already exists');
    await copyNew(source, localPath);
  }

  async remove(name: string): Promise<void> {
    const target = this.target(name);
    if (!this.ensureDir(false)) return;
    const st = lstatOrNull(target);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`refusing to remove non-regular file: ${name}`);
    fs.unlinkSync(target);
  }
}

export class RcloneDestination implements BackupDestination {
  readonly label: string;
  private readonly remote: string;

  constructor(remote: string, private readonly exec: Exec) {
    if (typeof remote !== 'string' || remote.startsWith('-') || !isValidRcloneRemote(remote)) {
      throw new Error('invalid rclone remote: must look like name:path');
    }
    this.remote = remote;
    this.label = `rclone:${remote}`;
  }

  private remoteFile(name: string): string {
    assertName(name);
    return this.remote.endsWith(':') || this.remote.endsWith('/') ? `${this.remote}${name}` : `${this.remote}/${name}`;
  }

  private async run(args: string[], timeoutMs = 600_000, okCodes: number[] = []): Promise<string> {
    const r = await this.exec('rclone', args, { timeoutMs });
    if (r.code === 127) throw new Error('rclone is not installed or not on PATH; install rclone to use BACKUP_RCLONE_REMOTE');
    if (r.code !== 0 && !okCodes.includes(r.code)) {
      throw new Error(`rclone ${args[0]} failed (exit ${r.code}): ${cleanText(r.stderr)}`);
    }
    return r.code === 0 ? r.stdout : '';
  }

  private async listAll(): Promise<string[]> {
    // exit 3 = directory not found: a fresh remote folder is an empty listing
    const out = await this.run(['lsf', '--', this.remote], 120_000, [3]);
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => isAllowedName(l));
  }

  async put(localPath: string, name: string): Promise<void> {
    const dest = this.remoteFile(name);
    assertRegularSource(localPath);
    const present = await this.listAll();
    if (present.includes(name)) throw new Error(`backup already exists: ${name}`);
    await this.run(['copyto', '--', localPath, dest]);
  }

  async list(): Promise<string[]> {
    return (await this.listAll()).filter(isArchiveName).sort();
  }

  async get(name: string, localPath: string): Promise<void> {
    const src = this.remoteFile(name);
    if (/\0/.test(localPath)) throw new Error('invalid local path');
    if (lstatOrNull(localPath)) throw new Error('local destination file already exists');
    await this.run(['copyto', '--', src, localPath]);
    try { fs.chmodSync(localPath, 0o600); } catch { /* file missing: caller verifies */ }
  }

  async remove(name: string): Promise<void> {
    const dest = this.remoteFile(name);
    const present = await this.listAll();
    if (!present.includes(name)) return;
    await this.run(['deletefile', '--', dest], 120_000);
  }
}
