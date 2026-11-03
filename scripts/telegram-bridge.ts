// scripts/telegram-bridge.ts
// `npm run telegram:bridge`: the Telegram bridge daemon (grammY long polling). Meant for window `bridge` of the stack session.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from '../src/platform/envFile.js';
import { runBridge } from '../src/telegram/bridge.js';
import { PROJECT_ROOT } from '../src/telegram/config.js';

function loadEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const f = path.join(PROJECT_ROOT, '.env');
  if (existsSync(f)) {
    for (const [k, v] of Object.entries(parseEnv(readFileSync(f, 'utf8')))) {
      if (env[k] === undefined) env[k] = v;
    }
  }
  return env;
}

process.exitCode = await runBridge(loadEnv(), PROJECT_ROOT);
