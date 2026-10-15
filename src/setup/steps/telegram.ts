// src/setup/steps/telegram.ts
// Step 3: Telegram bot token and allowed user ID(s). The token only travels from askSecret
// to the Telegram URL path (via ctx.fetch) and into .env through the writer.
import path from 'node:path';
import { hasSession } from '../../platform/tmux.js';
import { envFileValue, updateEnvText, writeEnvFile } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';
import { coachOn, confirmDone, offerSkip, say } from '../coach.js';
import { SKIP_SPECS } from '../skips.js';

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{10,}$/;
const ID_RE = /^\d{5,15}$/;
const TEST_TEXT = 'Jobber setup: test message';
const API = 'https://api.telegram.org/bot';

// UNVERIFIED (plan 8F U2): the name of the getMe field that says topics (Threaded Mode) are on.
// It could not be checked offline. Absence is trusted to the owner's "done"; it never fails.
const TOPICS_FIELD = 'has_topics_enabled';

async function getMe(
  ctx: SetupContext,
  token: string,
): Promise<{ ok: boolean; topics: boolean | undefined }> {
  try {
    const res = await ctx.fetch(`${API}${token}/getMe`);
    if (!res.ok) return { ok: false, topics: undefined };
    const body = (await res.json()) as { ok?: unknown; result?: Record<string, unknown> };
    const flag = body.result?.[TOPICS_FIELD];
    return { ok: body.ok === true, topics: typeof flag === 'boolean' ? flag : undefined };
  } catch {
    return { ok: false, topics: undefined }; // the error text can carry the URL and so the token
  }
}

async function getMeOk(ctx: SetupContext, token: string): Promise<boolean> {
  return (await getMe(ctx, token)).ok;
}

async function idFromUpdates(ctx: SetupContext, token: string): Promise<string> {
  try {
    const res = await ctx.fetch(`${API}${token}/getUpdates`);
    if (!res.ok) return '';
    const body = (await res.json()) as {
      result?: { message?: { from?: { id?: unknown } } }[];
    };
    const list = Array.isArray(body.result) ? body.result : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i]?.message?.from?.id;
      if (typeof id === 'number' && ID_RE.test(String(id))) return String(id);
    }
  } catch {
    /* fall through */
  }
  return '';
}

function readEnvText(ctx: SetupContext): string {
  if (ctx.fs.exists(ctx.envPath)) return ctx.fs.read(ctx.envPath);
  const example = path.join(ctx.root, '.env.example');
  return ctx.fs.exists(example) ? ctx.fs.read(example) : '';
}

const idValidate = (v: string): string | null =>
  ID_RE.test(v.trim()) ? null : 'A user ID is 5 to 15 digits';

export const telegramStep: SetupStep = {
  id: 'telegram',
  title: 'Telegram bot',
  checkIds: ['telegram-api', 'ccgram-env'],
  async run(ctx) {
    const { io } = ctx;
    const envText = readEnvText(ctx);
    const existingToken = envFileValue(envText, 'TELEGRAM_BOT_TOKEN');

    if (!existingToken.trim()) {
      const spec = SKIP_SPECS.find((x) => x.id === 'telegram');
      if (spec && (await offerSkip(ctx, spec)) === 'later') return 'skipped';
    }

    say(ctx, 'telegram.intro');
    let token = '';
    if (TOKEN_RE.test(existingToken)) {
      io.registerSecret(existingToken);
      if (
        (await getMeOk(ctx, existingToken)) &&
        (await io.confirm('A working bot token is already in .env. Keep it?', true))
      ) {
        token = existingToken;
      }
    }
    if (!token) {
      const made = await confirmDone(ctx, {
        id: 'telegram.botfather',
        action: 'Create the bot in BotFather',
        explain: coachOn(ctx)
          ? [
              '1. Open @BotFather in Telegram and check the verified badge.',
              '2. Send /newbot.',
              '3. Choose a display name and a username that ends in bot.',
              '4. BotFather replies with a token like 123456789:AA... (long, with a colon).',
            ]
          : ['In Telegram: open @BotFather, send /newbot, choose a name and username.'],
        again: [
          'Open @BotFather (verified badge), send /newbot, then answer its two questions.',
          'You are done when its reply contains a long token with a colon in it.',
        ],
        allowSkip: true,
      });
      if (made === 'skip') return 'skipped';
      for (let attempt = 0; attempt < 2 && !token; attempt++) {
        const entered = await io.askSecret('Paste the bot token (input is hidden)', {
          validate: (v) => (TOKEN_RE.test(v.trim()) ? null : 'That does not look like a bot token'),
        });
        const candidate = entered.trim();
        if (await getMeOk(ctx, candidate)) token = candidate;
        else if (attempt === 0) io.say('Telegram rejected that token. Try once more.');
      }
      if (!token) throw new Error('Telegram rejected that token');
    }

    const topicsRounds = 3;
    for (let r = 0; r < topicsRounds; r++) {
      const res = await confirmDone(ctx, {
        id: 'telegram.topics',
        action: 'Enable Threaded Mode for the bot',
        explain: coachOn(ctx)
          ? [
              'The bridge needs topics (Threaded Mode) so each window gets its own thread.',
              'Route A: in @BotFather press its Open button (Mini App), pick your bot, Bot Settings, switch Threaded Mode on.',
              'Route B (older clients): send /mybots, pick your bot, Bot Settings, enable Topics.',
              'Also turn Group Privacy off if you use a group.',
            ]
          : ['In @BotFather: your bot, Bot Settings, enable Threaded Mode (Topics).'],
        again: [
          'Route A: @BotFather, Open button (Mini App), your bot, Bot Settings, Threaded Mode.',
          'Route B: /mybots, your bot, Bot Settings, Topics. The label may differ in your app version (Topics, Threads or Threaded Mode).',
        ],
        allowSkip: true,
      });
      if (res === 'skip') {
        ctx.state.answers.telegram_topics = 'unconfirmed';
        io.say('Continuing without topics. The bridge needs them for windows; enable them later.');
        break;
      }
      const me = await getMe(ctx, token);
      if (me.topics === false) {
        if (r < topicsRounds - 1) {
          io.say('Telegram reports topics are still off for this bot. Check again.');
          continue;
        }
        ctx.state.answers.telegram_topics = 'unconfirmed';
        io.say('Telegram still reports topics off. Continuing; enable them before starting the bridge.');
      }
      break;
    }

    const existingIds = envFileValue(envText, 'ALLOWED_USERS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let ids: string[] = [];
    if (
      existingIds.length > 0 &&
      existingIds.every((i) => ID_RE.test(i)) &&
      (await io.confirm(`Keep the allowed user ID(s) ${existingIds.join(', ')}?`, true))
    ) {
      ids = existingIds;
    } else {
      say(ctx, 'telegram.id');
      let id = '';
      const daemonUp = await hasSession(ctx.run, 'ccgram-daemon');
      if (
        !daemonUp &&
        (await io.confirm(
          'Read your ID from your new bot instead? (send /start to it first; do not use this while ccgram runs, it would steal updates)',
          false,
        ))
      ) {
        await io.pause('Send /start to your bot in Telegram, then press Enter');
        id = await idFromUpdates(ctx, token);
        if (!id) io.say('No message found. Enter the ID by hand.');
      }
      if (!id) id = await io.ask('Your numeric Telegram user ID', { validate: idValidate });
      ids = [id.trim()];
      while (await io.confirm('Allow another person?', false)) {
        io.say('Warning: every allowed ID can drive Claude on this machine.');
        if (!(await io.confirm('Really add another user ID?', false))) break;
        const more = await io.ask('Their numeric Telegram user ID', { validate: idValidate });
        if (!ids.includes(more.trim())) ids.push(more.trim());
      }
    }

    const upd = updateEnvText(envText, {
      TELEGRAM_BOT_TOKEN: token,
      ALLOWED_USERS: ids.join(','),
    });
    if (upd.changed.length > 0 || !ctx.fs.exists(ctx.envPath)) {
      writeEnvFile(ctx.envPath, upd.text, ctx.fs, ctx.now);
      io.say(`.env updated (${upd.changed.join(', ')})`);
    }

    let arrived = false;
    for (let attempt = 0; attempt < 3 && !arrived; attempt++) {
      let sent = false;
      try {
        const res = await ctx.fetch(`${API}${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: ids[0], text: TEST_TEXT }),
        });
        sent = res.ok;
      } catch {
        sent = false;
      }
      if (sent && (await io.confirm('Did the message arrive in Telegram?', true))) arrived = true;
      else {
        io.say(
          'Open your bot and press Start (a bot cannot message you before you start it), then check the ID.',
        );
      }
    }
    if (!arrived) {
      if (!(await io.confirm('Keep these settings and finish with a warning?', false))) {
        throw new Error('Test message was not received');
      }
      io.say('warning: the test message was not confirmed; check the bot and the ID before starting the bridge.');
    }
    io.say('Next: bash scripts/ccgram/start.sh');
    say(ctx, 'telegram.next');
    return 'done';
  },
};
