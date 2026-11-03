# Telegram bot setup (runbook)

Jobber is operated mostly from Telegram. The bridge is our own grammY bot in `src/telegram/`
(`npm run telegram:bridge`), running in the tmux window `bridge` of the one session `Jobber`. It uses
topics in the bot's own private chat with you: one topic per kind of message (`alerts`, `wakes`, `drips`, `inbox`, `assist`,
`chat`). The ids of the topics are kept in `.jobber/telegram-topics.json`. This runbook covers creating
the bot, wiring `.env`, enabling Threaded Mode (topics in the private chat), starting the bridge and fixing the usual
problems. (ccgram, the old bridge, was removed on 2026-11-03; see the migration note in
`docs/reference/platform-and-sessions.md`.)

BotFather's menus and button labels change over time. Follow the label currently on screen where it
differs from the one written here. Anything not confirmed by this repository is marked "unverified".

## What you need

- A Telegram account on the phone or desktop app.
- tmux installed (`npm run setup` step `prereqs` checks this).
- The repo `.env` (created by the wizard, or copied from `.env.example`, mode 600).
- Threaded Mode switched on for the bot in BotFather (step 3). A group is optional.

The quickest route is `npm run setup -- --mode terminal --step telegram` (or `npm run setup -- --step
telegram` once terminal mode is stored; `npm run setup -- --status` shows the mode). The terminal
walkthrough takes you through the steps below one at a time, takes the token as hidden input (never
echoed, never printed), validates it with Telegram's `getMe`, asks for your numeric ID, writes `.env`,
and sends a test message you confirm arrived. Telegram is RECOMMENDED but skippable: skip it and
`npm run doctor` shows the Telegram checks as skipped, and `npm run up` starts no bridge; add it later
with the same `--step telegram` command. The manual steps follow for when you want to do it by hand or
understand what the wizard does.

## 1. Create the bot with BotFather

1. In Telegram open [@BotFather](https://t.me/botfather) (check the verified badge).
2. Send `/newbot`, choose a display name (for example `Jobber`) and a username ending in `bot`.
3. BotFather replies with an HTTP API token shaped like `123456789:AA...`. Treat it like a password.

## 2. Put the token and your user ID in `.env`

1. Get your numeric Telegram user ID: message [@userinfobot](https://t.me/userinfobot) and send any
   text; it replies with your ID. (The wizard also offers to read it from your new bot's updates,
   but only while the bridge is not running, because reading updates would steal them from the bridge.)
2. Edit `.env` (mode 600; do not paste these values into chat):

```
TELEGRAM_BOT_TOKEN=<token from BotFather>
ALLOWED_USERS=<your numeric id>
# optional, only for a forum group instead of the private chat (see step 3):
# TELEGRAM_CHAT_ID=<forum group id>
```

`ALLOWED_USERS` is a comma-separated list of numeric IDs with no spaces, for example
`111111111,222222222`. The bridge is owner-only: it answers only these numeric IDs and ignores
everyone else. `TELEGRAM_CHAT_ID` is optional (see step 3).

3. `npm run doctor` checks `telegram-api` (the token works, shows the bot username) and
   `telegram-bridge` (the bridge is configured and its window is running).

Open your bot in Telegram and press Start once; a bot cannot message you before you have started it.

## 3. Turn on topics for the bot (Threaded Mode)

Default path: the topics live in the bot's own private chat with you. No group is needed.

1. Switch Threaded Mode on (steps confirmed by the owner on 2026-11-03, they worked for this bot):
   1. Open @BotFather and tap the **Mini App** (open BotFather's mini app).
   2. Select your bot.
   3. Open **Bot Settings**.
   4. Open **Threads Setting**.
   5. Turn **Threaded mode** on.
2. Open your bot in Telegram and send it one message (or press Start). The bridge creates its topics
   itself (`alerts`, `wakes`, `drips`, `inbox`, `assist`, `chat`) in the private chat with the first id of
   `ALLOWED_USERS` and stores their ids in `.jobber/telegram-topics.json`.
3. Leave `TELEGRAM_CHAT_ID` empty. If Threaded Mode is off, the bridge sends everything to the private
   chat without topics.

Optional: a forum group instead. Create a group, turn on Topics (it becomes a forum), add the bot as an
administrator with the right "Manage topics" (`can_manage_topics`), and set `TELEGRAM_CHAT_ID` in `.env`
to the numeric id of the group (a negative number that starts with `-100`; for example forward a message
from the group to @userinfobot).

If the bridge cannot create a topic it says so in the `bridge` window and falls back to sending without a topic
(the General topic in a group). Group Privacy only matters for plain group messages that are not commands; the
bridge needs to read the free `chat` topic, so turn Group Privacy off in `/mybots`, your bot, Bot
Settings (re-add the bot to the group if it does not take effect).

## 4. Start the bridge

```bash
npm run telegram:bridge
```

Or just run `npm start` (`npm run up`), which starts the `bridge`, `scheduler` and `web` windows in the
one tmux session `Jobber` (env `STACK_TMUX_SESSION`, default `Jobber`). The bridge reads
`TELEGRAM_BOT_TOKEN`, `ALLOWED_USERS` and `TELEGRAM_CHAT_ID` from `.env`. The named Claude windows
(`hunt`, `followups`, `manager`) are started by `scripts/claude-session.sh`, which loads the rest of
`.env` for the MCP servers (not the Telegram keys) and refuses any permission-skipping flag.

Look at it with `tmux attach -t Jobber` and pick the `bridge` window (detach with Ctrl-b d). Do not
paste the token into it.

## 5. What you can do from Telegram

- Typed commands, handled in code (no model): `/limits`, `/working`, `/health`, `/sources`,
  `/escalations`, `/apply <url>`, `/runhunt`, `/instruction`, `/report`, `/status`, `/outcome`,
  `/include`, `/calibrate`, `/patterns`.
- Not wired in the bridge yet: `/followups`, `/checkreplies`, `/applyall`, `/connect`. Use the `hunt`
  and `followups` windows of the `Jobber` session for those (`tmux attach -t Jobber`).
- Also typed in code: `/windows`, `/window <name>` and `/drip` (sections 5a to 5c).
- Free text in the `chat` topic goes to the long-running `chat` window (section 5d). It runs under the
  `read_only` permission set and never with skip-permissions.
- Code-sent notifications go to a topic by kind (`src/platform/notify.ts`): the escalation digest and
  the manual-request reports go to `inbox`, the `apply:assist` ping goes to `assist`, wake and drip
  summaries go to `wakes` and `drips`, and problems go to `alerts`.

### 5a. Notices and topics

- `wakes`: after each wake the scheduler sends a short summary, written by code (never by the model).
- `alerts`: failures.
- `drips`: one line per mail or LinkedIn drip action; email addresses are masked.
- Window topics are created on demand the first time you open a window view and are stored under `windows` in
  `.jobber/telegram-topics.json`. `wake-*` windows use the `wakes` topic, `drip-*` windows use the `drips` topic,
  and the `chat` window uses the `chat` topic.

### 5b. `/windows` and the input flag

- `/windows` lists the tmux windows you may view; `/window <name>` opens a live view of one. Buttons: Refresh,
  Pause, Close. The view is an edited message that follows the pane.
- Allowlist: the session `Jobber` plus the sessions in `WEB_TERMINAL_SESSIONS`. Anything else is refused.
- View only by default. Input buttons and typed text work only when `TELEGRAM_WINDOW_INPUT=true` in `.env`
  (default false; restart the bridge after a change). Protected windows are always view only.
- Unverified live: how hard Telegram rate-limits `editMessageText` for a busy window. If views lag, use Pause.

### 5c. `/drip`

- `/drip` shows the mail and LinkedIn drip lanes with buttons Mail now, LinkedIn now and Status.
- Mail now and LinkedIn now ask for a confirm step first. The confirm uses a single-use token that expires
  after 2 minutes. A confirmed request is stored in `scheduler_state` (`drip_request_mail`,
  `drip_request_linkedin`) and only skips the random wait between ticks. The send window, quiet hours, caps,
  halts, the kill switch and the dry run all still apply. When a lane refuses, the reason is kept in
  `drip_last_refusal_<lane>` and shown by Status.
- The scheduler daemon picks the request up, so the daemon must be running.

### 5d. The chat window and `/clear`

- `npm run up` starts a long-running interactive `claude` window named `chat` in the `Jobber` session
  (`ensureChatWindow`) with a `--session-id` recorded in `.jobber/chat-session.json`.
- The `chat` topic types your text into that window. The reply is read from Claude's transcript jsonl under
  `~/.claude/projects`. Typed text is one line: at most 2000 characters, newlines become spaces, and a leading
  `!`, `#` or `&` is prefixed with "Owner says: " so it cannot act as a shell, memory or background command.
- Chat-topic only commands: `/clear` (types Claude's `/clear` and best-effort deletes the Telegram messages the
  bridge logged; Telegram only allows deleting messages younger than 48 hours), `/compact` and `/chat restart`.
- `TELEGRAM_CHAT_FALLBACK=print` switches back to the old `claude -p` path. Default off.
- Unverified live: that `/clear` creates a new transcript file the bridge then follows, and that the installed
  `claude` accepts `--session-id` as expected. If replies stop after `/clear`, use `/chat restart`.

## 6. Register the command menu and branding

- Slash command list for `/setcommands`: see [telegram-slash-commands.md](telegram-slash-commands.md).
  Paste that list; do not copy a second version into other docs.
- Name, About text and Description for the bot profile: see [telegram-branding.md](telegram-branding.md).

## 7. Smoke test

1. `npm run doctor`: `telegram-api`, `telegram-bridge` and `single-credentials-file` pass.
2. In Telegram, send `/health` (bare) in any topic. It runs `npx tsx scripts/status.ts health` and
   returns its output. `/limits` and `/working` are the other bare status commands.

## Security notes

- `ALLOWED_USERS` is the allowlist. Every ID in it can drive Claude on this machine, within the
  permission set (`read_only` by default). Add a second ID only for someone you would give a shell.
  Messages from other IDs are ignored.
- The token lives only in `.env` (mode 600, git-ignored). The wizard hides the input and never prints
  it; `scripts/claude-session.sh` keeps it out of the Claude process environment. There must be no
  second credentials file (the doctor `single-credentials-file` check fails if there is).
- If the token leaks, rotate it: message @BotFather, `/revoke`, pick the bot, then update
  `TELEGRAM_BOT_TOKEN` in `.env` and restart the `bridge` window. The old token stops working at once.
  Also use this if you ever pasted the token anywhere public.
- Telegram messages are not end-to-end encrypted for bots. Keep resumes, emails and tokens out of
  chat; Jobber's reports are counts and titles.
- The older route (`claude --channels plugin:telegram@claude-plugins-official`) is separate and not
  configured by this runbook; see `CLAUDE.md`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot never answers | Bridge not running, or `ALLOWED_USERS` does not contain your ID | `tmux attach -t Jobber` and check the `bridge` window; `npm run telegram:bridge`; confirm your ID with @userinfobot and fix `.env`, then restart the bridge |
| Bridge says token missing or malformed | Empty value, whitespace in the token, or non-numeric IDs | Fix `.env`; IDs are digits separated by commas only |
| Wizard: "Telegram rejected that token" | Typo, revoked token, or no network | Copy the token again from BotFather (or `/token`), check network |
| Test message not received | You never pressed Start on the bot, or the ID is wrong | Open the bot, press Start, retry; verify the numeric ID |
| No topics appear | Threaded Mode is off for the bot in BotFather (private chat), or, with a group, Topics are off, the bot is not admin or lacks `can_manage_topics`, or `TELEGRAM_CHAT_ID` is wrong | Redo step 3; check the `bridge` window for the error |
| Bot works in a group but ignores plain messages | Group Privacy is on | BotFather, `/mybots`, bot, Bot Settings, Group Privacy off (re-add the bot to the group if it does not take effect) |
| Chat topic says login expired | The `chat` window's Claude login ran out | In a terminal run `claude`, then `/login`; then `/chat restart` in the chat topic |
| Topics are empty or missing | Threaded Mode off, or `.jobber/telegram-topics.json` holds stale ids | Redo step 3 and send the bot one message; if ids are stale, stop the bridge, delete that file and start it again |
| Changed `.env` but nothing changed (`TELEGRAM_WINDOW_INPUT`, `TELEGRAM_CHAT_FALLBACK`) | The bridge reads `.env` only at start | Restart the `bridge` window |
| `/followups` or `/connect` does nothing | Not wired in the bridge yet | Use the `followups` or `hunt` window of the `Jobber` session |
| Token shown in a screenshot or log | Leak | Rotate with `/revoke`, see Security notes |
| Doctor says `.env` is readable by others | File mode too open | `chmod 600 .env` |

The guided session can walk you through this: `npm run setup`.
