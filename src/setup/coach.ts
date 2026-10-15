// src/setup/coach.ts
// Plan 8F coach helpers. Mode changes only the printed text, never which state-changing prompts
// are issued: offerSkip and confirmDone ask the same questions in agent and terminal mode.
import type { SetupContext } from './runner.js';
import type { SkipSpec } from './skips.js';
import type { SetupMode } from './state.js';

/** Terminal-mode coaching blocks per id. Steps extend this; entries stay plain ASCII text with
 *  no secrets, no token shapes and no key=value lines (a lint test enforces it). */
export const COACH_TEXT: Record<string, string[]> = {
  'generic.outside_terminal': [
    'This part happens outside the terminal, in your browser or on your phone.',
    'Come back here when it is done; nothing is waiting on a timer.',
  ],
  'generic.secret_hint': [
    'The next value is a secret. What you type is hidden and is never printed or saved in logs.',
  ],
  'generic.skip_note': [
    'Skipping is safe: it only records the choice. You can run this step again any time.',
  ],
  'telegram.intro': [
    'Telegram is how you control Jobber from your phone: start a hunt, ask for status, get alerts.',
    'The bot token is a password. Anyone who has it can control your bot, so never share it.',
  ],
  'telegram.id': [
    'Message @userinfobot with any text; it replies with your numeric ID. It is 5 to 15 digits.',
  ],
  'telegram.next': ['Then send /health to your bot to confirm the bridge answers.'],
};

export function coachOn(ctx: { mode?: SetupMode }): boolean {
  return ctx.mode === 'terminal';
}

export function say(ctx: SetupContext, id: string): void {
  if (!coachOn(ctx)) return;
  for (const line of COACH_TEXT[id] ?? []) ctx.io.say(line);
}

/** defaultChoice is for per-key optional items where the call site decides (Hunter: later). */
export async function offerSkip(
  ctx: SetupContext,
  spec: SkipSpec,
  defaultChoice?: 'now' | 'later',
): Promise<'now' | 'later'> {
  ctx.io.say(`[${spec.label}] ${spec.title}`);
  for (const l of spec.lose) ctx.io.say(l);
  return ctx.io.choose<'now' | 'later'>(
    'Set this up now?',
    [
      { value: 'now', label: 'Set it up now' },
      { value: 'later', label: 'Skip for now (you can run this step again any time)' },
    ],
    defaultChoice ?? (spec.label === 'OPTIONAL' ? 'later' : 'now'),
  );
}

export async function confirmDone(
  ctx: SetupContext,
  o: {
    id: string;
    action: string;
    explain: string[];
    again: string[];
    maxRounds?: number;
    allowSkip?: boolean;
  },
): Promise<'done' | 'skip'> {
  const rounds = o.maxRounds ?? 3;
  for (const l of o.explain) ctx.io.say(l);
  for (let i = 0; i < rounds; i++) {
    if (await ctx.io.confirm(`${o.action}: done?`, false)) return 'done';
    if (i < rounds - 1) for (const l of o.again) ctx.io.say(l);
  }
  if (o.allowSkip) return 'skip';
  throw new Error('step not confirmed');
}
