// src/setup/mode.ts
// Agent or terminal mode: asked once, remembered in the setup state. Pure over injected deps.
import type { Run } from '../platform/tmux.js';
import { launchGuide, type LaunchResult } from './guide.js';
import type { SetupIO } from './io.js';
import type { SetupMode, SetupState } from './state.js';

export interface ModeDeps {
  io: Pick<SetupIO, 'say' | 'choose'>;
  state: SetupState;
  now: () => Date;
  save(): void;
  flagMode?: SetupMode;
  noGuide: boolean;
  /** TTY and no --step. */
  interactive: boolean;
  guideReady(): Promise<{ ready: boolean; why?: string }>;
}

function store(d: ModeDeps, m: SetupMode): void {
  d.state.mode = m;
  d.state.mode_at = d.now().toISOString();
  d.save();
}

export function notReadyLine(why?: string): string {
  return `The guide is not ready: ${why ?? 'not ready'}. Continuing without it (terminal-only text).`;
}

export interface StartGuideDeps {
  io: Pick<SetupIO, 'say'>;
  root: string;
  run: Run;
  state: SetupState;
  mode: SetupMode;
  noGuide: boolean;
  /** TTY and no --step. */
  interactive: boolean;
  readiness(): Promise<{ ready: boolean; why?: string }>;
  save(): void;
}

/** Effective mode for this run plus what happened to the guide. --no-guide is never stored. */
export async function startGuideForMode(
  d: StartGuideDeps,
): Promise<{ mode: SetupMode; launch: 'none' | 'not-ready' | LaunchResult }> {
  const mode: SetupMode = d.noGuide ? 'terminal' : d.mode;
  if (mode !== 'agent' || !d.interactive) return { mode, launch: 'none' };
  const g = await d.readiness();
  if (!g.ready) {
    d.io.say(notReadyLine(g.why));
    return { mode, launch: 'not-ready' };
  }
  const r = await launchGuide({ io: d.io, root: d.root, run: d.run });
  if (r !== 'failed') {
    d.state.guide_offered = true;
    d.save();
  }
  return { mode, launch: r };
}

export async function resolveMode(d: ModeDeps): Promise<SetupMode> {
  if (d.flagMode !== undefined) {
    store(d, d.flagMode);
    d.io.say(`mode: ${d.flagMode} (saved)`);
    return d.flagMode;
  }
  if (d.state.mode !== undefined) {
    d.io.say(
      d.noGuide && d.state.mode === 'agent'
        ? 'mode: agent (stored; --no-guide makes this run terminal-only)'
        : `mode: ${d.state.mode} (change with --mode)`,
    );
    return d.state.mode;
  }
  if (d.noGuide || !d.interactive) return 'terminal';
  const g = await d.guideReady();
  if (!g.ready) d.io.say(notReadyLine(g.why));
  const m = await d.io.choose<SetupMode>(
    'How do you want to be guided?',
    [
      {
        value: 'agent',
        label:
          'Agent-supported: a Claude coach in a second window explains each step and reads your doctor results; it never sees your keys.',
      },
      {
        value: 'terminal',
        label: 'Terminal-only: this window explains every value and asks you to confirm each step.',
      },
    ],
    g.ready ? 'agent' : 'terminal',
  );
  store(d, m);
  return m;
}
