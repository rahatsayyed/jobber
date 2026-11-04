// scripts/window-env.ts
// Called by scripts/claude-window.sh: `npx tsx scripts/window-env.ts <window>`.
// Checks the window is a `kind: worker` window of config/manager-windows.json, runs the classifier launch check (exit 3
// in live mode when it fails), writes .jobber/window-settings/<window>.json and prints the allowlisted environment as
// `KEY=value` lines on stdout (nothing else on stdout). Messages go to stderr and never contain env values.
// Exit codes: 0 ok, 1 refused (bad window or config), 3 classifier not ready.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
