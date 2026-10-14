#!/usr/bin/env bash
# Launch Claude Code for a window created by ccgram.
# Loads the project env so MCP servers get their credentials, keeps the working
# directory the window was created with, and never skips permissions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  set -a
  . "$ROOT/.env"
  set +a
fi
exec claude "$@"
