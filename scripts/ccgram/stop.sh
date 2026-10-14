#!/usr/bin/env bash
# Stop the ccgram bridge (its tmux session). Claude windows it created are left running.
set -euo pipefail

SESSION="${CCGRAM_DAEMON_SESSION:-ccgram-daemon}"
if tmux has-session -t "$SESSION" >/dev/null 2>&1; then
  tmux kill-session -t "$SESSION"
  echo "Stopped $SESSION"
else
  echo "$SESSION is not running"
fi
