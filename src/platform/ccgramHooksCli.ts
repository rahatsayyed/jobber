// src/platform/ccgramHooksCli.ts
import { join } from 'node:path';
import {
  CCGRAM_EVENTS,
  hooksStatusFromFile,
  installHooksToFile,
  removeHooksFromFile,
  resolveCcgramPython,
} from './ccgramHooks.js';

export interface CliResult {
  code: number;
  lines: string[];
}

export interface HooksCliDeps {
  which(name: string): string | null;
  readFirstLine(path: string): string;
  // Output of `ccgram --version` (last whitespace token is compared to the pin).
  ccgramVersion(): string;
  // Pinned version from config/ccgram.pin.json.
  pinVersion(): string;
}

const USAGE = 'usage: npm run ccgram-hooks -- [install|status|remove]';

export function hooksSettingsPathFor(root: string): string {
  return join(root, '.claude', 'settings.local.json');
}

function statusLines(path: string): string[] {
  const st = hooksStatusFromFile(path);
  const present = CCGRAM_EVENTS.filter((e) => st[e]);
  const missing = CCGRAM_EVENTS.filter((e) => !st[e]);
  return [
    `ccgram hooks present: ${present.length}/${CCGRAM_EVENTS.length}`,
    `present: ${present.join(', ') || 'none'}`,
    `missing: ${missing.join(', ') || 'none'}`,
  ];
}

export function runHooksCli(args: string[], root: string, deps: HooksCliDeps): CliResult {
  const path = hooksSettingsPathFor(root);
  const cmd = args[0] ?? 'status';
  if (args.length > 1 || !['install', 'status', 'remove'].includes(cmd)) {
    return { code: 1, lines: [USAGE] };
  }
  try {
    if (cmd === 'status') return { code: 0, lines: statusLines(path) };
    if (cmd === 'remove') {
      removeHooksFromFile(path);
      return { code: 0, lines: ['removed ccgram hooks (other entries untouched)', ...statusLines(path)] };
    }
    // install: pin check first, fail closed, before anything is written.
    const pin = deps.pinVersion();
    const actual = deps.ccgramVersion().trim().split(/\s+/).pop() ?? '';
    if (!pin || actual !== pin) {
      throw new Error(`ccgram version does not match the pin (expected ${pin || 'unset'}, found ${actual || 'unknown'})`);
    }
    const python = resolveCcgramPython({ which: deps.which, readFirstLine: deps.readFirstLine });
    if (!python) throw new Error('could not resolve the ccgram python interpreter');
    installHooksToFile(path, python);
    return { code: 0, lines: [`interpreter: ${python}`, 'installed ccgram hooks', ...statusLines(path)] };
  } catch (e) {
    return { code: 1, lines: [e instanceof Error ? e.message : String(e)] };
  }
}
