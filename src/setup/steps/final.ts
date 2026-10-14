// src/setup/steps/final.ts
// Step 11: full doctor run and the owner-only next commands. Always 'done'; warnings are listed,
// and the runner's exit code reflects failed steps.
import { ccgramChecks, restrictedChecks } from '../../platform/checks.js';
import { setupChecks } from '../../platform/checksSetup.js';
import { formatReport, runChecks } from '../../platform/doctor.js';
import type { SetupStep } from '../runner.js';

export const finalStep: SetupStep = {
  id: 'final',
  title: 'Final doctor run',
  checkIds: [],
  async run(ctx) {
    const { io } = ctx;
    const results = await runChecks([...ccgramChecks, ...restrictedChecks(), ...setupChecks], ctx.doctor);
    io.say(formatReport(results));

    const open = results.filter((r) => r.result.status === 'warn' || r.result.status === 'skip');
    if (open.length > 0) {
      io.say('Still open:');
      for (const r of open) io.say(`  ${r.result.status}: ${r.id}: ${r.result.detail}`);
    }
    if (results.some((r) => r.result.status === 'fail')) {
      io.say('Some checks failed: fix them and run npm run setup again, or npm run doctor.');
    }
    io.say('Next, yourself:');
    io.say('  1. bash scripts/ccgram/start.sh');
    io.say('  2. Send /health from Telegram');
    io.say('  3. Run the first supervised /runhunt and read the outputs');
    return 'done';
  },
};
