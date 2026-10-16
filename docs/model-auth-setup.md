# Model auth & running Claude Code for Jobber

## How Claude Code chooses the model

- **Normal Claude Code:** you run `/login` (Anthropic OAuth) or set `ANTHROPIC_API_KEY`, and it
  uses Anthropic's own models.
- **What Jobber does:** Claude Code speaks the **Anthropic Messages format**, so it can route to
  any compatible endpoint via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`. This skips interactive
  `/login`. You'll see a warning — _"claude.ai connectors are disabled because an auth source is
  set"_ — that's expected; it means Claude Code is using our env, not your claude.ai login.
- **Do not run `/login`** when using env-based third-party auth — it conflicts.

## The env vars

| Var                              | Meaning                                    |
| -------------------------------- | ------------------------------------------ |
| `ANTHROPIC_BASE_URL`             | the endpoint Claude Code sends requests to |
| `ANTHROPIC_AUTH_TOKEN`           | the API key sent as the auth header        |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | main working model (most calls)            |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL`  | small/fast subtasks                        |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`   | heaviest tasks                             |

Set all three tier vars so whatever tier Claude Code invokes resolves to a real model.

Claude Code does **not** auto-read `.env` — load it into the shell first (this also passes the
keys to the MCP servers Claude Code spawns, since they inherit its environment):

```bash
cd ~/jobber
set -a && source .env && set +a
```

---

## Provider A — Grok / xAI via `claude-code-router` (what we're using now)

**xAI's raw API rejects Claude Code's request format directly** ("Invalid message role") even
though it accepts clean Anthropic-format requests from curl — so pointing
`ANTHROPIC_BASE_URL` straight at `https://api.x.ai` does **not** work. Confirmed working path:
run **`claude-code-router` (CCR) v2** as a tiny local proxy that translates Claude Code's
requests into xAI's format.

Two files are involved:

**`~/.claude-code-router/config.json`** (CCR's provider config — fixed location, cannot be
moved into the project; no env var or CLI flag overrides it in v2):

```json
{
  "LOG": false,
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "Providers": [
    {
      "name": "xai",
      "api_base_url": "https://api.x.ai/v1/chat/completions",
      "api_key": "xai-...",
      "models": ["grok-4.3"]
    }
  ],
  "Router": {
    "default": "xai,grok-4.3",
    "background": "xai,grok-4.3",
    "think": "xai,grok-4.3",
    "longContext": "xai,grok-4.3",
    "webSearch": "xai,grok-4.3"
  }
}
```

**`jobber/.env.ccr`** (gitignored; tells Claude Code to talk to the local CCR gateway instead
of Anthropic — the `ANTHROPIC_AUTH_TOKEN` here is a placeholder, CCR uses the key from
`config.json` above, not this one):

```
ANTHROPIC_BASE_URL=http://127.0.0.1:3456
ANTHROPIC_AUTH_TOKEN=dummy
ANTHROPIC_DEFAULT_SONNET_MODEL=grok-4.3
ANTHROPIC_DEFAULT_HAIKU_MODEL=grok-4.3
ANTHROPIC_DEFAULT_OPUS_MODEL=grok-4.3
```

**How the routing works:** Claude Code → `127.0.0.1:3456` (CCR, running locally) → CCR looks up
`Router.default` → translates the request to xAI's `chat/completions` format → forwards to
`https://api.x.ai/v1/chat/completions` → translates the reply back to Anthropic format → returns
it to Claude Code. Claude Code never talks to xAI directly.

**Start the gateway once per session** (installed locally as a project dependency, not global —
macOS global npm installs hit permission errors; also CCR v3 became a GUI-only app, so we pinned
`@musistudio/claude-code-router@2` which is the headless CLI version):

```bash
cd ~/jobber
./node_modules/.bin/ccr start      # starts the :3456 gateway in the background
./node_modules/.bin/ccr status     # (may report "Not Running" even when it's fine — a known
                                    #  v2 status-check quirk; verify with: curl -sS
                                    #  http://127.0.0.1:3456/v1/messages ... or just try a claude call)
```

Then load env and run Claude Code as usual (see "Running Claude Code" below).

## Provider B — OpenRouter / DeepSeek (no proxy needed; not yet funded)

OpenRouter _is_ natively Anthropic-compatible for Claude Code — no CCR required. Put this
directly in `.env` (or in `.env.ccr` if you want to keep it as an overridable block — just note
`.env.ccr` no longer implies "start CCR" in that case, since the base URL isn't `127.0.0.1`):

```
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-...
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek/deepseek-v4-flash
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek/deepseek-v4-flash:free
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek/deepseek-v4-pro
```

**Status:** the current OpenRouter key returns `402 Insufficient credits — this account never
purchased credits`. OpenRouter gates _all_ capable models (paid **and** the popular `:free`
variants) behind a one-time ~$5 top-up at https://openrouter.ai/settings/credits. Only tiny,
weak, ungated free models run before that — not reliable enough to drive the MCP agent loop.
Parked until credit is added; Grok/CCR is the working path in the meantime.

---

## Running Claude Code

### Normal use (project tools only)

```bash
cd ~/jobber
set -a && source .env && source .env.ccr && set +a   # or your chosen provider's env
claude --mcp-config ./.mcp.json --strict-mcp-config
```

- `--mcp-config ./.mcp.json` — load _this project's_ MCP servers (every server in
  `.mcp.json`).
- `--strict-mcp-config` — load **only** those, ignoring your global `~/.claude` MCP servers
  (chrome-devtools, gitlab, telegram, etc.) so the tool list stays clean. Good for testing/dry
  runs.

### Headless one-shot (cron / automation)

```bash
./run-hunt.sh
```

`run-hunt.sh` is a shim: it execs `npm run scheduler -- --once --now`, one forced wake. It ignores
arguments (a custom prompt is not accepted) and it no longer sources `.env.ccr` or starts the CCR
gateway. The scheduler launches the restricted launcher (`scripts/run-claude.ts`, profile
`outreach_wake` in `config/run-profiles.json`), which builds the `claude` command, passes an
allowlisted child environment (`env_keys` and `env_prefixes` in that profile), always drops
`ANTHROPIC_API_KEY`, and never uses bypass or skip-permissions. The allowlist does not contain
`ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`, so a wake uses your Claude Code login. Whether the
env-based provider route in this page reaches a scheduler wake is unverified.

### With the Telegram channel

For channels, you generally **want** the global servers available too (the Telegram plugin
itself is a user-level plugin), so drop `--strict-mcp-config` and just add the project's MCP
config alongside the channel:

```bash
cd ~/jobber
set -a && source .env && source .env.ccr && set +a
claude --mcp-config ./.mcp.json --channels plugin:telegram@claude-plugins-official
```

Prerequisite (one-time, interactive): `/plugin install telegram@claude-plugins-official` then
`/telegram:configure <bot-token>` (token from @BotFather; already saved as `TELEGRAM_BOT_TOKEN`
in `.env`). This starts an interactive session that also listens on the Telegram channel — chat
with the bot and it reaches this Claude Code instance with all of Jobber's tools available.

## Switching providers

Keep each provider's config in its own gitignored env file and source the one you want _after_
`.env`:

```bash
set -a && source .env && source .env.ccr && set +a       # Grok via CCR (start ccr first)
# or
set -a && source .env && source .env.openrouter && set +a # OpenRouter direct (no CCR needed)
```

## Security

`.env`, `.env.ccr`, `.env.grok`, and `~/.claude-code-router/config.json` all hold live API keys —
never commit them. Only `.env.example` is tracked in git.
