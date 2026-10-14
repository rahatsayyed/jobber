#!/usr/bin/env bash
# Launch Claude Code for a window created by ccgram.
# Loads the project env line by line (plain parsing, nothing in it is ever executed)
# so MCP servers get their credentials, and never skips permissions.
# The Telegram bridge keys are NOT exported into the Claude process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    line="${line#export }"
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      continue
    fi
    k="${line%%=*}"
    v="${line#*=}"
    case "$k" in
      TELEGRAM_BOT_TOKEN|ALLOWED_USERS) continue ;;
    esac
    if [[ "$v" =~ ^\"(.*)\"$ ]]; then
      v="${BASH_REMATCH[1]}"
    elif [[ "$v" =~ ^\'(.*)\'$ ]]; then
      v="${BASH_REMATCH[1]}"
    fi
    export "$k=$v"
  done < "$ENV_FILE"
fi
exec claude "$@"
