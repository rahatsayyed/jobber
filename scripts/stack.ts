// scripts/stack.ts
// `npm run up` / `npm run down`. Real dependencies only; the logic is in src/stack.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { allDoctorChecks } from '../src/platform/checkLists.js';
import { runChecks, type CheckOutcome, type DoctorContext } from '../src/platform/doctor.js';
import { defaultRun } from '../src/platform/tmux.js';
import { runDown, type DownOpts } from '../src/stack/down.js';
import { runUp } from '../src/stack/up.js';
import { initTerm } from '../src/ui/term.js';

export type Parsed =
  | { cmd: 'up'; status: boolean }
  | ({ cmd: 'down' } & DownOpts)
  | { cmd: 'error'; message: string };

const USAGE = 'usage: stack <up [--status] | down [--keep-bridge] [--force] [--yes]>';

export function parseArgs(argv: string[]): Parsed {
  const [cmd, ...rest] = argv;
  if (cmd !== 'up' && cmd !== 'down') return { cmd: 'error', message: USAGE };
  const allowed = cmd === 'up' ? ['--status'] : ['--keep-bridge', '--force', '--yes'];
  for (const a of rest) if (!allowed.includes(a)) return { cmd: 'error', message: `unknown argument: ${a}\n${USAGE}` };
  if (cmd === 'up') return { cmd: 'up', status: rest.includes('--status') };
  return {
    cmd: 'down',
    keepBridge: rest.includes('--keep-bridge'),
    force: rest.includes('--force'),
    yes: rest.includes('--yes'),
  };
}

// Loopback only; 200 or 401 counts as up.
export async function loopbackProbe(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return false;
    // redirect: manual so a redirect to another host is never followed; a 3xx means the server answered
    const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    return r.status === 200 || r.status === 401 || (r.status >= 300 && r.status < 400);
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const term = initTerm(); // strips --no-color before the parser sees it
  const p = parseArgs(process.argv.slice(2));
  if (p.cmd === 'error') {
    console.error(p.message);
    return 2;
  }
  const root = resolve(import.meta.dirname, '..');
  const base = {
    root,
    env: process.env,
    run: defaultRun,
    fs: { exists: (x: string) => existsSync(x), read: (x: string) => readFileSync(x, 'utf8') },
    now: () => new Date(),
    say: (l: string) => console.log(term.paint(l)),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    probe: loopbackProbe,
    authTokenSet: (p: string): boolean | null => {
      try {
        const Database = createRequire(import.meta.url)('better-sqlite3') as new (f: string, o: object) => {
          prepare(q: string): { get(): unknown }; close(): void;
        };
        const db = new Database(p, { readonly: true, fileMustExist: true });
        try { return db.prepare('SELECT 1 AS x FROM access_token WHERE id = 1').get() !== undefined; } finally { db.close(); }
      } catch {
        return null;
      }
    },
    doctor: async (): Promise<CheckOutcome[]> => {
      const ctx: DoctorContext = {
        root,
        env: process.env,
        run: defaultRun,
        fs: {
          exists: (x) => existsSync(x),
          read: (x) => readFileSync(x, 'utf8'),
          list: (x) => (existsSync(x) ? readdirSync(x) : []),
          mode: (x) => (existsSync(x) ? statSync(x).mode & 0o777 : null),
        },
        now: () => new Date(),
      };
      return runChecks(allDoctorChecks(), ctx);
    },
  };
  if (p.cmd === 'up') return runUp(base, { status: p.status });
  return runDown(
    {
      ...base,
      isTTY: Boolean(process.stdin.isTTY),
      ask: async (q) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return /^y(es)?$/i.test((await rl.question(q)).trim());
        } finally {
          rl.close();
        }
      },
    },
    p,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
