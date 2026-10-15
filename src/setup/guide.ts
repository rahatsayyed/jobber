// src/setup/guide.ts
// Offer, launch and status for the guided setup session. Pure over injected deps. The guide runs
// in a second terminal or a detached tmux window; it never receives keys and never reads the wizard.
import type { CheckOutcome } from '../platform/doctor.js';
import type { Run } from '../platform/tmux.js';
import { SKIP_SPECS } from './skips.js';
import type { SetupState } from './state.js';

export const GUIDE_PROMPT = 'Use the setup-guide skill. Start by running the doctor.';
export const GUIDE_SESSION = 'jobber-setup';
export const GUIDE_WINDOW = 'guide';
export const GUIDE_LAUNCHER = ['bash', 'scripts/run-claude.sh', 'setup_guide', '--interactive', GUIDE_PROMPT];
export const GUIDE_CHECK_IDS = ['claude-cli', 'claude-login', 'setup_guide_ready'];

export interface GuideDeps {
  io: { say(line: string): void; confirm(prompt: string, defaultYes?: boolean): Promise<boolean> };
  root: string;
  run: Run;
  state: SetupState;
  noGuide: boolean;
  tty: boolean;
  /** Outcomes of claude-cli, claude-login and setup_guide_ready. */
  checks: () => Promise<CheckOutcome[]>;
  save: () => void;
}

export type OfferResult =
  | 'skipped'
  | 'declined'
  | 'started-tmux'
  | 'already-running'
  | 'no-tmux'
  | 'failed';

export async function offerGuide(d: GuideDeps): Promise<OfferResult> {
  if (d.noGuide || !d.tty || d.state.guide_offered === true) return 'skipped';
  const out = await d.checks();
  for (const id of GUIDE_CHECK_IDS) {
    if (out.find((o) => o.id === id)?.result.status !== 'pass') return 'skipped';
  }
  const tmuxOk = (await d.run('tmux', ['-V'])).code === 0;
  const yes = await d.io.confirm(
    'Start a guided setup session (an AI coach in a second window that explains each step and never sees your keys or secrets)?',
    tmuxOk,
  );
  d.state.guide_offered = true;
  d.save();
  if (!yes) return 'declined';
  if (!tmuxOk) {
    d.io.say('Open a second terminal here and run: npm run setup -- --guide-only');
    return 'no-tmux';
  }
  return launchGuide(d);
}

export interface LaunchDeps {
  io: { say(line: string): void };
  root: string;
  run: Run;
}

/** Starts (or finds) the detached tmux guide window. No checks and no confirm: the caller decided. */
export async function launchGuide(d: LaunchDeps): Promise<'started-tmux' | 'already-running' | 'failed'> {
  const attach = `Open another terminal and run: tmux attach -t ${GUIDE_SESSION}`;
  const keys = 'Keep entering keys in THIS window; the guide never sees them.';
  const hasSession = (await d.run('tmux', ['has-session', '-t', `=${GUIDE_SESSION}`])).code === 0;
  if (hasSession) {
    const wins = await d.run('tmux', ['list-windows', '-t', `=${GUIDE_SESSION}`, '-F', '#{window_name}']);
    if (wins.stdout.split('\n').map((w) => w.trim()).includes(GUIDE_WINDOW)) {
      d.io.say(attach);
      d.io.say(keys);
      return 'already-running';
    }
  }
  const r = hasSession
    ? await d.run('tmux', ['new-window', '-d', '-t', `=${GUIDE_SESSION}:`, '-n', GUIDE_WINDOW, '-c', d.root, ...GUIDE_LAUNCHER])
    : await d.run('tmux', ['new-session', '-d', '-s', GUIDE_SESSION, '-n', GUIDE_WINDOW, '-c', d.root, ...GUIDE_LAUNCHER]);
  if (r.code !== 0) {
    d.io.say('Could not start the guide window. Run: npm run setup -- --guide-only');
    return 'failed';
  }
  d.io.say(attach);
  d.io.say(keys);
  return 'started-tmux';
}

/** Whether the guide can start: the 8E checks all pass and tmux answers `-V`. */
export async function guideReadiness(d: {
  run: Run;
  checks: () => Promise<CheckOutcome[]>;
}): Promise<{ ready: boolean; why?: string }> {
  const out = await d.checks();
  for (const id of GUIDE_CHECK_IDS) {
    if (out.find((o) => o.id === id)?.result.status !== 'pass') {
      return { ready: false, why: `the guide needs the ${id} check to pass first` };
    }
  }
  if ((await d.run('tmux', ['-V'])).code !== 0) return { ready: false, why: 'tmux is not available' };
  return { ready: true };
}

/** `--guide-only`: run the guide in this terminal through the injected spawner. */
export function runGuideOnly(
  spawner: (cmd: string, args: string[]) => Promise<number>,
): Promise<number> {
  return spawner(GUIDE_LAUNCHER[0], GUIDE_LAUNCHER.slice(1));
}

/** `--status`: step ids, status and time only; no answers or values. */
export function formatStatus(stepIds: string[], state: SetupState): string {
  const recommended = new Set(SKIP_SPECS.filter((k) => k.label === 'RECOMMENDED').map((k) => k.stepId));
  const rows = stepIds.map((id) => {
    const s = state.steps[id];
    if (!s) return `${id}  pending`;
    const status = s.status === 'skipped' && recommended.has(id) ? 'skipped (recommended)' : s.status;
    return `${id}  ${status}  ${s.at}`;
  });
  return [`mode: ${state.mode ?? 'unset'}`, ...rows].join('\n');
}
