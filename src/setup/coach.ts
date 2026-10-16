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
  'gmail.where': [
    'The Google OAuth client JSON stays on this machine, in the secrets folder, and is never sent anywhere.',
    'The token file is created by the Google consent screen later in this step; you do not make it by hand.',
  ],
  'apikeys.intro': [
    'These keys are optional extras. Each one can be skipped and added later with npm run setup -- --step apikeys.',
  ],
  'apikeys.adzuna': [
    'Adzuna is a job-search service. Sign up for a free developer account to get an app ID and an app key.',
  ],
  'apikeys.serper': [
    'Serper is used for contact finding: it searches Google for a company site and contact pages.',
    'It runs only after the cache and the browser search miss. Each check uses one search credit.',
  ],
  'apikeys.hunter': [
    'Hunter is used for contact finding: it looks up emails as a last resort.',
    'It spends monthly credits, so it stays off unless you turn it on.',
  ],
  'dashboard.token': [
    'The dashboard token is a one-time sign-in link for the status page in your browser.',
    'The link is printed once, by a separate command, straight to your terminal; this wizard never sees it.',
    'Nothing is stored except a hash of the token. Lost it? Rotate it with npm run dashboard -- rotate.',
  ],
  'telegram.intro': [
    'Telegram is how you control Jobber from your phone: start a hunt, ask for status, get alerts.',
    'The bot token is a password. Anyone who has it can control your bot, so never share it.',
  ],
  'telegram.id': [
    'Message @userinfobot with any text; it replies with your numeric ID. It is 5 to 15 digits.',
  ],
  'telegram.next': ['Then send /health to your bot to confirm the bridge answers.'],
  'prereqs.intro': [
    'Each check below is a tool Jobber needs: Node, tmux, Chrome, its browser files and the pinned ccgram.',
    'A failing check prints its exact fix. Run it in another terminal, then press Enter here.',
    'Or run bash scripts/bootstrap.sh, which offers to install what is missing.',
  ],
  'claude.intro': [
    'Logged in means the claude command reaches your Claude account without asking you to sign in again.',
    'To log in, run claude in another terminal, follow the sign-in prompts, then come back here.',
  ],
  'sessions.why': [
    'Three separate accounts keep risks apart: the burner applies, the main account sends connect requests.',
    'Naukri has its own login. They are never swapped, so one flagged account cannot affect another.',
  ],
  'sessions.window': [
    'A browser window opens for each account. Log in there as you normally would, then return here.',
    'Press Enter when logged in; the session is saved and the window closes.',
    'How long a saved session lasts is unmeasured. Rerun this step if the doctor says one expired.',
  ],
  'sessions.lose.linkedin_burner': ['If you skip this: LinkedIn Easy Apply stays off.'],
  'sessions.lose.linkedin_main': ['If you skip this: LinkedIn connection requests and messages stay off.'],
  'sessions.lose.naukri': ['If you skip this: Naukri search and recruiter replies stay off.'],
  'classifier.intro': [
    'The classifier is a small local model. It screens job posts, profiles and replies for injected text.',
    'It protects the agent from text that tries to take control. It runs here; no text leaves this machine.',
    'The download size is shown above, and every file is checked against a pinned hash.',
  ],
  'classifier.required': [
    'REQUIRED BEFORE LIVE: until fetched and pinned, live LinkedIn and Naukri actions are refused.',
    'Dry runs work without it.',
  ],
  'classifier.commands': [
    'After the download, three commands finish the setup:',
    '  1. npm run models -- pin <profile>',
    '  2. npm run classifier:fit -- --profile <profile> --write',
    '  3. npm run doctor',
  ],
  'classifier.commands.ready': [
    'This model is already pinned and fitted in the shipped registry, so there is no pin or fit to run.',
    'After the download and hash check, one thing remains: the CLASSIFIER_MODEL line in .env, then npm run doctor.',
  ],
  'classifier.skip': [
    'Skipped: live LinkedIn and Naukri actions stay refused until the model is fetched and pinned.',
  ],
  'access.intro': [
    'read_only is recommended: it shows stats, drafts and status, and cannot send or change anything.',
    'Move to outreach_send later, on purpose, after a dry run looked right. There is no skip here.',
  ],
  'limits.intro': [
    'Each cap lives in .env and is enforced in code, not by the agent. The shipped defaults are safe.',
    'Choose safe defaults unless you have a reason; you can rerun this step any time.',
  ],
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
