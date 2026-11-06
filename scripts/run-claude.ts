// scripts/run-claude.ts
// Interactive claude launcher for the setup guide (profile setup_guide, `--interactive`): renders the per-profile settings and policy, builds a
// scrubbed env and a fail-closed argv (all guards live in src/platform/runner.ts), then starts an INTERACTIVE claude on the terminal.
// There is no headless (`claude -p`) path any more: a profile that is not interactive is refused. Work for the agent runs in the worker windows.
// Usage: tsx scripts/run-claude.ts <profile> --interactive [prompt] [--print-args] [--no-classifier]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeArgs,
  buildInteractiveArgs,
  buildEnv,
  loadProfiles,
  renderPolicy,
  renderSettings,
} from '../src/platform/runner.js';
import { writeSecure } from '../src/platform/permissions.js';
import { parseEnv } from '../src/platform/envFile.js';
import { CLASSIFIER_SKIP_LINE, checkInteractiveUse, formatPrintArgs, spawnInteractive } from '../src/platform/interactive.js';
import { checkClassifierForLaunch } from '../src/platform/launchCheck.js';
import { isDryRun } from '../src/safety/dryRun.js';
import { stopActive } from './killSwitch.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

function die(code: number, msg: string): never {
  process.stderr.write(`run-claude: ${msg}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const profileName = argv[0];
  if (!profileName) die(2, 'usage: run-claude <profile> [flags] [--] [prompt]');
  // Launcher flags are honoured only before the prompt; "--" ends them.
  const flags = new Set<string>();
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--print-args' || a === '--no-classifier' || a === '--interactive') flags.add(a);
    else break;
  }
  const promptParts = argv.slice(i);

  let profiles;
  try {
    profiles = loadProfiles(join(root, 'config/run-profiles.json'), join(root, 'config/permission-sets.json'));
  } catch (e) {
    die(2, `cannot load profiles: ${(e as Error).message}`);
  }
  const profile = Object.prototype.hasOwnProperty.call(profiles, profileName) ? profiles[profileName] : undefined;
  if (!profile) die(2, `unknown profile: ${profileName}`);

  const outDir = join(root, 'debug/runner');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const settingsPath = join(outDir, `${profileName}.settings.json`);
  const policyPath = join(outDir, `${profileName}.policy.json`);
  const hookPath = '$CLAUDE_PROJECT_DIR/.claude/hooks/tool-allowlist.cjs';
  const policyRef = `$CLAUDE_PROJECT_DIR/debug/runner/${profileName}.policy.json`;

  // An allowlist profile also reads .env, but only to fill keys the process env lacks; buildEnv still passes
  // nothing that is not on the profile's allowlist (so the owner's limits reach the MCP servers of a wake).
  const dotenv: Record<string, string> = {};
  for (const f of profile.env_files ?? ['.env']) {
    const p = join(root, f);
    if (existsSync(p)) Object.assign(dotenv, parseEnv(readFileSync(p, 'utf8')));
  }

  const interactive = profile.interactive === true;
  const printOnly = flags.has('--print-args');
  // Kill switch first (--print-args only prints, as before).
  if (!printOnly) {
    const stop0 = stopActive(root, process.env);
    if (stop0.stopped) die(4, stop0.reason);
  }
  const tty = printOnly || (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
  const useErr = checkInteractiveUse(profile, flags.has('--interactive'), tty);
  if (useErr) die(2, useErr);
  if (!interactive) die(2, `profile ${profileName} is not interactive: the headless runner is gone, work runs in the worker windows (npm run up)`);

  const initialPrompt = promptParts.join(' ').trim();
  let args: string[];
  try {
    args = buildInteractiveArgs(profileName, profile, { settingsPath }, initialPrompt);
  } catch (e) {
    die(2, (e as Error).message);
  }
  const env = buildEnv(profile, profile.env_mode === 'allowlist' ? { ...dotenv, ...process.env } : process.env, dotenv);
  try {
    assertSafeArgs(args, env);
  } catch (e) {
    die(2, (e as Error).message);
  }

  writeSecure(settingsPath, JSON.stringify(renderSettings(profileName, profile, { hookPath, policyPath: policyRef }), null, 2));
  writeSecure(policyPath, JSON.stringify(renderPolicy(profileName, profile), null, 2));

  if (flags.has('--print-args')) {
    process.stdout.write(formatPrintArgs(args, env));
    process.exit(0);
  }

  if (flags.has('--no-classifier') && !isDryRun(process.env)) {
    die(2, '--no-classifier is only allowed with JOBBER_DRY_RUN=true');
  }

  if (profile.classifier === 'not_required') {
    // Only reachable for a profile that loadProfiles validated as having no MCP tools.
    process.stderr.write(`${CLASSIFIER_SKIP_LINE}\n`);
  } else if (!flags.has('--no-classifier')) {
    let check;
    try {
      check = await checkClassifierForLaunch(env, root, isDryRun(env));
    } catch (e) {
      die(3, `classifier not ready: ${(e as Error).message}`);
    }
    if (!check.ok) die(3, `classifier not ready: ${check.problems.join('; ')}`);
  }

  const ichild = spawnInteractive(spawn, args, env, root);
  ichild.on('error', (e) => die(1, `cannot start claude: ${e.message}`));
  ichild.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

main().catch((e) => die(1, (e as Error).message));
