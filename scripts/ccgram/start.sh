#!/usr/bin/env bash
# Start the ccgram Telegram bridge in its own tmux session, from this project.
# The bridge runs inside .ccgram/ (state only). Its credentials come from the single
# project .env through run.sh, which passes ccgram only the two keys it needs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CCGRAM_HOME="$ROOT/.ccgram"
SESSION="${CCGRAM_DAEMON_SESSION:-ccgram-daemon}"

if [[ ! "$SESSION" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Invalid tmux session name (allowed: letters, digits, _ and -)." >&2
  exit 1
fi

if [ ! -f "$ROOT/.env" ]; then
  echo "Missing $ROOT/.env. Copy .env.example and fill in TELEGRAM_BOT_TOKEN and ALLOWED_USERS." >&2
  exit 1
fi

bash "$ROOT/scripts/ccgram/check-version.sh"

chmod 600 "$ROOT/.env"
mkdir -p "$CCGRAM_HOME"
chmod 700 "$CCGRAM_HOME"

if tmux has-session -t "=$SESSION" >/dev/null 2>&1; then
  echo "ccgram is already running in tmux session $SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" -c "$CCGRAM_HOME" bash "$ROOT/scripts/ccgram/run.sh"
echo "Started ccgram in tmux session $SESSION"
