// src/setup/steps/gmail.ts
// Step 4: Gmail OAuth. The wizard never reads the OAuth keys or the credentials file; the
// doctor `gmail-oauth` check is the only reader. The auth helper gets exactly two env keys.
import path from 'node:path';
import { envFileValue } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';

const KEYS_DEFAULT = './secrets/gcp-oauth.keys.json';
const CREDS_DEFAULT = './secrets/gmail-credentials.json';

// Same resolution as the doctor `gmail-oauth` check: process env, then .env, then default.
function resolvePath(ctx: SetupContext, envText: string, key: string, fallback: string): string {
  const v = (ctx.env[key] ?? '').trim() || envFileValue(envText, key) || fallback;
  return path.isAbsolute(v) ? v : path.join(ctx.root, v);
}

export const gmailStep: SetupStep = {
  id: 'gmail',
  title: 'Gmail OAuth',
  checkIds: ['gmail-oauth'],
  async run(ctx) {
    const { io } = ctx;
    const envText = ctx.fs.exists(ctx.envPath) ? ctx.fs.read(ctx.envPath) : '';
    const keys = resolvePath(ctx, envText, 'GMAIL_OAUTH_PATH', KEYS_DEFAULT);
    const creds = resolvePath(ctx, envText, 'GMAIL_CREDENTIALS_PATH', CREDS_DEFAULT);

    io.say('Create a Google OAuth client for Gmail:');
    io.say('  1. In Google Cloud Console, create (or pick) a project.');
    io.say('  2. Enable the Gmail API for that project.');
    io.say('  3. Configure the OAuth consent screen and add yourself as a test user.');
    io.say('  4. Create credentials: OAuth client ID, application type Desktop app.');
    io.say(`  5. Download the JSON and save it as ${path.relative(ctx.root, keys) || keys}`);
    await io.pause('Press Enter when the keys file is saved');

    ctx.fs.mkdirp(path.dirname(keys), 0o700);
    if (ctx.fs.exists(keys)) ctx.fs.chmod(keys, 0o600);
    else io.say('The OAuth keys file is not there yet; the check below will say so.');

    if (await io.confirm('Open the Google consent screen now?', true)) {
      io.say('The consent screen asks for the Gmail send scope. The token stays on this machine only.');
      const code = await ctx.spawnInteractive(
        'npx',
        ['-y', '@gongrzhe/server-gmail-autoauth-mcp', 'auth'],
        { env: { GMAIL_OAUTH_PATH: keys, GMAIL_CREDENTIALS_PATH: creds } },
      );
      if (ctx.fs.exists(creds)) ctx.fs.chmod(creds, 0o600);
      if (code !== 0) throw new Error(`Gmail auth helper exited with code ${code}`);
    } else {
      io.say('Skipped the consent screen; run this step again when ready.');
    }
    return 'done';
  },
};
