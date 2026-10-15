// scripts/web.ts
// Dashboard runner: thin wiring. All validation lives in src/web/env.ts (pure, unit-tested).
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { defaultRun, assertClaudePane, sendText } from '../src/platform/tmux.js';
import { parseEnv } from '../src/platform/envFile.js';
import { secretValuesFromEnv } from '../src/safety/outputGate.js';
import { validateRunnerConfig } from '../src/web/env.js';
import { redactSecrets, startWebServer } from '../src/web/server.js';
import { openAuthStore, getAllowedAccount } from '../src/dash/authStore.js';
import { allowAccount } from '../src/dash/account.js';
import { createOidc } from '../src/dash/oidc.js';
import { tokenStatus } from '../src/dash/accessToken.js';
import { loadDesktopKeys, keysFailureMessage, type DesktopClient } from '../src/dash/desktopClient.js';
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

  // Pass 1 without the account requirement: configuration problems are reported before any file is created.
  const early = validateRunnerConfig(env, { accountStored: true });
  if (!early.ok) {
    for (const e of early.errors) console.error(`web: ${e.message}`);
    return 1;
  }
  const cfg = early.config;
  const tokenMode = cfg.authMode === 'token';
  let desktop: DesktopClient | null = null;
  if (cfg.authMode === 'google_desktop') {
    const keysPath = isAbsolute(cfg.googleKeysPath) ? cfg.googleKeysPath : join(process.cwd(), cfg.googleKeysPath);
    const k = loadDesktopKeys(keysPath, (p) => readFileSync(p, 'utf8'));
    if (!k.ok) {
      console.error(`web: ${keysFailureMessage(k.reason)}`);
      return 1;
    }
    desktop = k.client;
    maskLiterals = [...maskLiterals, k.client.clientSecret];
  }

  const authPath = isAbsolute(cfg.authDb) ? cfg.authDb : join(process.cwd(), cfg.authDb);
  let auth;
  try {
    auth = openAuthStore(authPath);
  } catch (e) {
    console.error(`web: could not open the auth store: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
    return 1;
  }
  let stored = getAllowedAccount(auth) !== null;
  const full = validateRunnerConfig(env, { accountStored: stored });
  if (!full.ok) {
    for (const e of full.errors) console.error(`web: ${e.message}`);
    return 1;
  }
  if (!tokenMode && !stored && cfg.allowedEmail) {
    const r = allowAccount(auth, cfg.allowedEmail, new Date());
    if (!r.ok) {
      console.error('web: DASHBOARD_ALLOWED_EMAIL is not a valid email address');
      return 1;
    }
    stored = true;
    console.error('web: allowed account created from DASHBOARD_ALLOWED_EMAIL (the first sign-in pins it)');
  }

  let data;
  try {
    data = openReadOnlyDb();
  } catch {
    console.error('web: the data database is missing or cannot be opened read-only; run the hunt once or check JOBAPPLIER_DB');
    return 1;
  }

  let oidc: ReturnType<typeof createOidc> | undefined;
  if (!tokenMode) {
    oidc = createOidc(
      {
        issuer: desktop ? 'https://accounts.google.com' : cfg.issuer,
        clientId: desktop ? desktop.clientId : cfg.clientId,
        clientSecret: desktop ? desktop.clientSecret : cfg.clientSecret,
        redirectUri: cfg.redirectUri,
        reauthPrompt: desktop ? 'select_account' : cfg.reauthPrompt,
        maxAgeSec: cfg.reauthMaxAgeSec,
      },
      { fetch, now: () => new Date(), random: (n) => randomBytes(n) },
    );
    try {
      await oidc.discover();
    } catch {
      console.error('web: warning: OIDC discovery failed at start; it will be retried on the first login');
    }
  }
  if (tokenMode && !tokenStatus(auth).set) {
    console.error('web: no access token yet: run npm run dashboard -- token');
  }

  try {
    await startWebServer({
      port: cfg.port,
      bind: cfg.bind,
      allowRemoteBind: cfg.allowRemoteBind,
      allowedHosts: cfg.allowedHosts,
      trustProxy: cfg.trustProxy,
      auth,
      authMode: cfg.authMode,
      ...(tokenMode ? {} : {
        oidc,
        oidcCfg: { redirectUri: cfg.redirectUri, reauthMaxAgeSec: cfg.reauthMaxAgeSec },
        ...(desktop ? { googleRedirectShape: cfg.googleRedirectShape } : {}),
      }),
      data,
      cfg: loadOutreachConfig(),
      run: defaultRun,
      sessionsToShow: [cfg.session],
      secrets: [...secrets, cfg.clientSecret, ...(desktop ? [desktop.clientSecret] : [])].filter(Boolean),
      chat: {
        enabled: cfg.chatEnabled,
        session: cfg.session,
        window: cfg.window,
        send: async (text) => {
          await assertClaudePane(defaultRun, cfg.session, cfg.window);
          await sendText(defaultRun, cfg.session, cfg.window, text);
        },
      },
    });
  } catch (e) {
    console.error(`web: could not start: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
    return 1;
  }
  console.log(`http://${cfg.bind}:${cfg.port}`);
  return -1; // keep running
}

main().then((c) => {
  if (c >= 0) process.exit(c);
});
