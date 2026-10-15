// src/setup/mode.ts
// Agent or terminal mode: asked once, remembered in the setup state. Pure over injected deps.
import type { SetupIO } from './io.js';
import type { SetupMode, SetupState } from './state.js';

export interface ModeDeps {
  io: Pick<SetupIO, 'say' | 'choose' | 'confirm'>;
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

export async function resolveMode(d: ModeDeps): Promise<SetupMode> {
  if (d.flagMode !== undefined) {
    store(d, d.flagMode);
    d.io.say(`mode: ${d.flagMode} (saved)`);
    return d.flagMode;
  }
  if (d.state.mode !== undefined) {
    d.io.say(`mode: ${d.state.mode} (change with --mode)`);
    return d.state.mode;
  }
  if (d.noGuide || !d.interactive) return 'terminal';
  const g = await d.guideReady();
  if (!g.ready && g.why) d.io.say(`Agent mode is not ready: ${g.why}. Defaulting to terminal-only.`);
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
