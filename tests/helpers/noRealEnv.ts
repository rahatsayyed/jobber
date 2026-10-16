// tests/helpers/noRealEnv.ts
// Guard for the settings tests: any read/open/stat/exists of the repository's .env, .dashboard/ or .jobber/ throws.
// Install per test file: `const guard = installNoRealEnv(); afterAll(() => guard.restore());`
// Patches the default `node:fs` object (mutable); callers that use `import fs from 'node:fs'` or `fs.promises`-free sync
// calls through it are covered. Named ESM imports bound before install are not rewritten, so tests also use memFs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORBIDDEN = ['.env', '.dashboard', '.jobber'].map((n) => path.join(repoRoot, n));

export function isForbiddenPath(p: unknown): boolean {
  let s: string;
  if (typeof p === 'string') s = p;
  else if (p instanceof URL) s = fileURLToPath(p);
  else if (Buffer.isBuffer(p)) s = p.toString('utf8');
  else return false; // file descriptors and others
  const abs = path.resolve(s);
  return FORBIDDEN.some((f) => abs === f || abs.startsWith(f + path.sep));
}

const GUARDED = ['readFileSync', 'openSync', 'statSync', 'existsSync', 'lstatSync', 'readdirSync', 'accessSync'] as const;

export interface NoRealEnvGuard {
  restore(): void;
  /** Paths the guard refused so far. */
  blocked: string[];
}

export function installNoRealEnv(): NoRealEnvGuard {
  const blocked: string[] = [];
  const originals: Array<[string, unknown]> = [];
  const target = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of GUARDED) {
    const orig = target[name];
    if (typeof orig !== 'function') continue;
    originals.push([name, orig]);
    target[name] = function (this: unknown, ...args: unknown[]) {
      if (isForbiddenPath(args[0])) {
        blocked.push(String(args[0]));
        throw new Error(`noRealEnv: access to ${path.basename(String(args[0]))} is not allowed in settings tests`);
      }
      return orig.apply(this, args);
    };
  }
  return {
    blocked,
    restore() {
      for (const [name, orig] of originals) target[name] = orig as (...a: unknown[]) => unknown;
    },
  };
}
