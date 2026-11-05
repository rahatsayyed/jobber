// scripts/window-env.ts
// Called by scripts/claude-window.sh: `npx tsx scripts/window-env.ts <window>`.
// Checks the window is a `kind: worker` window of config/manager-windows.json, runs the classifier launch check (exit 3
// in live mode when it fails), writes .jobber/window-settings/<window>.json and prints the allowlisted environment as
// `KEY=value` lines on stdout (nothing else on stdout). Messages go to stderr and never contain env values.
// Exit codes: 0 ok, 1 refused (bad window or config), 3 classifier not ready.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mailDailyLimit } from '../src/scheduler/mailLimit.js';
import { linkedinStartValues } from '../src/scheduler/linkedinWindowStart.js';
import { wakeStartValues } from '../src/scheduler/wakeWindowStart.js';
import { loadManagerConfig } from '../src/platform/manager.js';
import { parseEnv } from '../src/platform/envFile.js';
import { checkClassifierForLaunch } from '../src/platform/launchCheck.js';
import { prepareWindowLaunch } from '../src/platform/windowLaunch.js';
import { windowEnvLines } from '../src/platform/windowEnv.js';
import { isDryRun } from '../src/safety/dryRun.js';

const ROOT = resolve(import.meta.dirname, '..');

function die(code: number, msg: string): never {
  process.stderr.write(`claude-window: ${msg}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) die(1, 'usage: window-env <window>');
  let cfg;
  try {
    cfg = loadManagerConfig(readFileSync(resolve(ROOT, 'config/manager-windows.json'), 'utf8'));
  } catch (e) {
    die(1, `config/manager-windows.json: ${(e as Error).message}`);
  }
  const w = Object.hasOwn(cfg.windows, name) ? cfg.windows[name] : undefined;
  if (!w || w.kind !== 'worker') die(1, `window ${name} is not a worker window in config/manager-windows.json`);
  let dotenv: Record<string, string> = {};
  try { dotenv = parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8')); } catch { /* no .env: process env only */ }
  const merged: NodeJS.ProcessEnv = { ...process.env, ...dotenv };
  let launch;
  try {
    launch = prepareWindowLaunch(ROOT, name, w, process.env, dotenv);
  } catch (e) {
    die(1, (e as Error).message);
  }
  // The mail window's SEND_LIMIT_PER_RUN is fixed for the window's life: derive it from EMAIL_MAX_PER_DAY like the headless
  // drip does (dripEnv). A change of EMAIL_MAX_PER_DAY needs a window restart; the doctor warns when the two differ.
  if (w.lane === 'mail') {
    launch.env.SEND_LIMIT_PER_RUN = String(mailDailyLimit(merged));
    try {
      const p = resolve(ROOT, '.jobber', 'window-start', `${name}.json`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify({ SEND_LIMIT_PER_RUN: launch.env.SEND_LIMIT_PER_RUN, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    } catch { /* the record is only for the doctor */ }
  }
  // The linkedin window also reads these once at start (dry run, Easy Apply switch, daily limits): record them for the doctor and for
  // the lane's dry-run guard. A change needs a window restart. Values only of the listed keys, never secrets.
  if (w.lane === 'linkedin') {
    try {
      const p = resolve(ROOT, '.jobber', 'window-start', `${name}.json`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify({ ...linkedinStartValues(launch.env), at: new Date().toISOString() })}\n`, { mode: 0o600 });
    } catch { /* the record is only for the doctor */ }
  }
  // The windows of the `wake` lane (sources, pipeline, boards, apply) also read the dry-run flag and the daily limits once at start: record them
  // the same way (the wake refuses to type into a window that started live while the scheduler is dry; the doctor warns on a change).
  if (w.lane === 'wake') {
    try {
      const p = resolve(ROOT, '.jobber', 'window-start', `${name}.json`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify({ ...wakeStartValues(launch.env), at: new Date().toISOString() })}\n`, { mode: 0o600 });
    } catch { /* the record is only for the doctor */ }
  }
  let check;
  try {
    check = await checkClassifierForLaunch(merged, ROOT, isDryRun(merged));
  } catch (e) {
    die(3, `classifier not ready: ${(e as Error).message}`);
  }
  if (!check.ok) die(3, `classifier not ready: ${check.problems.join('; ')}`);
  process.stdout.write(`${windowEnvLines(launch.env).join('\n')}\n`);
}

void main();
