// scripts/web.ts
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbPath } from '../src/dbPath.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { buildSnapshot } from '../src/status/snapshot.js';
import { capture, defaultRun, sendText } from '../src/platform/tmux.js';
import { parseEnv } from '../src/platform/envFile.js';
import { secretValuesFromEnv } from '../src/safety/outputGate.js';
import { parseWebEnv } from '../src/web/env.js';
import { startWebServer } from '../src/web/server.js';

process.on('unhandledRejection', () => {});

async function main(): Promise<number> {
  const envFile = join(process.cwd(), '.env');
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
  const parsed = parseWebEnv(env);
  if (!parsed.ok) {
    console.error(`web: ${parsed.error}`);
    return 1;
  }
  const { token, port, session, window } = parsed.config;
  const secrets = secretValuesFromEnv(env as NodeJS.ProcessEnv);
  try {
    await startWebServer({
      token,
      port,
      secrets,
      getSnapshot: async () => {
        const path = dbPath();
        if (path !== ':memory:' && !existsSync(path)) throw new Error('no database');
        const db = new Database(path, { readonly: true, fileMustExist: true });
        try {
          return buildSnapshot(db, loadOutreachConfig(), new Date());
        } finally {
          db.close();
        }
      },
      capture: () => capture(defaultRun, session, window, 40),
      send: (text) => sendText(defaultRun, session, window, text),
    });
  } catch (e) {
    console.error(`web: could not start: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
    return 1;
  }
  console.log(`http://127.0.0.1:${port}`);
  return -1; // keep running
}

main().then((c) => {
  if (c >= 0) process.exit(c);
});
