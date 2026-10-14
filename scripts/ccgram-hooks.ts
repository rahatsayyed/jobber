// scripts/ccgram-hooks.ts
import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { runHooksCli, type HooksCliDeps } from '../src/platform/ccgramHooksCli.js';

const root = resolve(import.meta.dirname, '..');

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const deps: HooksCliDeps = {
  which,
  readFirstLine: (p) => readFileSync(p, 'utf8').split('\n', 1)[0] ?? '',
  ccgramVersion: () => {
    const exe = which('ccgram');
    if (!exe) throw new Error('ccgram not found on PATH');
    return execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000 });
  },
  pinVersion: () => {
    const pin = JSON.parse(readFileSync(resolve(root, 'config/ccgram.pin.json'), 'utf8')) as { version?: unknown };
    return typeof pin.version === 'string' ? pin.version : '';
  },
};

let result;
try {
  result = runHooksCli(process.argv.slice(2), root, deps);
} catch (e) {
  result = { code: 1, lines: [e instanceof Error ? e.message : String(e)] };
}
for (const line of result.lines) console.log(line);
process.exit(result.code);
