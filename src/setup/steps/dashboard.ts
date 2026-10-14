// src/setup/steps/dashboard.ts
// Step 10: dashboard hand-off. Local web settings first, then (only when plan 7C is installed
// and the user agrees) the OIDC client id/secret, the one allowed account and the redirect URI.
// The client secret travels from askSecret straight into .env; it is never in state, argv, the
// child environment or any say line. The wizard never signs in and never calls the provider.
import path from 'node:path';
import { updateEnvText, writeEnvFile } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEFAULT_REDIRECT = 'http://127.0.0.1:8787/auth/callback';
const CALLBACK_PATH = '/auth/callback';
const PLAN_DOC = 'docs/superpowers/plans/2026-10-14-7c-dashboard-v1.md';

function envFileValue(text: string, key: string): string {
  let out = '';
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.replace(/\r$/, ''));
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out = v;
  }
  return out;
}

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
  // No checkIds on purpose: `web` passes with WEB_TOKEN unset and `dashboard-login` is a skip
  // placeholder until plan 7C, so a check gate would mark this step done on a fresh machine.
  checkIds: [],
  async run(ctx) {
    const { io, root } = ctx;

    // Local settings first. No WEB_TOKEN: sign-in is OIDC only.
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
    if (!(await io.confirm('Set up dashboard sign-in now?', false))) return 'skipped';

    io.say(
      `Create the OAuth client by following the Owner-only checklist in ${PLAN_DOC} (Google Cloud console steps); the wizard does not repeat them.`,
    );

    const envText = readEnvText(ctx);
    const updates: Record<string, string> = {};

    const haveId = envFileValue(envText, 'WEB_OIDC_CLIENT_ID');
    if (haveId && (await io.confirm('Keep the existing OAuth client ID?', true))) {
      /* keep */
    } else {
      updates.WEB_OIDC_CLIENT_ID = (
        await io.ask('OAuth client ID', {
          validate: (v) => (v.trim() !== '' && !/\s/.test(v.trim()) ? null : 'Required, no spaces'),
        })
      ).trim();
    }

    const haveSecret = envFileValue(envText, 'WEB_OIDC_CLIENT_SECRET');
    if (haveSecret) io.registerSecret(haveSecret);
    if (haveSecret && (await io.confirm('Keep the existing OAuth client secret?', true))) {
      io.say('client secret set');
    } else {
      const s = await io.askSecret('Paste the OAuth client secret (input is hidden)', {
        validate: (v) => (v.trim() !== '' ? null : 'Required'),
      });
      updates.WEB_OIDC_CLIENT_SECRET = s.trim();
      io.say('client secret set');
    }

    let email = envFileValue(envText, 'DASHBOARD_ALLOWED_EMAIL').toLowerCase();
    if (!(email && EMAIL_RE.test(email) && (await io.confirm(`Keep the allowed account ${email}?`, true)))) {
      email = (
        await io.ask('The one Google account allowed to sign in (email)', {
          validate: (v) => (EMAIL_RE.test(v.trim()) ? null : 'That does not look like an email address'),
        })
      )
        .trim()
        .toLowerCase();
      updates.DASHBOARD_ALLOWED_EMAIL = email;
    }

    const haveRedirect = envFileValue(envText, 'WEB_OIDC_REDIRECT_URI');
    if (haveRedirect && redirectUriProblem(haveRedirect) === null && (await io.confirm('Keep the existing redirect URI?', true))) {
      /* keep */
    } else {
      updates.WEB_OIDC_REDIRECT_URI = (
        await io.ask('Redirect URI', { default: DEFAULT_REDIRECT, validate: redirectUriProblem })
      ).trim();
    }

    if (Object.keys(updates).length > 0) writeKeys(ctx, updates, false);
    writeKeys(ctx, { WEB_OIDC_ISSUER: 'https://accounts.google.com' }, true);

    // The email is the only argument; the secret is never in argv or in the child's env.
    const code = await ctx.spawnInteractive('npx', ['tsx', 'scripts/dashboard.ts', 'allow', email]);
    if (code !== 0) throw new Error(`dashboard allow exited with code ${code}`);

    io.say(
      'Open the dashboard and sign in once with that account so the account is pinned (npm run dashboard -- status shows pinned or not)',
    );
    return 'done';
  },
};
