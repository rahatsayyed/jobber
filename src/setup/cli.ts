// src/setup/cli.ts
// Pure helpers for scripts/setup.ts so they can be unit-tested without running the process.
import type { SetupMode } from './state.js';
import { writeEnvFile, type EnvFs } from './envWriter.js';

export interface SetupArgs {
  step?: string;
  redo: boolean;
  list: boolean;
  help: boolean;
  noGuide?: boolean;
  guideOnly?: boolean;
  status?: boolean;
  mode?: SetupMode;
  error?: string;
}

export function parseArgs(argv: string[]): SetupArgs {
  const out: SetupArgs = { redo: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--redo') out.redo = true;
    else if (a === '--list') out.list = true;
    else if (a === '--no-guide') out.noGuide = true;
    else if (a === '--guide-only') out.guideOnly = true;
    else if (a === '--status') out.status = true;
    else if (a === '--mode') {
      const v = argv[i + 1];
      if (v === 'agent' || v === 'terminal') {
        out.mode = v;
        i++;
      } else {
        out.error = '--mode needs agent or terminal';
        if (v !== undefined && !v.startsWith('-')) i++;
      }
    } else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--step') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) out.error = '--step needs a step id';
      else {
        out.step = v;
        i++;
      }
    } else out.error = `unknown argument: ${a}`;
  }
  if (out.guideOnly && out.noGuide && !out.error) {
    out.error = '--guide-only and --no-guide cannot be used together';
  }
  if (out.mode !== undefined && !out.error) {
    if (out.noGuide && out.mode === 'agent') out.error = '--mode agent and --no-guide cannot be used together';
    else if (out.guideOnly && out.mode === 'terminal') out.error = '--mode terminal and --guide-only cannot be used together';
    else if (out.list || out.status) out.error = '--mode cannot be used with --list or --status';
  }
  return out;
}

/** True when the wizard must refuse to start (stdin is not a terminal). */
export function needTty(stdinTTY: boolean | undefined, stdoutTTY: boolean | undefined = true): boolean {
  return stdinTTY !== true || stdoutTTY !== true;
}

const CHILD_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'USER', 'TMPDIR', 'SHELL',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_SESSION_TYPE',
  'DBUS_SESSION_BUS_ADDRESS', 'PLAYWRIGHT_BROWSERS_PATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
];

// Minimal child environment: an allowlist of the parent env merged with explicit extras.
export function childEnv(env: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_KEYS) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return Object.assign(out, extra ?? {});
}

// Creates .env from .env.example (mode 600, atomic) when missing. Never touches directories.
export function ensureEnvFile(
  fs: EnvFs,
  envPath: string,
  examplePath: string,
  now: () => Date,
): boolean {
  if (fs.exists(envPath) || !fs.exists(examplePath)) return false;
  writeEnvFile(envPath, fs.read(examplePath), fs, now);
  return true;
}

// Runs a child that shares the terminal: the IO is released first and taken back afterwards
// (also when the spawn throws), so the wizard's readline never races the child for stdin and
// type-ahead typed during the child never answers a later prompt.
export async function spawnSuspended<T>(
  io: { suspend(): void; resume(): void },
  run: () => Promise<T>,
): Promise<T> {
  io.suspend();
  try {
    return await run();
  } finally {
    io.resume();
  }
}

export const USAGE =`Usage: npm run setup -- [--step <id>] [--redo] [--list] [--status] [--mode agent|terminal] [--no-guide | --guide-only] [--help]
  --step <id>  run only that step
  --redo       run steps even when their checks already pass
  --list       print the step ids and exit
  --status     print each step as done|skipped|configured (not via setup)|pending and exit
  --mode <m>   agent (guided session) or terminal (walkthrough here); remembered
  --no-guide   do not offer the guided setup session
  --guide-only start only the guided setup session in this terminal
  --help       print this text
The wizard needs an interactive terminal.`;

export const NO_TTY_MESSAGE =
  'The setup wizard needs an interactive terminal (stdin is not a TTY). Run npm run setup from a terminal window.';
