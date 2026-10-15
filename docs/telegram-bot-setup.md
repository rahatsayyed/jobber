# Telegram bot setup (runbook)

Jobber is operated mostly from Telegram. The bridge is [ccgram](https://pypi.org/project/ccgram/),
pinned to the exact version in `config/ccgram.pin.json`, which relays messages between your bot and
Claude Code sessions running in tmux. This runbook covers creating the bot, wiring `.env`, enabling
topics, starting the bridge and fixing the usual problems.

BotFather's menus and button labels change over time. Follow the label currently on screen where it
differs from the one written here. Anything not confirmed by this repository is marked "unverified".

## What you need

- A Telegram account on the phone or desktop app.
- tmux and the pinned ccgram version installed (`npm run setup` step `prereqs` checks this).
- The repo `.env` (created by the wizard, or copied from `.env.example`, mode 600).

The quickest route is `npm run setup -- --mode terminal --step telegram` (or `npm run setup -- --step
telegram` once terminal mode is stored; `npm run setup -- --status` shows the mode). The terminal
walkthrough takes you through the steps below one at a time: it asks you to confirm "done?" after
BotFather and again after Threaded Mode (answer no to see the instructions once more), takes the
token as hidden input (never echoed, never printed), validates it with Telegram's `getMe`, asks for
your numeric ID, writes `.env`, and sends a test message you confirm arrived. Threaded Mode is an
explicit confirm in the wizard, not an assumption; the optional `getMe` topics check only adds a
re-ask and its absence never fails the step. Telegram is RECOMMENDED but skippable: skip it and
`npm run doctor` shows the Telegram checks as skipped, and `npm run up` starts no bridge or ccgram
windows; add it later with the same `--step telegram` command. The manual steps follow for when you
want to do it by hand or understand what the wizard does.

## 1. Create the bot with BotFather

1. In Telegram open [@BotFather](https://t.me/botfather) (check the verified badge).
2. Send `/newbot`, choose a display name (for example `Jobber`) and a username ending in `bot`.
3. BotFather replies with an HTTP API token shaped like `123456789:AA...`. Treat it like a password.

## 2. Put the token and your user ID in `.env`

1. Get your numeric Telegram user ID: message [@userinfobot](https://t.me/userinfobot) and send any
   text; it replies with your ID. (The wizard also offers to read it from your new bot's updates,
   but only while the bridge is not running, because reading updates would steal them from ccgram.)
2. Edit `.env` (mode 600; do not paste these values into chat):

```
TELEGRAM_BOT_TOKEN=<token from BotFather>
ALLOWED_USERS=<your numeric id>
```

`ALLOWED_USERS` is a comma-separated list of numeric IDs with no spaces, for example
`111111111,222222222`. `run.sh` refuses to start the bridge if the token contains whitespace or
`ALLOWED_USERS` is not digits and commas.

3. `npm run doctor` checks `ccgram-env` (token shape, IDs numeric, `.env` mode 600) and `telegram-api`
   (the token works, shows the bot username).

Open your bot in Telegram and press Start once; a bot cannot message you before you have started it.

## 3. Enable topics (threaded mode)

ccgram maps one Claude session (tmux window) to one Telegram topic, so the bot's chat needs topics.
Jobber's windows are `manager`, `hunt` and `followups` (`config/manager-windows.json`; `manager` and
the bridge are protected and cannot be stopped from Telegram).

Route A, in BotFather's Mini App (the current UI for newer bot settings):

1. Open @BotFather and press its Open button (or open BotFather's profile and open its app).
2. Select your bot, then Bot Settings.
3. Enable "Threaded Mode" (the toggle may be labelled Topics or Threads in your client version).

Route B, the classic chat route (use it if the Mini App route is missing in your client):

1. Send `/mybots` to @BotFather, select your bot, Bot Settings.
2. Enable Topics if the option is listed, and for group use turn Group Privacy off.

The repo's wizard text (`src/setup/steps/telegram.ts`) tells you to enable Topics and turn Group
Privacy off in `/mybots`, your bot, Bot Settings. Whether the exact menu entry is called Topics,
Threaded Mode or Threads in your client, and which of the two routes exposes it, is unverified from
this repo: use the label BotFather currently shows. Group Privacy matters only if you add the bot to
a group; a one-to-one chat with topics does not need it.

Check upstream ccgram documentation for exactly which chat layout it expects (private chat with
topics, or a forum supergroup): unverified here.

## 4. Start the bridge

```bash
bash scripts/ccgram/start.sh
```

What it does, from the script: checks `.env` exists, runs the version check against
`config/ccgram.pin.json` (refuses on mismatch or when ccgram is missing), sets `.env` to mode 600 and
`.ccgram/` to mode 700, and starts `run.sh` in a detached tmux session `ccgram-daemon`. `run.sh`
passes ccgram only `TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS` (a stripped environment), and ccgram
starts Claude windows through `scripts/ccgram/claude-session.sh`, which loads the rest of `.env` for
the MCP servers (not the two Telegram keys) and refuses any permission-skipping flag.

Stop it with `bash scripts/ccgram/stop.sh`. Windows it created keep running.

Look at it with `tmux attach -t ccgram-daemon` (detach with Ctrl-b d). Do not paste the token into it.

## 5. Bind topics to windows

Send your bot a message. How ccgram creates and binds topics (when a topic appears per window, and
how you attach an existing tmux window to a topic) is ccgram's own behavior and is not documented
in this repo: check upstream (`ccgram --help` and its README for the pinned version 4.16.0).

What this repo defines: the named windows `hunt` and `followups` and the protected `manager` window,
and the `manager` skill (`.claude/skills/manager/SKILL.md`), which from the manager topic lists,
reads, starts and stops those windows. Bind the manager topic to the manager session and use it to
start `hunt` and `followups`.

## 6. Register the command menu and branding

- Slash command list for `/setcommands`: see [telegram-slash-commands.md](telegram-slash-commands.md).
  Paste that list; do not copy a second version into other docs.
- Name, About text and Description for the bot profile: see [telegram-branding.md](telegram-branding.md).
  Note that the greeting ccgram sends after `/start` is hard-coded in ccgram and not changed by those
  BotFather fields (documented there).

## 7. Smoke test

1. `npm run doctor`: `telegram-api`, `ccgram-env`, `single-credentials-file` and `ccgram-dir-mode`
   pass.
2. In Telegram, send `/health` (bare) in the manager topic. It runs `npx tsx scripts/status.ts health`
   and returns its output. `/limits` and `/working` are the other two bare status commands.

## Security notes

- `ALLOWED_USERS` is the allowlist. Every ID in it can drive Claude on this machine, within the
  permission set (`read_only` by default). Add a second ID only for someone you would give a shell.
  Messages from other IDs are ignored by ccgram (behavior of ccgram: unverified here).
- The token lives only in `.env` (mode 600, git-ignored). The wizard hides the input and never prints
  it; `run.sh` and `claude-session.sh` keep it out of the Claude process environment. There must be
  no second `.ccgram/.env` (the doctor `single-credentials-file` check fails if there is).
- If the token leaks, rotate it: message @BotFather, `/revoke`, pick the bot, then update
  `TELEGRAM_BOT_TOKEN` in `.env` and restart with `stop.sh` then `start.sh`. The old token stops
  working at once. Also use this if you ever pasted the token anywhere public.
- Telegram messages are not end-to-end encrypted for bots. Keep resumes, emails and tokens out of
  chat; Jobber's reports are counts and titles.
- The older route (`claude --channels plugin:telegram@claude-plugins-official`) is separate and not
  configured by this runbook; see `CLAUDE.md`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot never answers | Bridge not running, or `ALLOWED_USERS` does not contain your ID | `tmux ls` should list `ccgram-daemon`; `bash scripts/ccgram/start.sh`; confirm your ID with @userinfobot and fix `.env`, then restart the bridge |
| `start.sh`: "ccgram version mismatch" or "not installed" | Installed ccgram differs from `config/ccgram.pin.json` | Install exactly the pinned version (see `install_spec` in the pin file); do not use ccgram's own upgrade command (owner decision recorded in `CLAUDE.md`) |
| `start.sh`: "TELEGRAM_BOT_TOKEN and ALLOWED_USERS must both be set" or "malformed" | Empty value, whitespace in the token, or non-numeric IDs | Fix `.env`; IDs are digits separated by commas only |
| Wizard: "Telegram rejected that token" | Typo, revoked token, or no network | Copy the token again from BotFather (or `/token`), check network |
| Test message not received | You never pressed Start on the bot, or the ID is wrong | Open the bot, press Start, retry; verify the numeric ID |
| No topics appear | Topics/Threaded Mode not enabled for the bot, or the client is old | Re-check step 3 with the current BotFather labels; update the Telegram app; check upstream ccgram for the required chat layout (unverified here) |
| Topics exist but a window does not respond | The Claude window is not running | Ask the manager topic for status or start it; `tmux ls` shows `ccgram` windows |
| Bot works in a group but ignores plain messages | Group Privacy is on | BotFather, `/mybots`, bot, Bot Settings, Group Privacy off (re-add the bot to the group if it does not take effect) |
| Token shown in a screenshot or log | Leak | Rotate with `/revoke`, see Security notes |
| Doctor `ccgram-env` fails "`.env` is readable by others" | File mode too open | `chmod 600 .env` |

The guided session can walk you through this: `npm run setup`.
