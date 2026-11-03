// src/setup/steps/telegram.ts
// Step 3: Telegram bot token and allowed user ID(s). The token only travels from askSecret
// to the Telegram URL path (via ctx.fetch) and into .env through the writer.
import path from 'node:path';
import { JOBBER_TMUX_SESSION, listWindows } from '../../platform/tmux.js';
import { envFileValue, updateEnvText, writeEnvFile } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';
import { coachOn, confirmDone, offerSkip, say } from '../coach.js';
import { SKIP_SPECS } from '../skips.js';

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{10,}$/;
const ID_RE = /^\d{5,15}$/;
const TEST_TEXT = 'Jobber setup: test message';
const API = 'https://api.telegram.org/bot';

// A forum supergroup id is a negative number, usually starting with -100.
const GROUP_RE = /^-100\d{5,15}$/;

async function getMeOk(ctx: SetupContext, token: string): Promise<boolean> {
  try {
    const res = await ctx.fetch(`${API}${token}/getMe`);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false; // the error text can carry the URL and so the token
  }
}

// The bridge window consumes the bot updates, so reading them here would steal them.
async function bridgeRunning(ctx: SetupContext): Promise<boolean> {
  try {
    const session = (ctx.env.STACK_TMUX_SESSION ?? '').trim() || JOBBER_TMUX_SESSION;
    return (await listWindows(ctx.run, session)).some((w) => w.name === 'bridge');
  } catch {
    return false;
  }
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
  checkIds: ['telegram-api', 'telegram-bridge'],
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

    // Default: the bot's own topics in the private chat (BotFather Threaded Mode). A forum group is an optional override.
    const existingGroup = envFileValue(envText, 'TELEGRAM_CHAT_ID').trim();
    let group = '';
    if (
      GROUP_RE.test(existingGroup) &&
      (await io.confirm(`Keep the forum group id ${existingGroup}?`, true))
    ) {
      group = existingGroup;
    } else if (
      (io.say(
        'By default the bot uses its own topics in your private chat: open @BotFather > Mini App > select the bot > Bot Settings > Threads Setting > Threaded mode (turn it on), then message the bot once.',
      ),
      await io.confirm('Use a forum group instead of the private chat topics? (optional; press Enter to use the private chat)', false))
    ) {
      const lines = coachOn(ctx)
        ? [
            '1. In Telegram create a group, open its settings and turn Topics on (this makes it a forum supergroup).',
            '2. Add your bot to the group and make it an admin with the "Manage Topics" right (can_manage_topics).',
            '3. Get the group id: forward a message from the group to @userinfobot, or open the group in Telegram Web and read the number after the # (prefix it with -100).',
          ]
        : ['Create a group with Topics on, add the bot as admin with Manage Topics (can_manage_topics), then enter the group id (-100...).'];
      for (const l of lines) io.say(l);
      group = (
        await io.ask('Forum group id (starts with -100)', {
          validate: (v) => (GROUP_RE.test(v.trim()) ? null : 'A forum group id looks like -1001234567890'),
        })
      ).trim();
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
      const bridgeUp = await bridgeRunning(ctx);
      if (
        !bridgeUp &&
        (await io.confirm(
          'Read your ID from your new bot instead? (send /start to it first; do not use this while the bridge runs, it would steal updates)',
          false,
        ))
      ) {
        await io.pause('Send /start to your bot in Telegram, then press Enter');
        id = await idFromUpdates(ctx, token);
        if (!id) io.say('No message found. Enter the ID by hand.');
      }
      if (!id) id = await io.ask('Your numeric Telegram user ID', {
          validate: idValidate,
          default: existingIds.length === 1 && ID_RE.test(existingIds[0]) ? existingIds[0] : undefined,
        });
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
      ...(group ? { TELEGRAM_CHAT_ID: group } : {}),
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
    io.say('Next: npm run up (starts the bridge in window bridge of the Jobber tmux session)');
    say(ctx, 'telegram.next');
    return 'done';
  },
};
