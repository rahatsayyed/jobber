// src/setup/steps/prereqs.ts
// Step 1: prerequisites. Prints each failing check's fix verbatim; never runs an installer.
import { ccgramChecks } from '../../platform/checks.js';
import { setupChecks } from '../../platform/checksSetup.js';
import type { Check, CheckOutcome } from '../../platform/doctor.js';
import { runChecks } from '../../platform/doctor.js';
import { say } from '../coach.js';
import type { SetupContext, SetupStep } from '../runner.js';

const ALL_CHECKS: Check[] = [...ccgramChecks, ...setupChecks];
const MAX_ROUNDS = 3;

/** The known doctor checks with these ids, in the given order. */
export function checksById(ids: string[]): Check[] {
  return ids
    .map((id) => ALL_CHECKS.find((c) => c.id === id))
    .filter((c): c is Check => c !== undefined);
}

/** Print a failing or warning check's detail and fix verbatim; returns how many were printed. */
export function printProblems(ctx: SetupContext, results: CheckOutcome[]): number {
  let n = 0;
  for (const r of results) {
    if (r.result.status !== 'fail' && r.result.status !== 'warn') continue;
    n++;
    ctx.io.say(`${r.title}: ${r.result.detail}`);
    if (r.result.fix) ctx.io.say(`  fix: ${r.result.fix}`);
  }
  return n;
}

export const prereqsStep: SetupStep = {
  id: 'prereqs',
  title: 'Prerequisites',
  checkIds: ['node-version', 'tmux', 'chrome', 'browser-binaries', 'ccgram-version'],
  async run(ctx) {
    say(ctx, 'prereqs.intro');
    const checks = checksById(prereqsStep.checkIds);
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const results = await runChecks(checks, ctx.doctor);
      if (printProblems(ctx, results) === 0) {
        ctx.io.say('All prerequisites found.');
        return 'done';
      }
      if (round === MAX_ROUNDS) break;
      await ctx.io.pause('Run the commands above, then press Enter');
    }
    ctx.io.say('Some prerequisites are still missing. Fix them (or run bash scripts/bootstrap.sh) and run setup again.');
    return 'done';
  },
};
