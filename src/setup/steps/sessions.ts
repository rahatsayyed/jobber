// src/setup/steps/sessions.ts
// Step 5: LinkedIn (main) and Naukri browser sessions, captured by npm run linkedin:login and
// npm run naukri:login in headed real Chrome. The step never reads a state file: presence comes from
// fs.exists and validity from the doctor `sessions` check.
import path from 'node:path';
import { setupAccountChecks } from '../../platform/checksSetup.js';
import { runChecks } from '../../platform/doctor.js';
import { say } from '../coach.js';
import type { SetupContext, SetupStep } from '../runner.js';

interface Account {
  name: string;
  label: string; // matches the doctor check's label
  file: string;
  argv: string[];
  who: string;
}

const ACCOUNTS: Account[] = [
  {
    name: 'linkedin_main',
    label: 'LinkedIn main',
    file: 'linkedin-main-state.json',
    argv: ['tsx', 'scripts/linkedin-login.ts', '--account', 'main'],
    who: 'your MAIN LinkedIn account (connection requests and messages)',
  },
  {
    name: 'naukri',
    label: 'Naukri',
    file: 'naukri-state.json',
    argv: ['tsx', 'scripts/naukri-login.ts', '--account', 'main'],
    who: 'your Naukri account',
  },
];

// Did the doctor check flag this account (expired, wrong mode, no cookies)?
async function flagged(ctx: SetupContext, label: string): Promise<boolean> {
  const check = setupAccountChecks.find((c) => c.id === 'sessions');
  if (!check) return false;
  const [r] = await runChecks([check], ctx.doctor);
  return r.result.detail.includes(`${label}:`);
}

export const sessionsStep: SetupStep = {
  id: 'sessions',
  title: 'LinkedIn and Naukri sessions',
  checkIds: ['sessions'],
  async run(ctx) {
    const { io } = ctx;
    const dir = path.join(ctx.root, 'secrets');
    ctx.fs.mkdirp(dir, 0o700);
    io.say('Safety rule: log in the MAIN LinkedIn account and your own Naukri account, in real Chrome.');
    io.say('The login commands pass --account main, so no environment variable is needed.');

    say(ctx, 'sessions.why');
    say(ctx, 'sessions.window');

    for (const a of ACCOUNTS) {
      const out = path.join(dir, a.file);
      const answerKey = `session_${a.name}`;
      if (ctx.fs.exists(out) && !(await flagged(ctx, a.label))) {
        if (!(await io.confirm(`${a.label} session already captured. Redo it?`, false))) {
          io.say(`${a.label}: keeping the existing session`);
          continue;
        }
      } else if (!(await io.confirm(`Capture the ${a.label} session now?`, true))) {
        ctx.state.answers[answerKey] = 'skipped';
        io.say(`${a.label}: skipped. Run later: npx ${a.argv.join(' ')}`);
        say(ctx, `sessions.lose.${a.name}`);
        continue;
      }
      io.say(`A Chrome window opens. Log in with ${a.who}, then return here and press Enter.`);
      const code = await ctx.spawnInteractive('npx', a.argv);
      if (ctx.fs.exists(out)) ctx.fs.chmod(out, 0o600);
      if (code !== 0) {
        io.say(`${a.label}: capture exited with code ${code}`);
        continue;
      }
      delete ctx.state.answers[answerKey];
    }
    return 'done';
  },
};
