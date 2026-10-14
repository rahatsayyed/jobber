#!/usr/bin/env bash
# Jobber — run the hunt (headless / cron-friendly).
# Loads .env (keys) and, if present, .env.ccr (Grok via claude-code-router).
# Usage: ./run-hunt.sh ["custom prompt"]   (default prompt: "run the hunt")
set -euo pipefail
cd "$(dirname "$0")"

# If using the CCR/Grok path, make sure the local gateway is up.
if [ -f .env.ccr ]; then
  if ! nc -z 127.0.0.1 3456 2>/dev/null; then
    ./node_modules/.bin/ccr start >/dev/null 2>&1 || true
    sleep 4
  fi
fi

# Restricted run profile "hunt": env files are parsed by the launcher, not sourced here.
exec bash scripts/run-claude.sh hunt "${1:-run the hunt}"
