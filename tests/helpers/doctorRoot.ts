// Hermetic doctor roots for the 8G-2 check tests: a temp directory tree plus a DoctorContext over the real fs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DoctorContext } from '../../src/platform/doctor.js';

export const REPO = resolve(import.meta.dirname, '..', '..');
const dirs: string[] = [];

export function tempRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'jobber-doctor-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
export function copyFromRepo(root: string, rels: string[]): void {
  for (const rel of rels) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), readFileSync(join(REPO, rel)));
  }
}
export function cleanupRoots(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
export function realFs(): DoctorContext['fs'] {
  return {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    list: (p) => (existsSync(p) ? readdirSync(p) : []),
    mode: (p) => (existsSync(p) ? statSync(p).mode & 0o777 : null),
  };
}
export function ctxFor(root: string, env: NodeJS.ProcessEnv = {}, over: Partial<DoctorContext> = {}): DoctorContext {
  return { root, env, run: async () => ({ stdout: '', code: 1 }), fs: realFs(), now: () => new Date('2026-10-16T12:00:00Z'), ...over };
}
