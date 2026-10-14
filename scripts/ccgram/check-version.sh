#!/usr/bin/env bash
# Refuse to continue unless the installed ccgram version equals the pinned one.
# Exits non-zero on any mismatch or when ccgram is not installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PIN="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/config/ccgram.pin.json" | head -n 1)"
if [ -z "$PIN" ]; then
  echo "Cannot read the pinned version from config/ccgram.pin.json" >&2
  exit 1
fi
if ! command -v ccgram >/dev/null 2>&1; then
  echo "ccgram is not installed (pinned version $PIN). Install exactly that version, then retry." >&2
  exit 1
fi
INSTALLED="$(ccgram --version 2>&1 | head -n 1)"
if [ "$INSTALLED" != "$PIN" ]; then
  echo "ccgram version mismatch: pinned '$PIN', installed '$INSTALLED'. Refusing to run." >&2
  exit 1
fi
