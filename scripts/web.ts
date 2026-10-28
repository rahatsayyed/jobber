// Public dashboard launcher. The legacy node server is an internal, loopback-only
// API; the Next.js application is the only browser-facing dashboard process.
import { existsSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { parseEnv } from '../src/platform/envFile.js';
import { validateRunnerConfig } from '../src/web/env.js';

const APP_DIR = 'apps/dashboard';
const STARTUP_TIMEOUT_MS = 20_000;
const CLEAN_ENV_KEYS = ['HOME', 'PATH', 'TERM', 'LANG', 'TZ'] as const;

function internalPort(env: Record<string, string | undefined>, publicPort: number): number | null {
  const raw = (env.WEB_INTERNAL_PORT ?? '').trim();
  if (raw === '') return publicPort === 65535 ? null : publicPort + 1;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1024 && value <= 65535 && value !== publicPort ? value : null;
}

function readEnv(): Record<string, string | undefined> {
  const file = join(process.cwd(), '.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

function dashboardReady(): boolean {
  return existsSync(join(APP_DIR, 'node_modules', 'next')) && existsSync(join(APP_DIR, '.next', 'BUILD_ID'));
}

function childEnv(additions: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CLEAN_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...additions };
}

function runnerEnv(env: Record<string, string | undefined>, apiPort: number): NodeJS.ProcessEnv {
  const values: Record<string, string> = { WEB_INTERNAL_PORT: String(apiPort) };
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') values[key] = value;
  return childEnv(values);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
}

async function waitForApi(port: number, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return true;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function runDashboard(): Promise<number> {
  const env = readEnv();
  const validated = validateRunnerConfig(env, { accountStored: true });
  if (!validated.ok) {
    for (const error of validated.errors) console.error(`web: ${error.message}`);
    return 1;
  }
  const config = validated.config;
  const apiPort = internalPort(env, config.port);
  if (apiPort === null) {
    console.error('web: WEB_INTERNAL_PORT must be an integer from 1024 to 65535 different from WEB_PORT');
    return 1;
  }
  if (!dashboardReady()) {
    console.error('web: the Next.js dashboard is not built; run npm run bootstrap -- --only npm-deps (or npm run web:next:build)');
    return 1;
  }

  const api = run('npx', ['tsx', 'scripts/web-api.ts'], runnerEnv(env, apiPort));
  const stopApi = (): void => { if (api.exitCode === null) api.kill('SIGTERM'); };
  const stop = (): void => stopApi();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    if (!(await waitForApi(apiPort, api))) {
      console.error('web: protected API did not start');
      return await waitForExit(api);
    }
    const appEnv = { ...runnerEnv(env, apiPort), JOBBER_API_ORIGIN: `http://127.0.0.1:${apiPort}` };
    console.log(`http://${config.bind}:${config.port}`);
    const next = run('npm', ['--prefix', APP_DIR, 'run', 'start', '--', '--hostname', config.bind, '--port', String(config.port)], appEnv);
    return await waitForExit(next);
  } finally {
    stopApi();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

runDashboard().then((code) => { process.exitCode = code; });
