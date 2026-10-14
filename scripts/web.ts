// scripts/web.ts
// Minimal runner for the dashboard server (Task 12 replaces this with the full env validation and doctor checks).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { defaultRun, assertClaudePane, sendText } from '../src/platform/tmux.js';
import { parseEnv } from '../src/platform/envFile.js';
import { secretValuesFromEnv } from '../src/safety/outputGate.js';
import { parseWebEnv } from '../src/web/env.js';
import { redactSecrets, startWebServer } from '../src/web/server.js';
import { openAuthStore } from '../src/dash/authStore.js';
import { createOidc } from '../src/dash/oidc.js';
import { openReadOnlyDb } from '../src/dash/readDb.js';

let maskLiterals: string[] = [];
process.on('unhandledRejection', (reason) => {
  try {
    const msg = String((reason as { message?: unknown })?.message ?? reason).split('\n')[0];
    console.error(`web: unhandled rejection: ${redactSecrets(msg, maskLiterals).slice(0, 200)}`);
  } catch {
    console.error('web: unhandled rejection');
  }
});

async function main(): Promise<number> {
  const envFile = join(process.cwd(), '.env');
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
  const secrets = secretValuesFromEnv(env as NodeJS.ProcessEnv);
  maskLiterals = secrets;
  const parsed = parseWebEnv(env);
  if (!parsed.ok) {
    console.error(`web: ${parsed.error}`);
    return 1;
  }
  const { port, session, window } = parsed.config;
  const issuer = env.WEB_OIDC_ISSUER || 'https://accounts.google.com';
  const clientId = env.WEB_OIDC_CLIENT_ID ?? '';
  const clientSecret = env.WEB_OIDC_CLIENT_SECRET ?? '';
  const redirectUri = env.WEB_OIDC_REDIRECT_URI ?? '';
  if (!clientId || !clientSecret || !redirectUri) {
    console.error('web: WEB_OIDC_CLIENT_ID, WEB_OIDC_CLIENT_SECRET and WEB_OIDC_REDIRECT_URI are required');
    return 1;
  }
  const reauthMaxAgeSec = Number(env.WEB_REAUTH_MAX_AGE_SEC ?? '300') || 300;
  const reauthPrompt = env.WEB_OIDC_REAUTH_PROMPT === 'login' ? 'login' : 'select_account';
  try {
    const oidc = createOidc(
      { issuer, clientId, clientSecret, redirectUri, reauthPrompt, maxAgeSec: reauthMaxAgeSec },
      { fetch, now: () => new Date(), random: (n) => randomBytes(n) },
    );
    await startWebServer({
      port,
      bind: '127.0.0.1',
      allowRemoteBind: false,
      allowedHosts: [],
      trustProxy: false,
      auth: openAuthStore(env.WEB_AUTH_DB || '.dashboard/auth.sqlite'),
      oidc,
      oidcCfg: { redirectUri, reauthMaxAgeSec },
      data: openReadOnlyDb(),
      cfg: loadOutreachConfig(),
      run: defaultRun,
      sessionsToShow: [session],
      secrets: [...secrets, clientSecret].filter(Boolean),
      chat: {
        enabled: false,
        session,
        window,
        send: async (text) => {
          await assertClaudePane(defaultRun, session, window);
          await sendText(defaultRun, session, window, text);
        },
      },
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
