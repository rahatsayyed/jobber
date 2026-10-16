// src/setup/steps/gmail.ts
// Step 4: Gmail OAuth. The wizard never reads the OAuth keys or the credentials file; the
// doctor `gmail-oauth` check is the only reader. The auth helper gets exactly two env keys.
import path from 'node:path';
import { setupChecks } from '../../platform/checksSetup.js';
import { runChecks } from '../../platform/doctor.js';
import { coachOn, confirmDone, offerSkip, say } from '../coach.js';
import { envFileValue } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';
import { SKIP_SPECS } from '../skips.js';

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

    const spec = SKIP_SPECS.find((x) => x.id === 'gmail');
    if (spec && (await offerSkip(ctx, spec)) === 'later') return 'skipped';

    say(ctx, 'gmail.where');
    const keysRel = path.relative(ctx.root, keys) || keys;
    const groups = [
      {
        id: 'gmail.project',
        action: 'Create a Google Cloud project and enable the Gmail API',
        explain: coachOn(ctx)
          ? [
              '1. In Google Cloud Console, create (or pick) a project.',
              '2. Open APIs and Services, Library, search Gmail API and press Enable.',
            ]
          : ['In Google Cloud Console: create or pick a project and enable the Gmail API.'],
        again: [
          'Console path: select a project at the top, then APIs and Services, Library, Gmail API, Enable.',
          'You are done when the Gmail API page shows Manage instead of Enable.',
        ],
      },
      {
        id: 'gmail.consent',
        action: 'Configure the consent screen with yourself as a test user',
        explain: coachOn(ctx)
          ? [
              '3. Open APIs and Services, OAuth consent screen (Google Auth Platform in newer consoles).',
              '4. Choose External, fill the app name and your email, and add your own address under Test users.',
            ]
          : ['Configure the OAuth consent screen and add yourself as a test user.'],
        again: [
          'Console path: APIs and Services, OAuth consent screen (or Google Auth Platform, Audience), Test users, Add users.',
          'Your own Gmail address must be in the Test users list, or sign-in is refused later.',
        ],
      },
      {
        id: 'gmail.client',
        action: `Create a Desktop app OAuth client and save its JSON as ${keysRel}`,
        explain: coachOn(ctx)
          ? [
              '5. APIs and Services, Credentials, Create credentials, OAuth client ID, application type Desktop app.',
              `6. Download the JSON and save it as ${keysRel}`,
            ]
          : [`Create an OAuth client ID of type Desktop app, download the JSON and save it as ${keysRel}`],
        again: [
          'Console path: APIs and Services, Credentials, Create credentials, OAuth client ID, Desktop app, then Download JSON.',
          `The file must be named exactly ${keysRel}`,
        ],
      },
    ];
    for (const g of groups) {
      if ((await confirmDone(ctx, { ...g, allowSkip: true })) === 'skip') {
        io.say('Gmail setup not confirmed; run this step again with npm run setup -- --step gmail');
        return 'skipped';
      }
    }

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
      // Only the doctor check reads the key and credentials files, never this step.
      const check = setupChecks.find((c) => c.id === 'gmail-oauth');
      if (!check) {
        io.say('Gmail could not be verified (the gmail-oauth check is missing); run npm run doctor.');
        return 'pending';
      }
      const [r] = await runChecks([check], ctx.doctor);
      if (r.result.status === 'pass') {
        io.say('Gmail is authorised on this machine.');
      } else {
        io.say('Gmail is not authorised yet; run this step again.');
        if (r.result.fix) io.say(`  fix: ${r.result.fix}`);
        return 'pending';
      }
    } else {
      io.say('Skipped the consent screen; run this step again with npm run setup -- --step gmail');
      return 'pending';
    }
    return 'done';
  },
};
