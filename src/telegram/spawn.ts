// src/telegram/spawn.ts
// Child processes for the bridge: argv array, never a shell, stdin closed, a small explicit environment, a timeout.
import { spawn } from 'node:child_process';

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<ProcResult>;

const MAX_OUT = 5_000_000;

export const runProcess: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: 127, stdout: '', stderr: 'spawn failed', timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_OUT) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_OUT) stderr += d.toString('utf8'); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: 'spawn error', timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });

// Names a child may inherit. The bot token and every other secret stay out; the children read .env themselves
// where they need to. JOBBER_KILL and JOBBER_DRY_RUN are flags the safety hooks read, so they are passed on.
const CHILD_ENV_NAMES = ['HOME', 'PATH', 'TERM', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'JOBBER_KILL', 'JOBBER_DRY_RUN', 'JOBAPPLIER_DB'] as const;

export function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of CHILD_ENV_NAMES) {
    const v = env[n];
    if (v !== undefined && v !== '' && !/[\n\r\0]/.test(v)) out[n] = v;
  }
  return out;
}
