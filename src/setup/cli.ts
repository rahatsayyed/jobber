// src/setup/cli.ts
// Pure helpers for scripts/setup.ts so they can be unit-tested without running the process.
import { writeEnvFile, type EnvFs } from './envWriter.js';

export interface SetupArgs {
  step?: string;
  redo: boolean;
  list: boolean;
  help: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): SetupArgs {
  const out: SetupArgs = { redo: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--redo') out.redo = true;
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--step') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) out.error = '--step needs a step id';
      else {
        out.step = v;
        i++;
      }
    } else out.error = `unknown argument: ${a}`;
  }
  return out;
}

/** True when the wizard must refuse to start (stdin is not a terminal). */
export function needTty(stdinTTY: boolean | undefined, stdoutTTY: boolean | undefined = true): boolean {
  return stdinTTY !== true || stdoutTTY !== true;
}

const CHILD_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'USER', 'TMPDIR', 'SHELL',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
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

export const USAGE = `Usage: npm run setup -- [--step <id>] [--redo] [--list] [--help]
  --step <id>  run only that step
  --redo       run steps even when their checks already pass
  --list       print the step ids and exit
  --help       print this text
The wizard needs an interactive terminal.`;

export const NO_TTY_MESSAGE =
  'The setup wizard needs an interactive terminal (stdin is not a TTY). Run npm run setup from a terminal window.';
