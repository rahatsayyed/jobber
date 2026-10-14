#!/usr/bin/env bash
# Launch a restricted claude run for a named profile. Never skips permission checks.
# Usage: scripts/run-claude.sh <profile> ["prompt"]
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx tsx scripts/run-claude.ts "$@"
