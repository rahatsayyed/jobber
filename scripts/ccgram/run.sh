#!/usr/bin/env bash
# Runs inside the ccgram tmux window. Reads ONLY the keys ccgram needs from the single
# project .env and starts ccgram with a stripped environment, so the other credentials
# never enter ccgram's process. Values are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
CCGRAM_HOME="$ROOT/.ccgram"

bash "$ROOT/scripts/ccgram/check-version.sh"

get() {
  grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

TOKEN="$(get TELEGRAM_BOT_TOKEN || true)"
USERS="$(get ALLOWED_USERS || true)"
if [ -z "$TOKEN" ] || [ -z "$USERS" ]; then
  echo "TELEGRAM_BOT_TOKEN and ALLOWED_USERS must both be set in $ENV_FILE" >&2
  exit 1
fi

# ccgram loads ./.env from its working directory, so run it from the state dir.
mkdir -p "$CCGRAM_HOME"
chmod 700 "$CCGRAM_HOME"
cd "$CCGRAM_HOME"

exec env -i HOME="$HOME" PATH="$PATH" CCGRAM_DIR="$CCGRAM_HOME" \
  TELEGRAM_BOT_TOKEN="$TOKEN" ALLOWED_USERS="$USERS" \
  CCGRAM_CLAUDE_COMMAND="$ROOT/scripts/ccgram/claude-session.sh" \
  ccgram
