// src/setup/steps/final.ts
// Step 11: full doctor run and the owner-only next commands. Always 'done'; warnings are listed,
// and the runner's exit code reflects failed steps.
import path from 'node:path';
import { ccgramChecks, restrictedChecks } from '../../platform/checks.js';
import { looseDbFiles, setupChecks } from '../../platform/checksSetup.js';
import { formatReport, runChecks } from '../../platform/doctor.js';
import { parseEnv } from '../../platform/envFile.js';
import type { SetupStep } from '../runner.js';
import { SKIP_SPECS, skippedFeatures, type SkippableId } from '../skips.js';

// Open non-skippable items that block going live, by doctor check id.
// Only fail and warn are open; a skip (offline, owner-run, skipped feature) is never listed.
// permission-set also warns for the deliberate `full` and `custom` sets, which are a finished
// choice: only a failure or the "no .claude/settings.local.json yet" warning counts as open.
const NOT_READY: {
  id: string;
  label: string;
  stepId: string;
  open?: (r: { status: string; detail: string }) => boolean;
}[] = [
  { id: 'classifier_model', label: 'Classifier model or fit', stepId: 'classifier' },
  {
    id: 'permission-set',
    label: 'Permission set',
    stepId: 'access',
    open: (r) => r.status === 'fail' || (r.status === 'warn' && r.detail.startsWith('no .claude/settings.local.json')),
  },
  { id: 'resume-valid', label: 'Resume', stepId: 'resume' },
  { id: 'profile-valid', label: 'Profile', stepId: 'profile' },
];

export const finalStep: SetupStep = {
  id: 'final',
  title: 'Final doctor run',
  checkIds: [],
  always: true,
  async run(ctx) {
    const { io } = ctx;
    // The database is created world-readable by default; offer to fix it before the report.
    // Only modes are touched: the database itself is never opened or read.
    const loose = looseDbFiles(ctx.doctor);
    if (loose.length > 0 && (await io.confirm('Make data.sqlite owner-only (chmod 600)?', true))) {
      for (const f of loose) {
        try {
          ctx.fs.chmod(f, 0o600);
        } catch {
          io.say(`Could not change the mode of ${path.basename(f)}; run: chmod 600 ${path.basename(f)}`);
        }
      }
    }
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
    // Skipped by choice: recorded skips that are still unconfigured (state and .env, no secrets).
    let skipped: SkippableId[] = [];
    try {
      let fileEnv: Record<string, string> = {};
      if (ctx.envPath && ctx.fs.exists(ctx.envPath)) fileEnv = parseEnv(ctx.fs.read(ctx.envPath));
      skipped = skippedFeatures({
        state: ctx.state,
        env: { ...fileEnv, ...ctx.env },
        fs: ctx.fs,
        root: ctx.root,
      });
    } catch {
      skipped = [];
    }
    if (skipped.length > 0) {
      io.say('Skipped by choice:');
      for (const id of skipped) {
        const spec = SKIP_SPECS.find((s) => s.id === id);
        if (!spec) continue;
        io.say(`  ${spec.title}: ${spec.lose[0]}`);
        io.say(`    re-enable: npm run setup -- --step ${spec.stepId}`);
      }
    }

    // Not ready for live: open items that are not skippable, from the doctor results above.
    const notReady = NOT_READY.filter((n) => {
      const r = results.find((x) => x.id === n.id);
      if (r === undefined) return false;
      if (n.open) return n.open(r.result);
      return r.result.status === 'fail' || r.result.status === 'warn';
    });
    if (notReady.length > 0) {
      io.say('Not ready for live:');
      for (const n of notReady) io.say(`  ${n.label}: npm run setup -- --step ${n.stepId}`);
    }

    const next: string[] = [];
    if (!skipped.includes('telegram')) {
      next.push('bash scripts/ccgram/start.sh');
      next.push('Send /health from Telegram');
    }
    if (!skipped.includes('dashboard')) next.push('npm run dashboard -- token (sign-in link for the status page)');
    next.push('npm run dry-run (end-to-end check in dry mode, sends nothing)');
    next.push('npm start, same as npm run up (starts the bridge, windows, scheduler and dashboard after the doctor gate)');
    next.push('Run the first supervised /runhunt and read the outputs');
    io.say('Next, yourself:');
    next.forEach((l, i) => io.say(`  ${i + 1}. ${l}`));
    return 'done';
  },
};
