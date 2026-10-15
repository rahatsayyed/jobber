// src/setup/steps/dashboard.ts
// Step 10: dashboard hand-off. Local web settings first, then one confirm for a token sign-in
// (the CLI child prints the URL to the terminal; the wizard never holds the token), or an
// existing OIDC install kept as is, or Google sign-in as an option. Never signs in itself.
import path from 'node:path';
import { envFileValue, updateEnvText, writeEnvFile } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CALLBACK_PATH = '/auth/callback';

function readEnvText(ctx: SetupContext): string {
  if (ctx.fs.exists(ctx.envPath)) return ctx.fs.read(ctx.envPath);
  const example = path.join(ctx.root, '.env.example');
  return ctx.fs.exists(example) ? ctx.fs.read(example) : '';
}

function writeKeys(ctx: SetupContext, updates: Record<string, string>, onlyIfMissing: boolean): void {
  const res = updateEnvText(readEnvText(ctx), updates, { onlyIfMissing });
  if (res.changed.length === 0 && ctx.fs.exists(ctx.envPath)) return;
  writeEnvFile(ctx.envPath, res.text, ctx.fs, ctx.now);
}

/** https://..., or http on 127.0.0.1 / localhost with an explicit port; path must be /auth/callback. */
export function redirectUriProblem(raw: string): string | null {
  const bad = `Use https://<host>${CALLBACK_PATH} or http://127.0.0.1:<port>${CALLBACK_PATH}`;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return bad;
  }
  if (u.username || u.password || u.search || u.hash) return bad;
  if (u.pathname !== CALLBACK_PATH) return bad;
  if (u.protocol === 'https:') return u.hostname ? null : bad;
  if (u.protocol === 'http:') {
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    return local && /^\d{1,5}$/.test(u.port) ? null : bad;
  }
  return bad;
}

export const dashboardStep: SetupStep = {
  id: 'dashboard',
  title: 'Dashboard hand-off',
  // No checkIds on purpose: a check gate would mark this step done on a fresh machine.
  checkIds: [],
  async run(ctx) {
    const { io, root } = ctx;

    // Local settings first.
    writeKeys(
      ctx,
      { WEB_PORT: '8787', WEB_TMUX_SESSION: 'ccgram', WEB_TMUX_WINDOW: 'JobApplier' },
      true,
    );
    io.say('Local web settings are in .env (WEB_PORT, WEB_TMUX_SESSION, WEB_TMUX_WINDOW).');

    const windowsPath = path.join(root, 'config', 'manager-windows.json');
    if (ctx.fs.exists(windowsPath)) {
      try {
        const raw: unknown = JSON.parse(ctx.fs.read(windowsPath));
        const list = Array.isArray(raw)
          ? raw
          : typeof raw === 'object' && raw !== null && Array.isArray((raw as { windows?: unknown }).windows)
            ? (raw as { windows: unknown[] }).windows
            : [];
        const names = list
          .map((w) => (typeof w === 'string' ? w : (w as { name?: unknown } | null)?.name))
          .filter((n): n is string => typeof n === 'string');
        if (names.length > 0) io.say(`tmux windows the manager knows: ${names.join(', ')}`);
      } catch {
        /* optional hint only */
      }
    }
    io.say('Start the tmux layout yourself with: bash scripts/ccgram/start.sh');

    if (!ctx.fs.exists(path.join(root, 'scripts', 'dashboard.ts'))) {
      io.say('skipped until installed (plan 7C)');
      return 'skipped';
    }

    const envText = readEnvText(ctx);
    const mode = envFileValue(envText, 'WEB_AUTH_MODE').trim();

    // Existing OIDC owner: keep it, no questions.
    if (
      (mode === '' || mode === 'oidc') &&
      envFileValue(envText, 'WEB_OIDC_CLIENT_ID').trim() !== '' &&
      envFileValue(envText, 'WEB_OIDC_CLIENT_SECRET').trim() !== ''
    ) {
      if (mode !== 'oidc') writeKeys(ctx, { WEB_AUTH_MODE: 'oidc' }, false);
      io.say('Your OIDC sign-in is kept (WEB_AUTH_MODE=oidc).');
      return 'done';
    }

    if (await io.confirm('Create a dashboard access token now?', true)) {
      writeKeys(ctx, { WEB_AUTH_MODE: 'token' }, true);
      // The child prints the URL straight to the terminal; the wizard never sees it.
      const code = await ctx.spawnInteractive('npx', ['tsx', 'scripts/dashboard.ts', 'token']);
      if (code !== 0) {
        io.say('token already set, use rotate: npm run dashboard -- rotate');
        return 'done';
      }
      io.say('Open that URL once; the token is not stored. Lost it? npm run dashboard -- rotate');
      return 'done';
    }

    if (!(await io.confirm('Use Google sign-in instead? (needs the Gmail OAuth client, see docs)', false))) {
      return 'skipped';
    }
    writeKeys(ctx, { WEB_AUTH_MODE: 'google_desktop' }, false);
    let email = envFileValue(envText, 'DASHBOARD_ALLOWED_EMAIL').toLowerCase();
    if (!(email && EMAIL_RE.test(email) && (await io.confirm(`Keep the allowed account ${email}?`, true)))) {
      email = (
        await io.ask('The one Google account allowed to sign in (email)', {
          validate: (v) => (EMAIL_RE.test(v.trim()) ? null : 'That does not look like an email address'),
        })
      )
        .trim()
        .toLowerCase();
      writeKeys(ctx, { DASHBOARD_ALLOWED_EMAIL: email }, false);
    }
    const code = await ctx.spawnInteractive('npx', ['tsx', 'scripts/dashboard.ts', 'allow', email]);
    if (code !== 0) throw new Error(`dashboard allow exited with code ${code}`);
    io.say(
      'The first sign-in pins the account; until then the owner check (L2) is unverified. npm run dashboard -- status shows pinned or not.',
    );
    return 'done';
  },
};
