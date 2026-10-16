// tests/helpers/memFs.ts
// In-memory AtomicFs (superset of EnvFs from src/setup/envWriter.ts) for the settings tests.
// Supports modes, directories, symlink simulation and failure injection. Nothing touches the disk.
import type { AtomicFs, StatLite } from '../../src/settings/atomic.js';

type Node = { kind: 'file'; data: string; mode: number } | { kind: 'dir'; mode: number } | { kind: 'symlink'; target: string; mode: number };

export type FsOp = 'write' | 'rename' | 'chmod' | 'remove' | 'mkdir' | 'read';

export class MemFs implements AtomicFs {
  private nodes = new Map<string, Node>();
  /** Ops performed, in order, for assertions: `write:/a/b`. */
  readonly log: string[] = [];
  /** Throw on the next op matching (op, path predicate); `times` Infinity keeps failing. */
  private failures: Array<{ op: FsOp; match: (p: string) => boolean; left: number }> = [];

  constructor(files: Record<string, string> = {}) {
    for (const [p, data] of Object.entries(files)) this.put(p, data, 0o644);
  }

  failOn(op: FsOp, match: string | RegExp | ((p: string) => boolean) = () => true, times = 1): void {
    const fn = typeof match === 'function' ? match : match instanceof RegExp ? (p: string) => match.test(p) : (p: string) => p.includes(match);
    this.failures.push({ op, match: fn, left: times });
  }

  private check(op: FsOp, p: string): void {
    this.log.push(`${op}:${p}`);
    for (const f of this.failures) {
      if (f.op === op && f.left > 0 && f.match(p)) {
        f.left--;
        throw new Error(`injected ${op} failure`);
      }
    }
  }

  private parent(p: string): string {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  /** Create a file directly (creates parent dirs, mode 0700 for implicit ones). */
  put(p: string, data: string, mode = 0o644): void {
    this.mkdirImplicit(this.parent(p));
    this.nodes.set(p, { kind: 'file', data, mode });
  }

  private mkdirImplicit(dir: string, mode = 0o755): void {
    if (dir === '/' || dir === '' || this.nodes.has(dir)) return;
    this.mkdirImplicit(this.parent(dir), mode);
    this.nodes.set(dir, { kind: 'dir', mode });
  }

  mkdirp(dir: string, mode = 0o755): void {
    this.mkdirImplicit(dir, mode);
  }

  /** Simulate a symlink at `p` (lstat reports 'symlink'; read follows to `target` when it exists). */
  symlink(p: string, target: string): void {
    this.mkdirImplicit(this.parent(p));
    this.nodes.set(p, { kind: 'symlink', target, mode: 0o777 });
  }

  modeOf(p: string): number | null {
    return this.nodes.get(p)?.mode ?? null;
  }
  text(p: string): string | null {
    const n = this.nodes.get(p);
    return n && n.kind === 'file' ? n.data : null;
  }
  paths(): string[] {
    return [...this.nodes.keys()].sort();
  }
  /** Names of regular files directly under dir. */
  files(dir: string): string[] {
    return this.list(dir).filter((n) => this.nodes.get(`${dir}/${n}`)?.kind === 'file');
  }

  exists(p: string): boolean {
    return this.nodes.has(p);
  }
  read(p: string): string {
    this.check('read', p);
    let n = this.nodes.get(p);
    if (n && n.kind === 'symlink') n = this.nodes.get(n.target);
    if (!n || n.kind !== 'file') throw new Error('ENOENT or not a file');
    return n.data;
  }
  write(p: string, data: string, mode: number): void {
    this.check('write', p);
    if (!this.nodes.has(this.parent(p)) && this.parent(p) !== '/') throw new Error('ENOENT: parent directory missing');
    this.nodes.set(p, { kind: 'file', data, mode });
  }
  rename(from: string, to: string): void {
    this.check('rename', `${from}->${to}`);
    const n = this.nodes.get(from);
    if (!n) throw new Error('ENOENT');
    this.nodes.delete(from);
    this.nodes.set(to, n);
  }
  chmod(p: string, mode: number): void {
    this.check('chmod', p);
    const n = this.nodes.get(p);
    if (!n) throw new Error('ENOENT');
    n.mode = mode;
  }
  remove(p: string): void {
    this.check('remove', p);
    this.nodes.delete(p);
  }
  mkdir(p: string, mode: number): void {
    this.check('mkdir', p);
    this.mkdirImplicit(p, mode);
  }
  lstat(p: string): StatLite | null {
    const n = this.nodes.get(p);
    return n ? { kind: n.kind, mode: n.mode } : null;
  }
  list(dir: string): string[] {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const out: string[] = [];
    for (const k of this.nodes.keys()) {
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push(k.slice(prefix.length));
    }
    return out.sort();
  }
}

export function memFs(files: Record<string, string> = {}): MemFs {
  return new MemFs(files);
}
