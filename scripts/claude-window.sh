#!/usr/bin/env bash
# Launch Claude Code for a long-lived WORKER window of the Jobber tmux session (kind "worker" in config/manager-windows.json).
# Usage: scripts/claude-window.sh <window> [claude args]   (e.g. --session-id <uuid>; a positional prompt must come first)
# Differences from scripts/claude-session.sh (which stays as it is for chat and manager):
#   - the environment given to claude is an ALLOWLIST (scripts/window-env.ts, src/platform/windowEnv.ts), not the whole .env;
#   - a per-window --settings file carries only the hooks (kill switch, tamper guard, block-outside-project, settings-guard);
#     the allow list is the top-level permission set from .claude/settings.local.json;
#   - the classifier launch check runs first (live mode, exit 3 when it fails).
# It never skips permissions and never passes the Telegram bridge keys. The messages never echo argument or variable values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd .. && pwd)"

if [ "$#" -lt 1 ]; then
  echo "claude-window: usage: claude-window.sh <window> [claude args]" >&2
  exit 1
fi
WINDOW="$1"
shift
if [[ ! "$WINDOW" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "claude-window: invalid window name" >&2
  exit 1
fi

# Choke point: refuse any request to skip or bypass permissions, or to replace the window's settings.
shopt -s nocasematch
for arg in "$@"; do
  case "$arg" in
    *skip-permissions*|*bypasspermissions*|*dangerously*)
      echo "claude-window: refusing to start Claude with a permission-skipping argument" >&2
      exit 1
      ;;
    --settings|--settings=*|--setting-sources|--setting-sources=*)
      echo "claude-window: refusing to start Claude with its own settings arguments" >&2
      exit 1
      ;;
  esac
done
if [ -n "${IS_SANDBOX:-}" ]; then
  echo "claude-window: refusing to start Claude with IS_SANDBOX set" >&2
  exit 1
fi
while IFS= read -r name; do
  case "$name" in
    *SKIP*|*BYPASS*)
      echo "claude-window: refusing to start Claude with a permission-skipping CLAUDE_CODE_ variable set" >&2
      exit 1
      ;;
  esac
done < <(compgen -v CLAUDE_CODE_ || true)
shopt -u nocasematch

cd "$ROOT"
# The bot token must never reach a Claude window, even when the parent environment carries it.
unset TELEGRAM_BOT_TOKEN

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "claude-window: claude is not installed or not on PATH" >&2
  exit 1
fi

# Window check, classifier launch check (exit 3), settings file and the allowlisted environment (one KEY=value per line).
ENV_LINES="$(npx --no-install tsx scripts/window-env.ts "$WINDOW")"
SETTINGS="$ROOT/.jobber/window-settings/$WINDOW.json"
if [ ! -f "$SETTINGS" ]; then
  echo "claude-window: settings file was not written" >&2
  exit 1
fi

ENV_ARGS=()
while IFS= read -r line; do
  if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
    ENV_ARGS+=("$line")
  fi
done <<< "$ENV_LINES"

# UNVERIFIED against the installed claude: --session-id with an interactive session, and a first positional prompt
# (the sh caller types the startup line instead, see src/platform/windowSession.ts typeStartupLine).
exec env -i ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} "$CLAUDE_BIN" "$@" --settings "$SETTINGS" --setting-sources project,local
