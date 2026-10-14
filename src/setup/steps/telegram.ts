// src/setup/steps/telegram.ts
// Step 3: Telegram bot token and allowed user ID(s). The token only travels from askSecret
// to the Telegram URL path (via ctx.fetch) and into .env through the writer.
import path from 'node:path';
import { hasSession } from '../../platform/tmux.js';
import { updateEnvText, writeEnvFile } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{10,}$/;
const ID_RE = /^\d{5,15}$/;
const TEST_TEXT = 'Jobber setup: test message';
const API = 'https://api.telegram.org/bot';

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
    io.say('In Telegram: open @BotFather, send /newbot, choose a name and username, copy the token.');
    io.say('Then in /mybots > your bot > Bot Settings: enable Topics and turn Group Privacy off.');

    const envText = readEnvText(ctx);
    const existingToken = envFileValue(envText, 'TELEGRAM_BOT_TOKEN');
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
      const entered = await io.askSecret('Paste the bot token (input is hidden)', {
        validate: (v) => (TOKEN_RE.test(v.trim()) ? null : 'That does not look like a bot token'),
      });
      const candidate = entered.trim();
      if (!(await getMeOk(ctx, candidate))) throw new Error('Telegram rejected that token');
      token = candidate;
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
      io.say('Message @userinfobot and send it any text; it replies with your numeric ID.');
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
    if (!sent || !(await io.confirm('Did the message arrive in Telegram?', true))) {
      io.say('Open your bot in Telegram and press Start first, then retry.');
      throw new Error('Test message was not received');
    }
    io.say('Next: bash scripts/ccgram/start.sh');
    return 'done';
  },
};
