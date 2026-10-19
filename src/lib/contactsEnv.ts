// The contacts MCP server reads its own Serper and Hunter settings from the project .env (finding 17):
// outreach_wake env_keys are deliberately NOT widened, so a wake's child env never carries these keys.
// Only the names below are copied, with the launchers' plain parser (src/platform/envFile.ts); values are
// never logged or returned (the result is the list of key NAMES that were set). Process env wins.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from '../platform/envFile.js';

export const CONTACTS_ENV_KEYS: readonly string[] = [
  'SERPER_API_KEY', 'SERPER_DAILY_BUDGET', 'SERPER_MONTHLY_BUDGET',
  'HUNTER_API_KEY', 'HUNTER_ENABLED', 'HUNTER_MONTHLY_CAP',
];

const DEFAULT_ENV_FILE = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), '.env');

export function loadContactsEnv(
  env: Record<string, string | undefined> = process.env,
  file: string = DEFAULT_ENV_FILE,
): string[] {
  const set: string[] = [];
  let parsed: Record<string, string>;
  try {
    if (!existsSync(file)) return set;
    parsed = parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return set;
  }
  for (const key of CONTACTS_ENV_KEYS) {
    const v = parsed[key];
    if (v === undefined || v === '') continue;
    if ((env[key] ?? '') !== '') continue;
    env[key] = v;
    set.push(key);
  }
  return set;
}
