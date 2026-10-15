// scripts/bootstrap.ts
// Usage: npm run bootstrap -- [--check|--plan] [--yes] [--allow-sudo] [--only a,b] [--with-optional] [--skip-model] [--json]
// Exit: 0 required present, 1 required failed or needs owner, 2 usage, 3 non-interactive needs --yes, 4 unsupported platform.
// Never prints process.env.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCatalog } from '../src/bootstrap/catalog.js';
import { exitCodeFor, renderTable, runBootstrap, type ExecDeps, type ExecOptions, type ItemResult } from '../src/bootstrap/exec.js';
import type { CcgramPin, ItemId, Platform } from '../src/bootstrap/types.js';
import { defaultRun } from '../src/platform/tmux.js';

const IDS: ItemId[] = ['git', 'build-tools', 'node', 'npm-deps', 'renderer-deps', 'playwright-chromium', 'chrome', 'tmux', 'uv', 'ccgram', 'claude-cli', 'age', 'rclone', 'classifier-model'];

export const USAGE = [
  'usage: npm run bootstrap -- [options]',
  '  --check            detect only, change nothing',
  '  --plan             show what would run, run nothing',
  '  --yes              accept plain (non-sudo) actions',
  '  --allow-sudo       with --yes, also accept sudo actions',
  '  --only <id>[,<id>] limit to these items',
  '  --with-optional    also offer report-only optional items',
  '  --skip-model       skip the classifier model',
  '  --json             print the ItemResult[] as JSON only',
  '  --help             this text',
];

export interface Parsed {
  yes: boolean;
  allowSudo: boolean;
  check: boolean;
  plan: boolean;
  only?: ItemId[];
  withOptional: boolean;
  skipModel: boolean;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): { ok: true; args: Parsed } | { ok: false; error: string } {
  const a: Parsed = { yes: false, allowSudo: false, check: false, plan: false, withOptional: false, skipModel: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--yes') a.yes = true;
    else if (t === '--allow-sudo') a.allowSudo = true;
    else if (t === '--check') a.check = true;
    else if (t === '--plan') a.plan = true;
    else if (t === '--with-optional') a.withOptional = true;
    else if (t === '--skip-model') a.skipModel = true;
    else if (t === '--json') a.json = true;
    else if (t === '--help') a.help = true;
    else if (t === '--only') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return { ok: false, error: '--only needs a value' };
      const ids = v.split(',').filter(Boolean);
      const bad = ids.find((x) => !IDS.includes(x as ItemId));
      if (bad || ids.length === 0) return { ok: false, error: `unknown item: ${bad ?? v}` };
      a.only = [...(a.only ?? []), ...(ids as ItemId[])];
    } else return { ok: false, error: `unknown argument: ${t.slice(0, 40)}` };
  }
  if (a.check && a.plan) return { ok: false, error: '--check and --plan are exclusive' };
  return { ok: true, args: a };
}

export interface MainDeps extends ExecDeps {
  interactive: boolean;
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  const p = parseArgs(argv);
  if (!p.ok) {
    deps.say(p.error);
    for (const l of USAGE) deps.say(l);
    return 2;
  }
  const args = p.args;
  if (args.help) {
    for (const l of USAGE) deps.say(l);
    return 0;
  }
  let pin: CcgramPin;
  let engines = '>=20';
  let modelProfile = 'unresolved';
  let modelError: string | null = null;
  try {
    pin = JSON.parse(deps.fs.read(join(deps.root, 'config', 'ccgram.pin.json'))) as CcgramPin;
    engines = (JSON.parse(deps.fs.read(join(deps.root, 'package.json'))) as { engines?: { node?: string } }).engines?.node ?? engines;
  } catch (e) {
    deps.say(`cannot read config: ${String((e as Error).message).slice(0, 120)}`);
    return 1;
  }
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const envModel = deps.env.BOOTSTRAP_MODEL_PROFILE;
  if (envModel !== undefined && envModel !== '') {
    if (ID_RE.test(envModel)) modelProfile = envModel;
    else modelError = 'BOOTSTRAP_MODEL_PROFILE is not a valid profile id';
  } else {
    try {
      const d = (JSON.parse(deps.fs.read(join(deps.root, 'config', 'classifier-models.json'))) as { default_profile?: unknown }).default_profile;
      if (typeof d === 'string' && ID_RE.test(d)) modelProfile = d;
      else modelError = 'config/classifier-models.json has no valid default_profile';
    } catch {
      modelError = 'cannot read config/classifier-models.json for the default classifier profile';
    }
  }
  const items = buildCatalog({
    pin,
    engines,
    hasRenderer: deps.fs.exists(join(deps.root, 'renderer', 'package.json')),
    modelProfile,
    ...(modelError
      ? {
          detectClassifier: async (): Promise<never> => {
            throw new Error(modelError!);
          },
        }
      : {}),
  });
  const exec: ExecDeps = { ...deps, say: args.json ? () => {} : deps.say };
  const opts: ExecOptions = {
    yes: args.yes,
    allowSudo: args.allowSudo,
    checkOnly: args.check,
    planOnly: args.plan,
    withOptional: args.withOptional,
    skipModel: args.skipModel,
    interactive: deps.interactive,
    ...(args.only ? { only: args.only } : {}),
  };
  const results: ItemResult[] = await runBootstrap(items, exec, opts);
  if (args.json) deps.say(JSON.stringify(results, null, 2));
  else deps.say(renderTable(results));
  if (deps.platform === 'unsupported' && !results.some((r) => r.outcome === 'ok')) return 4;
  const code = exitCodeFor(results);
  const needsAction = results.some((r) => /needs --yes|needs sudo|needs a terminal/.test(r.note));
  if (!deps.interactive && !args.yes && !args.check && !args.plan && needsAction) return 3;
  return code;
}

function realDeps(): MainDeps {
  const platform: Platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'unsupported';
  return {
    platform,
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { BOOTSTRAP_MODEL_PROFILE: process.env.BOOTSTRAP_MODEL_PROFILE, PATH: process.env.PATH, HOME: process.env.HOME },
    run: defaultRun,
    fs: {
      exists: (p) => existsSync(p),
      read: (p) => readFileSync(p, 'utf8'),
      list: (p) => {
        try {
          return readdirSync(p);
        } catch {
          return [];
        }
      },
    },
    now: () => new Date(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    say: (l) => console.log(l),
    ask: async (prompt) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${prompt} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    mkTempDir: () => {
      const d = mkdtempSync(join(tmpdir(), `jobber-bootstrap-${randomBytes(4).toString('hex')}-`));
      chmodSync(d, 0o700);
      return d;
    },
    download: async (url, destDir) => {
      if (!/^https:\/\//.test(url)) throw new Error('download refused: https only');
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const path = join(destDir, 'download.sh');
      writeFileSync(path, buf, { mode: 0o600 });
      return { path, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), realDeps()).then(
    (c) => {
      process.exitCode = c;
    },
    (e) => {
      console.error(String((e as Error).message ?? e).slice(0, 200));
      process.exitCode = 1;
    },
  );
}
