// src/setup/steps/claude.ts
// Step 2: Claude Code installed and logged in. Login is judged by the claude-login doctor
// check (`claude auth status` exit code); the one-token probe is only a fallback when that
// check cannot verify, and always behind a confirm.
import { runChecks } from '../../platform/doctor.js';
import type { SetupContext, SetupStep } from '../runner.js';
import { checksById, printProblems } from './prereqs.js';

const MAX_ROUNDS = 3;

async function probeLogin(ctx: SetupContext): Promise<boolean> {
  if (!(await ctx.io.confirm('Run one small test message to verify login?', true))) return false;
  const r = await ctx.run('claude', ['-p', 'Reply with the single word ok', '--max-turns', '1']);
  return r.code === 0;
}

export const claudeStep: SetupStep = {
  id: 'claude',
  title: 'Claude Code login',
  checkIds: ['claude-cli', 'claude-login'],
  async run(ctx) {
    const [cliCheck, loginCheck] = checksById(['claude-cli', 'claude-login']);
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const [cli] = await runChecks([cliCheck], ctx.doctor);
      if (cli.result.status === 'fail') {
        ctx.io.say('Install Claude Code, then run: claude');
        await ctx.io.pause('Press Enter when Claude Code is installed');
        continue;
      }
      const [login] = await runChecks([loginCheck], ctx.doctor);
      const status = login.result.status;
      if (status === 'pass') {
        ctx.io.say('Claude Code is logged in.');
        return 'done';
      }
      if (status === 'warn' && /cannot verify/i.test(login.result.detail)) {
        if (await probeLogin(ctx)) return 'done';
      } else {
        printProblems(ctx, [login]);
      }
      ctx.io.say('Run "claude" in another terminal and complete the login, then press Enter');
      await ctx.io.pause('Press Enter when you are logged in');
    }
    throw new Error('Claude Code is not logged in');
  },
};
