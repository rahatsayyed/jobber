// scripts/run-claude.ts
// Restricted claude launcher: renders per-profile settings and policy, builds a scrubbed env and
// a fail-closed argv (all guards live in src/platform/runner.ts), then spawns claude with the
// prompt on stdin only.
// Usage: tsx scripts/run-claude.ts <profile> [prompt] [--print-args] [--no-classifier]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeArgs,
  buildClaudeArgs,
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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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

  const dotenv: Record<string, string> = {};
  if (profile.env_mode === 'dotenv_all') {
    for (const f of profile.env_files ?? ['.env']) {
      const p = join(root, f);
      if (existsSync(p)) Object.assign(dotenv, parseEnv(readFileSync(p, 'utf8')));
    }
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

  const initialPrompt = promptParts.join(' ').trim();
  let args: string[];
  try {
    args = interactive
      ? buildInteractiveArgs(profileName, profile, { settingsPath }, initialPrompt)
      : buildClaudeArgs(profileName, profile, { settingsPath });
  } catch (e) {
    die(2, (e as Error).message);
  }
  const env = buildEnv(profile, process.env, dotenv);
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

  let prompt = '';
  if (!interactive) {
    prompt = promptParts.length > 0 ? promptParts.join(' ') : await readStdin();
    prompt = prompt.trim();
    if (!prompt) die(2, 'empty prompt');
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

  if (interactive) {
    const ichild = spawnInteractive(spawn, args, env, root);
    ichild.on('error', (e) => die(1, `cannot start claude: ${e.message}`));
    ichild.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }

  const child = spawn('claude', args, { env, stdio: ['pipe', 'inherit', 'inherit'], cwd: root });
  child.on('error', (e) => die(1, `cannot start claude: ${e.message}`));
  child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.stdin.on('error', () => undefined);
  child.stdin.end(prompt);
}

main().catch((e) => die(1, (e as Error).message));
