# ccgram security review (2026-10-14)

Method: web-only read of source via raw.githubusercontent.com and github.com tree pages at tag v4.16.0. Nothing was installed, cloned or executed. Page text was treated as untrusted data. Excerpts were produced by a summarizing fetch tool, so quoted code is as reported by the fetch tool, not byte-verified, and line numbers are approximate.

## Pin

- Latest PyPI release: 4.16.0 (requires_python >=3.14). GitHub tag v4.16.0 (2026-10-08). Earlier: v4.15.1, v4.15.0 (2026-10-08), v4.14.1 (2026-10-03).
- Version to pin if the verdict later becomes PASS: 4.16.0.

## Findings per file

| File | ALLOWED_USERS check before action | Notes |
|---|---|---|
| config.py | Startup: `allowed_users_str = os.getenv("ALLOWED_USERS", "")`; `if not allowed_users_str: raise ValueError(...)` (fails closed when empty). `is_user_allowed` returns `user_id in self.allowed_users`. | A value like `" , "` passes the empty check and yields an empty set (nobody allowed). |
| handlers/text/text_handler.py `text_handler` | Yes: `config.is_user_allowed(user.id)`, else "You are not authorized" and return. | No private-chat restriction; groups processed. |
| handlers/shell/shell_commands.py | NO check inside the module. Relies on entry points (text_handler) and callback dispatch. `_cb_run`/`_cb_edit`/`_cb_cancel` check only that the pending command's user_id equals the caller. | |
| handlers/voice/voice_handler.py `handle_voice_message` | Yes, at entry, before download. | Whisper off unless `CCGRAM_WHISPER_PROVIDER` set. `voice_autosend` (default off) sends transcript with no confirmation. voice_callbacks.py NOT read. |
| handlers/upgrade.py `upgrade_command` | Yes: `if not config.is_user_allowed(user.id):`. | See upgrade section below. |
| hook.py | N/A (runs as a Claude hook subprocess, not a Telegram handler). | |
| handlers/commands/forward.py `forward_command_handler` | Yes: `if not user or not config.is_user_allowed(user.id):`. | Any slash token plus args is forwarded as-is to the pane; no command filter. |
| handlers/file_handler.py photo and document handlers | Yes, at entry of each. | Saves into `.ccgram-uploads/` in the session cwd and auto-sends "I've uploaded {name} to {path}" plus sanitized caption to the pane. |
| handlers/inline.py `inline_query_handler` | Yes (returns silently). | |
| handlers/agent_command.py `_resolve_window` | Yes. | Does not start/redirect processes. |
| handlers/send/send_command.py | Yes ("Not authorized."). | send_security.py NOT read. |
| handlers/callback_registry.py `dispatch` | Yes: `if not user or not config.is_user_allowed(user.id):` -> "Not authorized". Runs before any callback handler. | |
| handlers/registry.py (registration) | There is NO global gate. `group_filter` is only a chat filter (`filters.Chat(group_id)` or `filters.ALL`). The only `filters.User(allowed_users)` is on the private start greeting. `CallbackQueryHandler` and `InlineQueryHandler` have no filter. | Authorization is per handler, so every handler must be audited and re-audited on each upgrade. |

## How text reaches a pane

`text_handler` -> `_forward_message` -> `send_telegram_to_window` -> tmux manager `send_keys`. In multiplexer/tmux.py all input goes via libtmux `pane.send_keys(chars, enter, literal)` (no paste-buffer or load-buffer; literal mode for message text, then Enter after 0.5 s; a leading `!` is sent separately). No sanitization of user text. With the Shell provider, text goes to `handle_shell_message`: `!cmd` runs raw; other text goes through an optional LLM completer and needs a Run callback; with no completer configured the text is executed raw. Whether Shell is on by default was NOT determined (providers/shell.py and provider selection not read).

## /upgrade

Registered in registry.py as a normal CommandHandler gated only by `group_filter`. `upgrade_command` runs `uv tool upgrade ccgram` immediately (asyncio.create_subprocess_exec, 90 s timeout), then if something changed sets `_restart_requested`, arms a shutdown watchdog and stops the application. There is no confirmation step in the files read (docs/guides.md claims destructive actions including upgrade ask for confirmation; the code read does not), and no config flag or env var that disables it in the files read (main.py, cli.py, bootstrap.py, group_filter and send_telegram_to_window were not read). The command fetches the newest release from the package index, so it may bypass a loose pin. `uv tool upgrade` is documented to honor the version constraint recorded at install time, so an exact `==` pin may neutralize that part (unverified here). The remaining concerns are unconfirmed subprocess and restart behavior and the lack of a disable flag in the files read. Keeping it off would likely require patching the source or a wrapper.

## YOLO

- `CCGRAM_YOLO_CONFIRMATION_TIMEOUT` (config.py line ~149, default 30.0 s, min 1.0) is only a timeout.
- toolbar_config.py defines a builtin `yolo` button sending tmux key `C-y` (state read after press). It is in the default Gemini layout row 2 only; the default Claude layout (`screen, ctrlc, live / mode, think, esc / up, enter, down / last, getfile, close`) has no yolo button. `mode` sends Shift-Tab, which cycles Claude permission modes, so an allowlisted user can change agent mode from the toolbar. `CCGRAM_TOOLBAR_CONFIG` can add arbitrary `key`/`text` actions.
- providers/claude.py: launch command hardcoded `claude`; no `--dangerously-skip-permissions`; has `has_yolo_confirmation=True` and status-text detection of "bypass permissions". No env var overriding Claude's launch command found there, but docs list `CCGRAM_<NAME>_COMMAND` ("env only") as a per-provider launch override; the reader code was NOT found. Never set it.
- No setting found in the files read turns YOLO on globally (the YOLO search was not exhaustive, see below). It appears to be a per-session keypress by an allowlisted user.

## Network calls other than Telegram

- hook.py: none (local unix socket to herdr; local subprocesses: tmux, ps, herdr, agtermctl).
- providers/claude.py, upgrade handler: none directly (upgrade shells out to uv, which uses the network).
- Optional, reported off by default (from docs and config; the packages themselves were not read): Whisper (OpenAI/Groq, `CCGRAM_WHISPER_*`), LLM completer (`CCGRAM_LLM_*`), TTS, Mini App aiohttp server (default 127.0.0.1:8765; `CCGRAM_MINIAPP_BASE_URL` makes it externally reachable). The llm/, whisper/, tts/, miniapp/ packages were NOT read.

## .env handling

- Only `./.env` (cwd at import) and `$CCGRAM_DIR/.env` (default `~/.ccgram/.env`) are loaded: `for env_path in (Path(".env"), ccgram_dir() / ".env"): load_dotenv(env_path)` (config.py and utils.load_ccgram_env). No other .env path seen in the files read.
- `load_dotenv` default `override=False`: variables already in the process environment take precedence over both files; cwd `.env` wins over `$CCGRAM_DIR/.env`.
- Risk: ccgram reads `./.env` of its working directory. Started from the Jobber repo root it would load Jobber's `.env` (secrets) into its own environment. Run it from a different cwd.
- No chmod/mode calls anywhere read; state dir and `.env` need manual `chmod 700/600`.

## Other

- Python floor: >=3.14.
- hook.py writes `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`), and `~/.codex` and `~/.gemini` configs for those providers; installs hook command `{sys.executable} -m ccgram.main hook` for 9 events; reads stdin JSON; spawns only local tools.

## Not read / not verified

voice_callbacks.py, shell_prompt_orchestrator.py, shell_capture.py, shell_context.py, send_security.py, send_callbacks.py, interactive_callbacks.py, interactive_ui.py, toolbar_callbacks.py, toolbar_keyboard.py, commands/panel.py, topics/, recovery/, live/, polling/, status/, messaging_pipeline/, sessions_dashboard.py, split_command.py, sync_command.py, dashboard_command.py, cleanup.py, providers/shell.py and other providers, llm/, whisper/, tts/, miniapp/, cli.py, main.py, bootstrap.py, session*.py, the definition of `group_filter`, the `send_telegram_to_window` implementation, the `CCGRAM_<NAME>_COMMAND` reader, and transitive dependencies. GitHub code search was unavailable, so "every place YOLO is referenced" is NOT exhaustively established (found in config.py, toolbar_config.py, providers/claude.py, docs only).

## Verdict: STOP

Failed condition: `/upgrade` could not be shown to be keepable off. In the files read it is registered unconditionally, has no disabling flag, runs `uv tool upgrade ccgram` immediately for any allowlisted user (which may bypass a loose pin; an exact pin may neutralize that, unverified), and does not confirm. Secondary gaps: no global allowlist gate (per-handler checks only, several handlers not read), and mode/YOLO keys reachable from the toolbar. The allowlist check is present in every handler that was read, and YOLO is not on by default for Claude. Owner decision needed: patch or fork and pin a commit with upgrade removed, switch to ccbot or the official plugin, or accept the risk explicitly. The pin file was not created.

A PASS verdict is not evaluable from the files read. STOP is the conservative outcome per the briefing, which the owner may overrule after reading the review.

## Branding

Question: where do the start greeting and the bot's visible name come from, and can env or config change them? Method: web-only read of v4.16.0 source via a summarizing fetch tool (excerpts and line numbers approximate).

- Registration: `handlers/registry.py` lines ~127-135 add `CommandHandler("start", private_start_greeting, filters=... & filters.User(user_id=config.allowed_users))`, only when a group id is set. `private_start_greeting` is imported from `.dashboard_command` (line ~32). A separate `CommandSpec("start", new_command)` exists at line ~97 for group use.
- Greeting text: `handlers/dashboard_command.py`, `private_start_greeting`, lines ~81-85. Hard-coded inline string literal: "You're ready to use the dashboard. Run the dashboard command in a bound forum topic and ccgram will send its private dashboard button here." It names "ccgram". It does not come from a constant, `config` or an env var.
- Bot visible name: not defined in the files read; no name setting found. Name, about and description are BotFather fields on the bot itself (see docs/telegram-branding.md). Not verified: main.py, bootstrap.py and the group-topic `new_command` handler text were not read, so other user-facing strings naming ccgram may exist.
- Conclusion: greeting is hard-coded; changing it needs a source patch (private fork) or acceptance.
