// src/setup/cli.ts
// Pure helpers for scripts/setup.ts so they can be unit-tested without running the process.

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
export function needTty(isTTY: boolean | undefined): boolean {
  return isTTY !== true;
}

export const USAGE = `Usage: npm run setup -- [--step <id>] [--redo] [--list] [--help]
  --step <id>  run only that step
  --redo       run steps even when their checks already pass
  --list       print the step ids and exit
  --help       print this text
The wizard needs an interactive terminal.`;

export const NO_TTY_MESSAGE =
  'The setup wizard needs an interactive terminal (stdin is not a TTY). Run npm run setup from a terminal window.';
