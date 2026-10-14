// src/setup/steps/sessions.ts
// Step 5: LinkedIn (burner, main) and Naukri browser sessions, captured by the existing
// scripts in a headed browser. The step never reads a state file: presence comes from
// fs.exists and validity from the doctor `sessions` check.
import path from 'node:path';
import { setupAccountChecks } from '../../platform/checksSetup.js';
import { runChecks } from '../../platform/doctor.js';
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
    name: 'linkedin_burner',
    label: 'LinkedIn burner',
    file: 'linkedin-burner-state.json',
    argv: ['tsx', 'scripts/save-linkedin-session.ts', 'burner'],
    who: 'your BURNER LinkedIn account (used only for Easy Apply)',
  },
  {
    name: 'linkedin_main',
    label: 'LinkedIn main',
    file: 'linkedin-main-state.json',
    argv: ['tsx', 'scripts/save-linkedin-session.ts', 'main'],
    who: 'your MAIN LinkedIn account (used only for connection requests)',
  },
  {
    name: 'naukri',
    label: 'Naukri',
    file: 'naukri-state.json',
    argv: ['tsx', 'scripts/save-naukri-session.ts'],
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
    io.say('Safety rule: the BURNER LinkedIn account is for applying, the MAIN account is for');
    io.say('connection requests. They are never swapped: log in to the right one for each prompt.');

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
        continue;
      }
      io.say(`A browser window opens. Log in with ${a.who}, then return here and press Enter.`);
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
